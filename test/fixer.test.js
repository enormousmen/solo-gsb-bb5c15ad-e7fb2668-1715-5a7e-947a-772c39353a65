'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fixSubtitles, DEFAULTS } = require('../src/fixer');
const { parseSrt, serializeSrt, visibleLength } = require('../src/srt');
const { parseFlexibleTime } = require('../src/time');

function cue(index, start, end, text) {
  return {
    index,
    sequence: index,
    start,
    end,
    duration: end - start,
    text,
    chars: visibleLength(text),
  };
}

test('延长字幕以满足最短显示时长和 CPS', () => {
  const result = fixSubtitles(
    [cue(1, 0, 300, '你好')],
    [],
    { minDurationMs: 500, maxCps: 4, minGapMs: 80 }
  );

  assert.equal(result.feasible, true);
  assert.equal(result.cues[0].start, 0);
  assert.ok(result.cues[0].duration >= 500);
});

test('联动后移后续字幕并保持最小间隔', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 100, 'aaaaaaaaaa'),
      cue(2, 150, 300, 'bbbbbbbbbb'),
    ],
    [2500],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100 }
  );

  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.cues.map((item) => [item.start, item.end]),
    [[0, 1000], [1100, 2100]]
  );
});

test('切点两侧字幕不会覆盖切点', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 100, 'a'),
      cue(2, 1100, 1200, 'b'),
    ],
    [1000],
    { minDurationMs: 500, maxCps: 100, minGapMs: 100 }
  );

  assert.equal(result.feasible, true);
  assert.ok(result.cues[0].end <= 1000);
  assert.ok(result.cues[1].start >= 1000);
  assert.ok(result.cues[1].start - result.cues[0].end >= 100);
});

test('同一区间容量不足时标出最短连续字幕段', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 100, 'aaaaaaaaaa'),
      cue(2, 150, 300, 'bbbbbbbbbb'),
    ],
    [2000],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100 }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 2);
  assert.equal(result.conflict.requiredMs, 2100);
  assert.equal(result.conflict.availableMs, 2000);
  assert.match(result.conflict.reason, /最短连续字幕段/);
});

test('单条字幕比切点区间更长时只标出该字幕', () => {
  const result = fixSubtitles(
    [cue(1, 200, 300, 'xxxxxxxxxx')],
    [500],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100 }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 1);
});

test('相邻字幕的切点归属顺序颠倒时标出这两条', () => {
  const result = fixSubtitles(
    [
      cue(1, 1200, 1300, 'a'),
      cue(2, 500, 600, 'b'),
    ],
    [1000],
    { minDurationMs: 100, maxCps: 100, minGapMs: 20 }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.type, 'scene-order');
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 2);
});

test('解析和序列化 SRT', () => {
  const cues = parseSrt(
    '1\r\n00:00:01,200 --> 00:00:02,300\r\n<b>Hello</b> world\r\n\r\n' +
    '2\n00:00:03.000 --> 00:00:04,000\n你好\n'
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1200);
  assert.equal(cues[0].chars, 10);
  assert.match(serializeSrt(cues), /00:00:01,200 --> 00:00:02,300/);
});

test('解析多种切点时间格式', () => {
  assert.equal(parseFlexibleTime('12.5'), 12500);
  assert.equal(parseFlexibleTime('01:30.500'), 90500);
  assert.equal(parseFlexibleTime('00:01:30,500'), 90500);
});

test('使用默认参数', () => {
  assert.deepEqual(DEFAULTS, {
    minDurationMs: 500,
    maxCps: 15,
    minGapMs: 80,
  });
});

test('锁定字幕保留原始起止时间，后续字幕绕开锚点联动', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 500, 'aaaaa'),
      cue(2, 1000, 1500, 'bbbbb'),
      cue(3, 1500, 2000, 'cccccccccccccccccccc'),
    ],
    [],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100, lockedIndices: [2] }
  );

  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.cues.map((item) => [item.start, item.end]),
    [[0, 500], [1000, 1500], [1600, 3600]]
  );
  assert.equal(result.cues[1].locked, true);
  assert.equal(result.cues[1].startShift, 0);
  assert.equal(result.cues[1].endShift, 0);
});

