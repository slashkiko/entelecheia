import { describe, expect, it } from "vitest";
import { ArchiveError, extractSingleFile } from "../src/zip.js";
import { zipOf } from "./zip-fixture.js";

const NAME = "evidence.json";
const BODY = '{"level":"E1"}';

describe("artifact の zip から1つ取り出す", () => {
  it.each([
    ["deflate", 8 as const],
    ["無圧縮", 0 as const],
  ])("%s のファイルを取り出す", (_label, method) => {
    const zip = zipOf([{ name: NAME, content: BODY, method }]);

    expect(extractSingleFile(zip, NAME, 1024).toString("utf8")).toBe(BODY);
  });

  it("後ろにコメントの付いた zip も読む", () => {
    const zip = zipOf([{ name: NAME, content: BODY }]);
    const comment = Buffer.from("a comment");
    zip.writeUInt16LE(comment.length, zip.length - 2);

    expect(extractSingleFile(Buffer.concat([zip, comment]), NAME, 1024).toString("utf8")).toBe(
      BODY,
    );
  });

  it.each([
    ["zip でない", Buffer.from(BODY), "not a zip archive"],
    ["空", Buffer.alloc(0), "not a zip archive"],
    [
      "ファイルが2つある",
      zipOf([
        { name: NAME, content: BODY },
        { name: "other.json", content: "{}" },
      ]),
      "exactly one file",
    ],
    ["名前が違う", zipOf([{ name: "other.json", content: BODY }]), "expected evidence.json"],
    ["暗号化している", zipOf([{ name: NAME, content: BODY, flags: 0x1 }]), "encrypted"],
    [
      "ZIP64 の印がある",
      zipOf([{ name: NAME, content: BODY, override: { uncompressedSize: 0xffffffff } }]),
      "ZIP64",
    ],
    ["CRC が合わない", zipOf([{ name: NAME, content: BODY, override: { crc: 1 } }]), "CRC"],
    [
      "展開した大きさが記録と違う",
      zipOf([{ name: NAME, content: BODY, override: { uncompressedSize: 3 } }]),
      "the archive says 3",
    ],
    [
      "圧縮した大きさが本体を越える",
      zipOf([{ name: NAME, content: BODY, override: { compressedSize: 10_000 } }]),
      "truncated",
    ],
  ])("%s zip は投げる", (_label, zip, message) => {
    expect(() => extractSingleFile(zip, NAME, 1024)).toThrow(ArchiveError);
    expect(() => extractSingleFile(zip, NAME, 1024)).toThrow(message);
  });

  it("記録の大きさが上限を超えれば、展開せずに投げる", () => {
    const zip = zipOf([{ name: NAME, content: "x".repeat(2048) }]);

    expect(() => extractSingleFile(zip, NAME, 1024)).toThrow("larger than 1024 bytes");
  });

  it("記録を小さく偽っても、上限を超えて展開しない", () => {
    // 小さな zip から大きなファイルを作る形。記録の大きさだけを見ると通ってしまう
    const zip = zipOf([
      { name: NAME, content: "x".repeat(1024 * 1024), override: { uncompressedSize: 10 } },
    ]);

    expect(() => extractSingleFile(zip, NAME, 1024)).toThrow("could not inflate");
  });

  /** 正しい zip を作り、`patch` で欄を1つ書き換える */
  function patched(patch: (zip: Buffer, central: number, end: number) => void): Buffer {
    const zip = zipOf([{ name: NAME, content: BODY }]);
    patch(zip, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])), zip.length - 22);
    return zip;
  }

  it.each([
    [
      "中央ディレクトリの位置が末尾より後ろ",
      patched((zip, _central, end) => zip.writeUInt32LE(zip.length, end + 16)),
      "the central directory is missing",
    ],
    [
      "中央ディレクトリの位置に別の記録がある",
      patched((zip, _central, end) => zip.writeUInt32LE(0, end + 16)),
      "the central directory is missing",
    ],
    [
      "ローカルヘッダの位置が末尾より後ろ",
      patched((zip, central) => zip.writeUInt32LE(zip.length, central + 42)),
      "the local file header is missing",
    ],
    [
      "ローカルヘッダの位置に別の記録がある",
      patched((zip, central) => zip.writeUInt32LE(1, central + 42)),
      "the local file header is missing",
    ],
  ])("%s zip は、範囲の外を読まずに投げる", (_label, zip, message) => {
    // 位置を確かめないと Buffer の RangeError になり、壊れた artifact として扱えない
    expect(() => extractSingleFile(zip, NAME, 1024)).toThrow(ArchiveError);
    expect(() => extractSingleFile(zip, NAME, 1024)).toThrow(message);
  });

  it("未対応の圧縮方式は投げる", () => {
    const zip = zipOf([{ name: NAME, content: BODY, method: 0 }]);
    // 中央ディレクトリの method を 12（bzip2）に書き換える
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(12, central + 10);

    expect(() => extractSingleFile(zip, NAME, 1024)).toThrow("unsupported compression method 12");
  });
});
