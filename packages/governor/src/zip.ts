import { crc32, inflateRawSync } from "node:zlib";

/**
 * artifact の zip から、決まった名前のファイルを取り出す。
 *
 * Actions の artifact は zip で返る。中身は evidence.json と、それに結びつけたトークンの
 * 2つだけなので、zip の読み手を依存に足さずに、要る分だけをここに書く。governor は書き込み
 * トークンを持つので、依存を少なく保つ。
 *
 * zip は head のコードが差し替えうる入力として読む。中身が `names` と1対1でない、
 * 暗号化や ZIP64 を使う、展開すると上限を超える、CRC が合わない、のどれでも投げる。
 */

export class ArchiveError extends Error {
  override readonly name = "ArchiveError";
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
/** EOCD の固定部の長さ。後ろにコメント（最大 65535 バイト）が付きうる */
const EOCD_LENGTH = 22;
/** 中央ディレクトリの1件の固定部の長さ。後ろに名前・拡張欄・コメントが続く */
const CENTRAL_ENTRY_LENGTH = 46;
const STORED = 0;
const DEFLATED = 8;

/** `names` のファイルをちょうどそれだけ持つ zip から、名前ごとの中身を返す。上限は1つずつにかける */
export function extractFiles(
  archive: Uint8Array,
  names: readonly string[],
  maxBytes: number,
): Map<string, Buffer> {
  const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocd = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  if (count !== names.length) {
    throw new ArchiveError(`expected ${names.length} files in the archive, found ${count}`);
  }
  const files = new Map<string, Buffer>();
  let offset = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    const entry = readCentralEntry(zip, offset);
    offset = entry.next;
    if (!names.includes(entry.name)) {
      throw new ArchiveError(`unexpected ${entry.name} in the archive`);
    }
    if (files.has(entry.name)) {
      // 同じ名前が2つあれば、どちらを読むかで中身が変わる
      throw new ArchiveError(`${entry.name} appears twice in the archive`);
    }
    files.set(entry.name, extract(zip, entry, maxBytes));
  }
  return files;
}

function extract(zip: Buffer, entry: CentralEntry, maxBytes: number): Buffer {
  const { name } = entry;
  if (entry.encrypted) {
    throw new ArchiveError(`${name} is encrypted`);
  }
  // ZIP64 は使わない大きさのファイルしか受け取らない。0xffffffff は「ZIP64 の欄を見よ」の印
  if (entry.uncompressedSize === 0xffffffff || entry.compressedSize === 0xffffffff) {
    throw new ArchiveError("ZIP64 archives are not accepted");
  }
  if (entry.uncompressedSize > maxBytes) {
    throw new ArchiveError(`${name} is larger than ${maxBytes} bytes`);
  }

  const local = entry.localHeaderOffset;
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL_FILE_HEADER) {
    throw new ArchiveError("the local file header is missing");
  }
  // 大きさと CRC は中央ディレクトリのものを使う。ストリームで書いた zip は、ローカルヘッダの
  // 欄を 0 にして後ろの data descriptor に書く。
  const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.length) {
    throw new ArchiveError("the archive is truncated");
  }
  const data = zip.subarray(dataStart, dataEnd);

  let content: Buffer;
  if (entry.method === STORED) {
    content = Buffer.from(data);
  } else if (entry.method === DEFLATED) {
    try {
      // 上限を超えて展開しない。小さな zip から大きなファイルを作られても、ここで止まる
      content = inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch (error) {
      throw new ArchiveError(`could not inflate ${name}: ${String(error)}`);
    }
  } else {
    throw new ArchiveError(`unsupported compression method ${entry.method}`);
  }
  if (content.length !== entry.uncompressedSize) {
    throw new ArchiveError(
      `${name} is ${content.length} bytes, the archive says ${entry.uncompressedSize}`,
    );
  }
  if (crc32(content) !== entry.crc) {
    throw new ArchiveError(`the CRC of ${name} does not match`);
  }
  return content;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const earliest = Math.max(0, zip.length - EOCD_LENGTH - 0xffff);
  for (let offset = zip.length - EOCD_LENGTH; offset >= earliest; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new ArchiveError("not a zip archive");
}

interface CentralEntry {
  name: string;
  method: number;
  encrypted: boolean;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** 中央ディレクトリの次の1件の位置 */
  next: number;
}

function readCentralEntry(zip: Buffer, offset: number): CentralEntry {
  if (
    offset + CENTRAL_ENTRY_LENGTH > zip.length ||
    zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY
  ) {
    throw new ArchiveError("the central directory is missing");
  }
  const nameLength = zip.readUInt16LE(offset + 28);
  const extraLength = zip.readUInt16LE(offset + 30);
  const commentLength = zip.readUInt16LE(offset + 32);
  const nameStart = offset + CENTRAL_ENTRY_LENGTH;
  if (nameStart + nameLength > zip.length) {
    throw new ArchiveError("the archive is truncated");
  }
  return {
    encrypted: (zip.readUInt16LE(offset + 8) & 0x1) !== 0,
    method: zip.readUInt16LE(offset + 10),
    crc: zip.readUInt32LE(offset + 16),
    compressedSize: zip.readUInt32LE(offset + 20),
    uncompressedSize: zip.readUInt32LE(offset + 24),
    localHeaderOffset: zip.readUInt32LE(offset + 42),
    name: zip.toString("utf8", nameStart, nameStart + nameLength),
    next: nameStart + nameLength + extraLength + commentLength,
  };
}
