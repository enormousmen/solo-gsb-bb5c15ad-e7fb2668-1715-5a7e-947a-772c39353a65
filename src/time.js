'use strict';

/**
 * 将毫秒格式化为 SRT 时间码：HH:MM:SS,mmm
 */
function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new TypeError(`无效的时间：${ms}`);
  }
  const totalMs = Math.trunc(ms);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;

  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
    .concat(',', String(milliseconds).padStart(3, '0'));
}

/**
 * 解析严格 SRT 时间码。
 * 支持 HH:MM:SS,mmm 与 HH:MM:SS.mmm。
 */
function parseSrtTime(value) {
  const match = String(value).trim().match(
    /^(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})$/
  );
  if (!match) {
    throw new Error(`无法解析时间码：${value}`);
  }
  const [, hours, minutes, seconds, fraction] = match;
  const ms = Number(fraction.padEnd(3, '0'));
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    ms
  );
}

/**
 * 解析用户输入的场景切点，兼容：
 * - 12.5 / 12（秒）
 * - 01:30.500
 * - 00:01:30,500
 */
function parseFlexibleTime(value) {
  const text = String(value).trim();
  if (!text) return null;

  if (text.includes(':')) {
    const parts = text.split(':');
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(`时间格式无效：${text}`);
    }
    const secondsText = parts[parts.length - 1].replace(',', '.');
    const minutesText = parts[parts.length - 2];
    const hoursText = parts.length === 3 ? parts[0] : '0';

    if (!/^\d+(\.\d+)?$/.test(hoursText) ||
        !/^\d+(\.\d+)?$/.test(minutesText) ||
        !/^\d+(\.\d+)?$/.test(secondsText)) {
      throw new Error(`时间格式无效：${text}`);
    }
    if (Number(minutesText) >= 60 || Number(secondsText.split('.')[0]) >= 60) {
      throw new Error(`分钟或秒超出范围：${text}`);
    }
    return Math.round(
      (Number(hoursText) * 3600 + Number(minutesText) * 60 +
        Number(secondsText)) * 1000
    );
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`时间格式无效：${text}`);
  }
  return Math.round(Number(text) * 1000);
}

module.exports = {
  formatTime,
  parseSrtTime,
  parseFlexibleTime,
};
