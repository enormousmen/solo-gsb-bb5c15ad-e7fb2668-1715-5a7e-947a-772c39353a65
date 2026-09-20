'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findOversizedCues,
  planVolumes,
  serializeVolume,
  sanitizeBaseName,
  volumeFileName,
} = require('../src/split');
const { parseSrt, visibleLength } = require('../src/srt');

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

/** 生成 n 条文本相同的字幕，chars 为每条的可见字符数。 */
function cueSeries(count, timings, text = 'aaaaa') {
  return timings.map(([start, end], i) => cue(i + 1, start, end, text));
}

test('卷数最少优先，同分时取更早的边界序列（而非从头装满）', () => {
  // 两种两卷方案间隔总和都是 0：{1}|{2,3} 与 {1,2}|{3}。
  // 从头装满的贪心会选后者（边界在第 2 条后），DP 应选更早的边界。
  const cues = cueSeries(3, [
    [0, 6000],
    [6000, 10000],
    [10000, 14000],
  ]);
  const plan = planVolumes(cues, { maxDurationMs: 10000, maxChars: 10000 });

  assert.equal(plan.feasible, true);
  assert.equal(plan.volumeCount, 2);
  assert.deepEqual(plan.boundaries, [1]);
  assert.deepEqual(plan.volumes.map((v) => v.cueCount), [1, 2]);
});

test('卷数相同时最大化边界处字幕间隔总和', () => {
  // {1,2}|{3} 的边界间隔是 100ms；{1}|{2,3} 是 4000ms。
  // 从头装满的贪心会把第一卷塞成 {1,2}，DP 必须选间隔更大的方案。
  const cues = cueSeries(3, [
    [0, 4000],
    [8000, 12000],
    [12100, 15000],
  ]);
  const plan = planVolumes(cues, { maxDurationMs: 13000, maxChars: 10000 });

  assert.equal(plan.feasible, true);
  assert.equal(plan.volumeCount, 2);
  assert.deepEqual(plan.boundaries, [1]);
  assert.equal(plan.totalGapMs, 4000);
  assert.deepEqual(plan.volumes.map((v) => v.cueCount), [1, 2]);
});

test('边界间隔总和跨多个边界累计', () => {
  const cues = cueSeries(5, [
    [0, 1000],
    [5000, 6000],
    [6100, 7000],
    [12000, 13000],
    [13100, 14000],
  ]);
  // 任两条相邻字幕的跨度都超过 1500ms，只能每条一卷。
  const plan = planVolumes(cues, { maxDurationMs: 1500, maxChars: 10000 });

  assert.equal(plan.volumeCount, 5);
  assert.equal(plan.totalGapMs, 4000 + 100 + 5000 + 100);
});

test('字符上限单独触发分卷', () => {
  const timings = Array.from({ length: 5 }, (_, i) => [i * 1000, i * 1000 + 900]);
  const cues = cueSeries(5, timings, 'a'.repeat(60));
  const plan = planVolumes(cues, { maxDurationMs: 600000, maxChars: 100 });

  assert.equal(plan.volumeCount, 5);
  assert.ok(plan.volumes.every((v) => v.cueCount === 1 && v.charCount === 60));
});

test('时长与字符两项上限同时生效', () => {
  // 字符上限允许每卷 3 条（90 字），时长上限只允许 2 条（2500ms）。
  const timings = Array.from({ length: 6 }, (_, i) => [i * 1000, i * 1000 + 900]);
  const cues = cueSeries(6, timings, 'a'.repeat(30));
  const plan = planVolumes(cues, { maxDurationMs: 2500, maxChars: 90 });

  assert.equal(plan.volumeCount, 3);
  assert.deepEqual(plan.volumes.map((v) => v.cueCount), [2, 2, 2]);
});

