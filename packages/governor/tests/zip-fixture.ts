import { crc32, deflateRawSync } from "node:zlib";

/**
 * テスト用の zip を作る。読み手（`src/zip.ts`）と同じ欄だけを書く。
 *
 * 既定は Actions の artifact と同じく、deflate で、ローカルヘッダの大きさと CRC を 0 にして
 * data descriptor（flag の bit 3）に回す形にする。
 */
export interface ZipEntry {
  name: string;
  content: Buffer | string;
  method?: 0 | 8;
  /** 汎用フラグ。bit 0 は暗号化 */
  flags?: number;
  /** 中央ディレクトリに書く値を差し替える。壊れた zip を作るため */
  override?: { crc?: number; uncompressedSize?: number; compressedSize?: number };
  /** 中央ディレクトリの拡張欄とコメント。次の1件の位置がずれる */
  central?: { extra?: string; comment?: string };
}

export function zipOf(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const content = Buffer.from(entry.content);
    const method = entry.method ?? 8;
    const data = method === 8 ? deflateRawSync(content) : content;
    const name = Buffer.from(entry.name, "utf8");
    const flags = (entry.flags ?? 0) | 0x8;
    const crc = entry.override?.crc ?? crc32(content);
    const compressedSize = entry.override?.compressedSize ?? data.length;
    const uncompressedSize = entry.override?.uncompressedSize ?? content.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);
    locals.push(local, name, data, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    const extra = Buffer.from(entry.central?.extra ?? "");
    const comment = Buffer.from(entry.central?.comment ?? "");
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(comment.length, 32);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra, comment);

    offset += local.length + name.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
