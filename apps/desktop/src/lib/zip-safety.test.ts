import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { assertZipSafety } from "./zip-safety";

function centralDirectoryOffset(bytes: Uint8Array): number {
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(index + 16, true);
    }
  }
  throw new Error("missing end of central directory");
}

describe("ZIP safety preflight", () => {
  const options = { label: "测试归档", maxEntries: 4, maxExpandedBytes: 64 };

  it("accepts a bounded ordinary archive", () => {
    expect(() => assertZipSafety(zipSync({ "index.html": new TextEncoder().encode("<h1>ok</h1>") }), options)).not.toThrow();
  });

  it("rejects an archive whose central directory declares an excessive expansion", () => {
    const bytes = zipSync({ "index.html": new TextEncoder().encode("ok") });
    const offset = centralDirectoryOffset(bytes);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset + 24, 65, true);

    expect(() => assertZipSafety(bytes, options)).toThrow("解压后超过限制");
  });

  it("rejects invalid and multi-disk ZIP metadata before decompression", () => {
    expect(() => assertZipSafety(new Uint8Array([0x50, 0x4b]), options)).toThrow("ZIP 结构无效");
    const bytes = zipSync({ "index.html": new TextEncoder().encode("ok") });
    const eocd = bytes.length - 22;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(eocd + 4, 1, true);

    expect(() => assertZipSafety(bytes, options)).toThrow("不支持 ZIP64、加密或跨盘归档");
  });
});