test('多个候选边界序列同分时整体取字典序最早', () => {
  // 6 条等长连续字幕，两卷方案可在第 2/3/4 条后切，间隔都是 0。
  const timings = Array.from({ length: 6 }, (_, i) => [i * 1000, i * 1000 + 1000]);
  const cues = cueSeries(6, timings);
  const plan = planVolumes(cues, { maxDurationMs: 4000, maxChars: 10000 });

  assert.equal(plan.volumeCount, 2);
  assert.deepEqual(plan.boundaries, [2]);
  assert.deepEqual(plan.volumes.map((v) => v.cueCount), [2, 4]);
});

test('分卷完整覆盖字幕且边界只落在相邻字幕之间', () => {
  const timings = Array.from({ length: 9 }, (_, i) => [i * 1200, i * 1200 + 1000]);
  const cues = cueSeries(9, timings, 'a'.repeat(40));
  const plan = planVolumes(cues, { maxDurationMs: 3600, maxChars: 100 });

  assert.equal(plan.feasible, true);
  assert.equal(plan.volumes[0].firstCueIndex, 1);
  assert.equal(plan.volumes[plan.volumes.length - 1].lastCueIndex, 9);
  const totalCues = plan.volumes.reduce((sum, v) => sum + v.cueCount, 0);
  assert.equal(totalCues, 9);
  for (let i = 1; i < plan.volumes.length; i += 1) {
    assert.equal(
      plan.volumes[i].firstCueIndex,
      plan.volumes[i - 1].lastCueIndex + 1
    );
  }
  for (const volume of plan.volumes) {
    assert.ok(volume.durationMs <= 3600);
    assert.ok(volume.charCount <= 100);
  }
});

test('单条字幕时长超限：列出编号与原因并拒绝', () => {
  const cues = cueSeries(2, [
    [0, 5000],
    [6000, 7000],
  ]);
  const plan = planVolumes(cues, { maxDurationMs: 4000, maxChars: 1000 });

  assert.equal(plan.feasible, false);
  assert.equal(plan.oversized.length, 1);
  assert.equal(plan.oversized[0].index, 1);
  assert.match(plan.oversized[0].reasons.join(''), /时长/);
});

test('单条字幕字符超限：列出编号与原因并拒绝', () => {
  const cues = [
    cue(1, 0, 1000, 'a'.repeat(150)),
    cue(2, 2000, 3000, 'b'.repeat(10)),
  ];
  const plan = planVolumes(cues, { maxDurationMs: 60000, maxChars: 100 });

  assert.equal(plan.feasible, false);
  assert.deepEqual(plan.oversized.map((o) => o.index), [1]);
  assert.match(plan.oversized[0].reasons.join(''), /字符/);
});

test('findOversizedCues 同时报告时长与字符两种原因', () => {
  const cues = [cue(3, 0, 90000, 'a'.repeat(500))];
  const oversized = findOversizedCues(cues, 60000, 100);

  assert.equal(oversized.length, 1);
  assert.equal(oversized[0].index, 3);
  assert.equal(oversized[0].reasons.length, 2);
});

test('卷内时间统一回零', () => {
  const cues = cueSeries(3, [
    [5000, 6000],
    [6100, 7000],
    [7200, 8200],
  ]);
  const plan = planVolumes(cues, { maxDurationMs: 1500, maxChars: 1000 });

  assert.equal(plan.volumeCount, 3);
  for (const volume of plan.volumes) {
    assert.equal(volume.cues[0].start, 0);
    assert.ok(volume.cues.every((c) => c.start >= 0 && c.end > c.start));
  }

  const srt = serializeVolume(plan.volumes[1]);
  assert.match(srt, /^﻿1\n00:00:00,000 --> 00:00:00,900/);
});

test('复用 parseSrt 的解析与可见字符统计', () => {
  const cues = parseSrt(
    '1\n00:00:00,000 --> 00:00:02,000\n<b>你好</b>世界\n\n' +
    '2\n00:00:02,100 --> 00:00:04,000\n{\\an8}abcd\n'
  );
  const plan = planVolumes(cues, { maxDurationMs: 60000, maxChars: 100 });

  assert.equal(plan.feasible, true);
  assert.equal(plan.volumeCount, 1);
  assert.equal(plan.volumes[0].charCount, 4 + 4);
});

