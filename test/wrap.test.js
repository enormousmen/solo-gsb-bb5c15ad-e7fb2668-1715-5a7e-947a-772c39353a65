'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMITS,
  DEFAULTS,
  measureWidth,
  tokenize,
  wrapText,
  wrapCues,
} = require('../src/wrap');
const { parseSrt } = require('../src/srt');

// —— 宽度规则 ——

test('宽度：中文及全角计 2，其他可见字符计 1', () => {
  assert.equal(measureWidth('中'), 2);
  assert.equal(measureWidth('你好世界'), 8);
  assert.equal(measureWidth('abc'), 3);
  assert.equal(measureWidth('ＡＢＣ'), 6); // 全角拉丁
  assert.equal(measureWidth('，。！？'), 8); // 全角标点
  assert.equal(measureWidth('a中b'), 4);
  assert.equal(measureWidth('　'), 2); // 全角空格
});

test('宽度：HTML 标签与 ASS 覆盖块计 0', () => {
  assert.equal(measureWidth('<i>你好</i>'), 4);
  assert.equal(measureWidth('<font color="#ff0000">ab</font>'), 2);
  assert.equal(measureWidth('{\\an8}ab'), 2);
  assert.equal(measureWidth('{\\pos(10,20)}中'), 2);
});

test('宽度：组合符与 ZWJ 序列不额外占宽', () => {
  assert.equal(measureWidth('é'), 1); // e + 组合重音符
  assert.equal(measureWidth('👨‍👩‍👧'), 2); // ZWJ 连接的表情
});

test('tokenize：标签与 ASS 块是原子 token，空白与标点后允许断行', () => {
  const tokens = tokenize('<i>ab</i> cd,ef');
  const tags = tokens.filter((t) => t.kind === 'tag');
  assert.deepEqual(tags.map((t) => t.text), ['<i>', '</i>']);
  assert.ok(tags.every((t) => t.width === 0 && t.breakAfter === false));

  const space = tokens.find((t) => t.kind === 'space');
  assert.equal(space.breakAfter, true);

  const comma = tokens.find((t) => t.text === ',');
  assert.equal(comma.breakAfter, true);

  const letter = tokens.find((t) => t.text === 'a');
  assert.equal(letter.breakAfter, false);
});

// —— 基本换行 ——

test('英文在空白处断行，断点处空白被吞掉', () => {
  const result = wrapText('hello world foo', 5, 3);
  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.lines.map((l) => [l.text, l.width]),
    [
      ['hello', 5],
      ['world', 5],
      ['foo', 3],
    ]
  );
  assert.equal(result.wrappedText, 'hello\nworld\nfoo');
});

test('连续空白只产生一个断点效果，行首行尾不留空白', () => {
  const result = wrapText('hello   world', 5, 2);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.lines.map((l) => l.text), ['hello', 'world']);
});

test('中文在标点后可断，无标点无空白时不可断', () => {
  const ok = wrapText('你好世界，欢迎光临。', 10, 2);
  assert.equal(ok.feasible, true);
  assert.deepEqual(ok.lines.map((l) => l.text), ['你好世界，', '欢迎光临。']);

  const impossible = wrapText('你好世界欢迎', 4, 2);
  assert.equal(impossible.feasible, false);
  assert.equal(impossible.lineCount, 1);
  assert.ok(impossible.overflow > 0);
});

test('标点后断行：英文逗号句号', () => {
  const result = wrapText('Hello,world.', 6, 2);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.lines.map((l) => l.text), ['Hello,', 'world.']);
});

// —— 目标优先级：超限宽度 > 行宽极差 > 断点数 > 更早断点 ——

test('超限宽度优先：宁可多断也要消除超限', () => {
  // 一行放不下；断一次即可零超限。
  const result = wrapText('aaaa bb cc', 5, 3);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.lines.map((l) => l.text), ['aaaa', 'bb cc']);
});

test('行宽极差：优先选择更均衡的断法而非先填满', () => {
  // “aaaa b”(6)/“c”(1) 极差 5；“aaaa”(4)/“b c”(3) 极差 1。
  const result = wrapText('aaaa b c', 6, 2);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.lines.map((l) => l.text), ['aaaa', 'b c']);
});

test('断点数在极差之后：极差更小允许更多断点', () => {
  // 三行 “aa/bb/cc” 极差 0、断点 2；两行极差 3、断点 1。极差优先。
  const result = wrapText('aa bb cc', 5, 3);
  assert.deepEqual(result.lines.map((l) => l.text), ['aa', 'bb', 'cc']);
});

test('单行能放下时不换行（极差 0 最优）', () => {
  const result = wrapText('aa bb', 10, 3);
  assert.equal(result.lineCount, 1);
  assert.equal(result.softBreaks, 0);
  assert.equal(result.wrappedText, 'aa bb');
});

