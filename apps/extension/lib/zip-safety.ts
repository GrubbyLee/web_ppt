type ZipSafetyOptions = {
  label: string;
  maxEntries: number;
  maxExpandedBytes: number;
};

const centralDirectorySignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function endOfCentralDirectory(bytes: Uint8Array, view: DataView, label: string): number {
  const firstOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= firstOffset; offset -= 1) {
    if (readU32(view, offset) !== endOfCentralDirectorySignature) continue;
    const commentLength = readU16(view, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  throw new Error(`${label} ZIP 结构无效。`);
}

/**
 * Reject unsafe ZIP metadata before fflate allocates buffers for decompression.
 * Showit package paths are ASCII and do not need ZIP64, encryption, or multi-disk archives.
 */
export function assertZipSafety(bytes: Uint8Array, options: ZipSafetyOptions): void {
  if (bytes.byteLength < 22) throw new Error(`${options.label} ZIP 结构无效。`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = endOfCentralDirectory(bytes, view, options.label);
  const diskNumber = readU16(view, eocdOffset + 4);
  const directoryDisk = readU16(view, eocdOffset + 6);
  const entriesOnDisk = readU16(view, eocdOffset + 8);
  const entries = readU16(view, eocdOffset + 10);
  const directoryBytes = readU32(view, eocdOffset + 12);
  const directoryOffset = readU32(view, eocdOffset + 16);
  if (
    diskNumber !== 0
    || directoryDisk !== 0
    || entriesOnDisk !== entries
    || entries === 0xffff
    || directoryBytes === 0xffffffff
    || directoryOffset === 0xffffffff
  ) {
    throw new Error(`${options.label} 不支持 ZIP64、加密或跨盘归档。`);
  }
  if (entries > options.maxEntries) throw new Error(`${options.label}文件数量超过限制。`);
  const directoryEnd = directoryOffset + directoryBytes;
  if (directoryEnd > eocdOffset || directoryEnd < directoryOffset) throw new Error(`${options.label} ZIP 目录无效。`);

  const names = new Set<string>();
  const decoder = new TextDecoder();
  let cursor = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > directoryEnd || readU32(view, cursor) !== centralDirectorySignature) throw new Error(`${options.label} ZIP 目录无效。`);
    const flags = readU16(view, cursor + 8);
    const compressedBytes = readU32(view, cursor + 20);
    const uncompressedBytes = readU32(view, cursor + 24);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const commentLength = readU16(view, cursor + 32);
    const entryDisk = readU16(view, cursor + 34);
    const localOffset = readU32(view, cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      flags & 1
      || entryDisk !== 0
      || localOffset === 0xffffffff
      || compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
      || localOffset >= bytes.byteLength
      || next > directoryEnd
    ) {
      throw new Error(`${options.label} 包含不受支持的 ZIP 条目。`);
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (names.has(name)) throw new Error(`${options.label} ZIP 包含重复路径。`);
    names.add(name);
    expandedBytes += uncompressedBytes;
    if (expandedBytes > options.maxExpandedBytes) throw new Error(`${options.label}解压后超过限制。`);
    cursor = next;
  }
  if (cursor !== directoryEnd) throw new Error(`${options.label} ZIP 目录无效。`);
}