test('卷文件名编号宽度随总卷数自适应', () => {
  assert.equal(volumeFileName('movie', 1, 3), 'movie.part01.srt');
  assert.equal(volumeFileName('movie', 12, 105), 'movie.part012.srt');
});

test('基础名清理非法字符并兜底', () => {
  assert.equal(sanitizeBaseName('a/b\\c:d*e?srt.srt'), 'a_b_c_d_e_srt');
  assert.equal(sanitizeBaseName('电影.srt'), '电影');
  assert.equal(sanitizeBaseName(''), 'subtitles');
  assert.equal(sanitizeBaseName('.srt'), 'subtitles');
});

// —— 与暴力枚举对照的随机化正确性验证 ——

function lexLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/** 枚举全部 2^(n-1) 种边界组合，按同一字典序目标取最优。 */
function bruteForceBest(cues, maxDurationMs, maxChars) {
  const n = cues.length;
  let best = null;

  for (let mask = 0; mask < 1 << (n - 1); mask += 1) {
    const boundaries = [];
    for (let k = 1; k < n; k += 1) {
      if (mask & (1 << (k - 1))) boundaries.push(k);
    }

    let feasible = true;
    let segmentStart = 0;
    for (const end of [...boundaries, n]) {
      let chars = 0;
      for (let i = segmentStart; i < end; i += 1) chars += cues[i].chars;
      const duration = cues[end - 1].end - cues[segmentStart].start;
      if (chars > maxChars || duration > maxDurationMs) {
        feasible = false;
        break;
      }
      segmentStart = end;
    }
    if (!feasible) continue;

    let gapSum = 0;
    for (const b of boundaries) gapSum += cues[b].start - cues[b - 1].end;
    const candidate = { volumes: boundaries.length + 1, gapSum, boundaries };

    if (
      best === null ||
      candidate.volumes < best.volumes ||
      (candidate.volumes === best.volumes && candidate.gapSum > best.gapSum) ||
      (candidate.volumes === best.volumes &&
        candidate.gapSum === best.gapSum &&
        lexLess(candidate.boundaries, best.boundaries))
    ) {
      best = candidate;
    }
  }
  return best;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('随机小规模用例与暴力枚举结果一致', () => {
  const random = lcg(20260919);

  for (let round = 0; round < 200; round += 1) {
    const n = 2 + Math.floor(random() * 8); // 2–9 条
    const maxDurationMs = 1500 + Math.floor(random() * 3000);
    const maxChars = 30 + Math.floor(random() * 90);

    const cues = [];
    let cursor = 0;
    for (let i = 0; i < n; i += 1) {
      const duration = 200 + Math.floor(random() * (maxDurationMs - 400));
      const gap = Math.floor(random() * 600);
      const chars = 1 + Math.floor(random() * Math.min(maxChars, 40));
      cues.push({
        index: i + 1,
        start: cursor + gap,
        end: cursor + gap + duration,
        duration,
        chars,
        text: 'x'.repeat(chars),
      });
      cursor += gap + duration;
    }

    const plan = planVolumes(cues, { maxDurationMs, maxChars });
    const expected = bruteForceBest(cues, maxDurationMs, maxChars);

    assert.equal(plan.feasible, true, `第 ${round} 轮应有解`);
    assert.ok(expected, `第 ${round} 轮暴力解存在`);
    assert.equal(
      plan.volumeCount,
      expected.volumes,
      `第 ${round} 卷数不一致`
    );
    assert.equal(
      plan.totalGapMs,
      expected.gapSum,
      `第 ${round} 间隔总和不一致`
    );
    assert.deepEqual(
      plan.boundaries,
      expected.boundaries,
      `第 ${round} 边界序列不一致`
    );
  }
});
