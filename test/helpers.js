'use strict';

/**
 * 解析 STORE 模式 ZIP（测试用）：顺序读取本地文件头，
 * 并校验中央目录与结尾记录的基本结构。
 */
function parseZipEntries(buffer) {
  const entries = [];
  let offset = 0;

  while (
    offset + 4 <= buffer.length &&
    buffer.readUInt32LE(offset) === 0x04034b50
  ) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = Buffer.from(
      buffer.subarray(dataStart, dataStart + compressedSize)
    );

    entries.push({
      name,
      data,
      crc32: crc,
      method,
      utf8: (flags & 0x0800) !== 0,
    });
    offset = dataStart + compressedSize;
  }

  if (buffer.readUInt32LE(offset) !== 0x02014b50) {
    throw new Error('缺少中央目录。');
  }
  const eocdOffset = buffer.length - 22;
  if (buffer.readUInt32LE(eocdOffset) !== 0x06054b50) {
    throw new Error('缺少中央目录结束记录。');
  }
  if (buffer.readUInt16LE(eocdOffset + 10) !== entries.length) {
    throw new Error('中央目录条目数与本地条目数不一致。');
  }

  return entries;
}

module.exports = {
  parseZipEntries,
};