test('锁定字幕作为右侧锚点，前序字幕可提前让位', () => {
  const result = fixSubtitles(
    [
      cue(1, 500, 1000, 'aaaaaaaaaa'),
      cue(2, 1500, 2000, 'bbbbb'),
    ],
    [],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100, lockedIndices: [2] }
  );

  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.cues.map((item) => [item.start, item.end]),
    [[400, 1400], [1500, 2000]]
  );
});

test('锁定字幕不参与最短时长与 CPS 延长', () => {
  const result = fixSubtitles(
    [cue(1, 1000, 1300, 'aaaaaaaaaaaaaaaaaaaa')],
    [],
    { minDurationMs: 500, maxCps: 5, minGapMs: 80, lockedIndices: [1] }
  );

  assert.equal(result.feasible, true);
  assert.equal(result.cues[0].start, 1000);
  assert.equal(result.cues[0].end, 1300);
  assert.equal(result.cues[0].requiredDuration, 300);
});

test('两个锁定锚点间距不足时返回包含锚点的最短冲突段', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 1000, 'aaaaa'),
      cue(2, 1050, 2000, 'bbbbb'),
    ],
    [],
    { minDurationMs: 500, maxCps: 100, minGapMs: 100, lockedIndices: [1, 2] }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.type, 'capacity');
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 2);
  assert.deepEqual(result.conflict.lockedIndices, [1, 2]);
  assert.equal(result.conflict.requiredMs, 2050);
  assert.equal(result.conflict.availableMs, 2000);
  assert.equal(result.conflict.overflowMs, 50);
  assert.match(result.conflict.reason, /锁定字幕/);
});

test('锁定锚点与切点之间容量不足时标出相关锚点', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 1000, 'aaaaa'),
      cue(2, 1100, 1600, 'bbbbbbbbbbbbbbbbbbbb'),
    ],
    [3000],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100, lockedIndices: [1] }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 2);
  assert.deepEqual(result.conflict.lockedIndices, [1]);
  assert.equal(result.conflict.requiredMs, 3100);
  assert.equal(result.conflict.availableMs, 3000);
  assert.equal(result.conflict.overflowMs, 100);
  assert.match(result.conflict.reason, /锁定字幕第 1 条/);
  assert.match(result.conflict.reason, /切点/);
});

test('锁定字幕覆盖场景切点时返回 locked-scene 冲突', () => {
  const result = fixSubtitles(
    [cue(1, 500, 1500, 'aaaaa')],
    [1000],
    { minDurationMs: 500, maxCps: 100, minGapMs: 80, lockedIndices: [1] }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.type, 'locked-scene');
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 1);
  assert.deepEqual(result.conflict.lockedIndices, [1]);
  assert.equal(result.conflict.requiredMs, 1000);
  assert.equal(result.conflict.availableMs, 500);
  assert.equal(result.conflict.overflowMs, 500);
  assert.match(result.conflict.reason, /锁定字幕第 1 条/);
  assert.match(result.conflict.reason, /00:00:01,000/);
});

test('锁定不存在的字幕编号时抛出错误', () => {
  assert.throws(
    () => fixSubtitles([cue(1, 0, 100, 'a')], [], { lockedIndices: [2] }),
    /锁定字幕编号 2 不存在/
  );
});

test('统计信息包含锁定字幕数量', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 500, 'aaaaa'),
      cue(2, 1000, 1500, 'bbbbb'),
    ],
    [],
    { minDurationMs: 500, maxCps: 100, minGapMs: 100, lockedIndices: [2] }
  );

  assert.equal(result.feasible, true);
  assert.equal(result.stats.locked, 1);
  assert.equal(result.stats.moved, 0);
});
