'use strict';

/**
 * 极简 ZIP 写入器（仅 STORE 存储模式，无压缩），
 * 用于把分卷 SRT 与 manifest.json 打包下载，避免引入外部依赖。
 * 文件名以 UTF-8 写入并设置通用标志位 11。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP 使用 DOS 日期时间；1980 年之前的日期会被裁剪到 1980-01-01。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * entries: [{ name: string, data: Buffer }]
 * 返回完整 ZIP 文件的 Buffer。
 */
function createZip(entries, date = new Date()) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('ZIP 至少需要一个条目。');
  }

  const { time, day } = dosDateTime(date);
  const chunks = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 标志位：UTF-8 文件名
    local.writeUInt16LE(0, 8); // 压缩方式：STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小（STORE 与原始相同）
    local.writeUInt32LE(data.length, 22); // 原始大小
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    chunks.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // 其余字段（扩展/注释/磁盘号/属性）保持 0
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centralParts.push(central, name);

    offset += 30 + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结束签名
  end.writeUInt16LE(entries.length, 8); // 本磁盘条目数
  end.writeUInt16LE(entries.length, 10); // 条目总数
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16); // 中央目录起始偏移

  return Buffer.concat([...chunks, centralDirectory, end]);
}

module.exports = {
  createZip,
  crc32,
};