test('同分取更早断点', () => {
  // “aa”(2)/“bb cc”(5) 与 “aa bb”(5)/“cc”(2) 超限、极差、断点数全同。
  const result = wrapText('aa bb cc', 5, 2);
  assert.deepEqual(result.lines.map((l) => l.text), ['aa', 'bb cc']);
});

// —— 标签与硬行 ——

test('标签不从内部断开，样式标记完整保留在输出中', () => {
  const result = wrapText('<i>hello</i> <b>world</b> again', 5, 3);
  assert.equal(result.feasible, true);
  const joined = result.lines.map((l) => l.text).join('');
  assert.ok(joined.includes('<i>') && joined.includes('</i>'));
  assert.ok(joined.includes('<b>') && joined.includes('</b>'));
  assert.deepEqual(result.lines.map((l) => l.text), [
    '<i>hello</i>',
    '<b>world</b>',
    'again',
  ]);
});

test('ASS 覆盖块计 0 宽且保持完整', () => {
  const result = wrapText('{\\an8}hello world', 5, 2);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.lines.map((l) => l.text), ['{\\an8}hello', 'world']);
  assert.deepEqual(result.lines.map((l) => l.width), [5, 5]);
});

test('原有换行作为硬断行保留并计入行数', () => {
  const result = wrapText('aaa bbb\ncc dd', 7, 3);
  assert.equal(result.feasible, true);
  assert.equal(result.lineCount, 2);
  assert.equal(result.wrappedText, 'aaa bbb\ncc dd');

  const rewrapped = wrapText('aaa bbb\ncc dd', 4, 4);
  assert.equal(rewrapped.feasible, true);
  assert.deepEqual(rewrapped.lines.map((l) => l.text), ['aaa', 'bbb', 'cc', 'dd']);
});

test('行数上限内无法消除超限：标记失败并给出最小超限', () => {
  // 4 条硬行才能零超限，最多 3 行时最少超限 1。
  const result = wrapText('aaa bbb\ncc dd', 4, 3);
  assert.equal(result.feasible, false);
  assert.equal(result.overflow, 1);
  assert.equal(result.lineCount, 3);
});

test('原始硬行数超过行数上限：原样返回并标记失败', () => {
  const result = wrapText('a\nb\nc', 10, 2);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'tooManyHardLines');
  assert.equal(result.lineCount, 3);
  assert.equal(result.wrappedText, 'a\nb\nc');
});

// —— wrapCues ——

test('wrapCues：统计与失败编号', () => {
  const cues = parseSrt(
    '1\n00:00:00,000 --> 00:00:02,000\nhello world foo\n\n' +
      '2\n00:00:02,500 --> 00:00:04,000\n短字幕\n\n' +
      '3\n00:00:04,500 --> 00:00:06,000\n无标点中文长句测试\n'
  );
  const result = wrapCues(cues, { maxWidth: 6, maxLines: 3 });

  assert.equal(result.feasible, false);
  assert.equal(result.stats.total, 3);
  assert.equal(result.stats.failed, 1);
  assert.deepEqual(result.failedIndices, [3]);

  const [first, second, third] = result.cues;
  assert.equal(first.changed, true);
  assert.deepEqual(first.lines.map((l) => l.text), ['hello', 'world', 'foo']);
  assert.equal(second.changed, false);
  assert.equal(third.feasible, false);
  assert.ok(third.overflow > 0);
});

// —— 与暴力枚举对照的随机化正确性验证 ——

/** 用与 wrapText 相同的规则重建 token 流与边界类型。 */
function analyze(text) {
  const tokens = [];
  const after = [];
  for (const segment of String(text).split('\n')) {
    const segTokens = tokenize(segment);
    if (segTokens.length === 0) continue;
    if (tokens.length > 0) after[tokens.length - 1] = 'hard';
    for (const token of segTokens) {
      tokens.push(token);
      after.push('none');
    }
    const segmentStart = tokens.length - segTokens.length;
    for (let i = segmentStart; i < tokens.length - 1; i += 1) {
      if (tokens[i].breakAfter) after[i] = 'soft';
    }
  }
  if (tokens.length > 0) after[tokens.length - 1] = 'end';
  return { tokens, after };
}

function lineWidthOf(tokens, i, j) {
  let lo = i;
  let hi = j;
  while (lo < hi && tokens[lo].kind === 'space') lo += 1;
  while (hi > lo && tokens[hi - 1].kind === 'space') hi -= 1;
  let width = 0;
  for (let k = lo; k < hi; k += 1) width += tokens[k].width;
  return width;
}

