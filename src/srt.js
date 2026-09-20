'use strict';

const { formatTime, parseSrtTime } = require('./time');

const TIMING_PATTERN =
  /^(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})(?:\s.*)?$/;

/**
 * 计算可见字符数：
 * - 删除 HTML/字体标签
 * - 删除 ASS 风格覆盖（如 {\an8}）
 * - 删除所有空白
 * 中日韩文字与拉丁字符均按一个字符计算。
 */
function visibleLength(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+/g, '')
    .length;
}

function parseSrt(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('SRT 内容为空。');
  }

  const normalized = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = normalized
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    throw new Error('未找到任何字幕块。');
  }

  const cues = blocks.map((block, blockIndex) => {
    const lines = block.split('\n').map((line) => line.trimEnd());
    let cursor = 0;

    if (/^\d+$/.test(lines[0]?.trim() ?? '')) {
      cursor = 1;
    }

    const timingLine = lines[cursor];
    const match = timingLine?.match(TIMING_PATTERN);
    if (!match) {
      throw new Error(
        `第 ${blockIndex + 1} 个字幕块缺少有效的时间行，示例：00:00:01,000 --> 00:00:03,000`
      );
    }

    const start = parseSrtTime(match[1]);
    const end = parseSrtTime(match[2]);
    if (start < 0) {
      throw new Error(`第 ${blockIndex + 1} 个字幕块的开始时间不能为负数。`);
    }
    if (end <= start) {
      throw new Error(`第 ${blockIndex + 1} 个字幕块的结束时间必须晚于开始时间。`);
    }

    const textLines = lines.slice(cursor + 1);
    const text = textLines.join('\n').trim();
    if (!text || visibleLength(text) === 0) {
      throw new Error(`第 ${blockIndex + 1} 个字幕块没有可见文本。`);
    }

    return {
      index: blockIndex + 1,
      sequence: blockIndex + 1,
      start,
      end,
      duration: end - start,
      chars: visibleLength(text),
      text,
    };
  });

  return cues;
}

function serializeSrt(cues) {
  return cues
    .map((cue, index) => {
      const start = formatTime(cue.start);
      const end = formatTime(cue.end);
      return `${index + 1}\n${start} --> ${end}\n${cue.text}`;
    })
    .join('\n\n')
    .concat('\n');
}

/** UTF-8 BOM 可提升 Windows 记事本等工具的兼容性。 */
function serializeSrtWithBom(cues) {
  return '﻿' + serializeSrt(cues);
}

module.exports = {
  parseSrt,
  serializeSrt,
  serializeSrtWithBom,
  visibleLength,
};