function compareTuple(a, b) {
  // (超限宽度, 极差, 断点数, 断点序列) 字典序
  if (a.overflow !== b.overflow) return a.overflow - b.overflow;
  if (a.range !== b.range) return a.range - b.range;
  if (a.breaks.length !== b.breaks.length) {
    return a.breaks.length - b.breaks.length;
  }
  for (let i = 0; i < a.breaks.length; i += 1) {
    if (a.breaks[i] !== b.breaks[i]) return a.breaks[i] - b.breaks[i];
  }
  return 0;
}

/** 枚举全部软断点子集，按同一目标取最优。 */
function bruteForceWrap(text, maxWidth, maxLines) {
  const { tokens, after } = analyze(text);
  const n = tokens.length;
  if (n === 0) return { overflow: 0, lines: [''], wrappedText: '' };

  const softPositions = [];
  for (let j = 1; j < n; j += 1) {
    if (after[j - 1] === 'soft') softPositions.push(j);
  }

  let best = null;
  for (let mask = 0; mask < 1 << softPositions.length; mask += 1) {
    const breaks = [];
    for (let k = 0; k < softPositions.length; k += 1) {
      if (mask & (1 << k)) breaks.push(softPositions[k]);
    }
    const boundaries = new Set(breaks);
    for (let j = 1; j <= n; j += 1) {
      if (j === n || after[j - 1] === 'hard') boundaries.add(j);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    if (sorted.length > maxLines) continue;

    let overflow = 0;
    let minW = Infinity;
    let maxW = -Infinity;
    let start = 0;
    const lineTexts = [];
    for (const j of sorted) {
      const width = lineWidthOf(tokens, start, j);
      overflow += Math.max(0, width - maxWidth);
      minW = Math.min(minW, width);
      maxW = Math.max(maxW, width);
      // 重建行文本：软断点吞掉两侧相邻空白
      let lo = start;
      let hi = j;
      if (start > 0 && breaks.includes(start)) {
        while (lo < hi && tokens[lo].kind === 'space') lo += 1;
      }
      if (j < n && breaks.includes(j)) {
        while (hi > lo && tokens[hi - 1].kind === 'space') hi -= 1;
      }
      lineTexts.push(tokens.slice(lo, hi).map((t) => t.text).join(''));
      start = j;
    }

    const candidate = {
      overflow,
      range: maxW - minW,
      breaks,
      wrappedText: lineTexts.join('\n'),
    };
    if (best === null || compareTuple(candidate, best) < 0) best = candidate;
  }
  return best; // null 表示硬行数已超上限
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('随机小规模用例与暴力枚举结果一致', () => {
  const random = lcg(20260920);
  const alphabet = ['a', 'b', '中', '。', '，', ' ', 'c', '<i>', '</i>', '{\\an8}'];

  for (let round = 0; round < 300; round += 1) {
    // 随机拼 1–2 条硬行、每行 1–10 个 token 的文本
    const hardLines = 1 + Math.floor(random() * 2);
    const parts = [];
    for (let line = 0; line < hardLines; line += 1) {
      const count = 1 + Math.floor(random() * 9);
      const pieces = [];
      for (let k = 0; k < count; k += 1) {
        pieces.push(alphabet[Math.floor(random() * alphabet.length)]);
      }
      parts.push(pieces.join(''));
    }
    const text = parts.join('\n');
    const maxWidth = 2 + Math.floor(random() * 8);
    const maxLines = 1 + Math.floor(random() * 4);

    const actual = wrapText(text, maxWidth, maxLines);
    const expected = bruteForceWrap(text, maxWidth, maxLines);

    if (expected === null) {
      assert.equal(
        actual.feasible,
        false,
        `第 ${round} 轮应失败：${JSON.stringify(text)}`
      );
      continue;
    }

    assert.equal(
      actual.overflow,
      expected.overflow,
      `第 ${round} 轮超限宽度不一致：${JSON.stringify(text)} w=${maxWidth} L=${maxLines}`
    );
    assert.equal(
      actual.feasible,
      expected.overflow === 0,
      `第 ${round} 轮可行性不一致：${JSON.stringify(text)}`
    );
    assert.equal(
      actual.wrappedText,
      expected.wrappedText,
      `第 ${round} 轮换行结果不一致：${JSON.stringify(text)} w=${maxWidth} L=${maxLines}`
    );
  }
});

test('参数边界常量合理', () => {
  assert.ok(LIMITS.minWidth >= 1);
  assert.ok(DEFAULTS.maxWidth >= LIMITS.minWidth && DEFAULTS.maxWidth <= LIMITS.maxWidth);
  assert.ok(DEFAULTS.maxLines >= LIMITS.minLines && DEFAULTS.maxLines <= LIMITS.maxLines);
});
