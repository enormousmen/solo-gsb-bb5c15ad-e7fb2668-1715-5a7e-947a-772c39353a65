'use strict';

const { serializeSrtWithBom } = require('./srt');
const { formatTime } = require('./time');

const LIMITS = {
  minMinutes: 1,
  maxMinutes: 30,
  minChars: 100,
  maxChars: 20000,
};

const DEFAULTS = {
  maxMinutes: 25,
  maxChars: 8000,
};

/**
 * 检查单条字幕是否自身超限：任何分卷方案都无法容纳它。
 * 返回 [{ index, durationMs, chars, reasons }]，空数组表示全部可放。
 */
function findOversizedCues(cues, maxDurationMs, maxChars) {
  const oversized = [];
  for (const cue of cues) {
    const reasons = [];
    if (cue.duration > maxDurationMs) {
      reasons.push(
        `单条时长 ${cue.duration} ms 超过每卷时长上限 ${maxDurationMs} ms`
      );
    }
    if (cue.chars > maxChars) {
      reasons.push(`单条字符数 ${cue.chars} 超过每卷字符上限 ${maxChars}`);
    }
    if (reasons.length > 0) {
      oversized.push({
        index: cue.index,
        durationMs: cue.duration,
        chars: cue.chars,
        reasons,
      });
    }
  }
  return oversized;
}

/**
 * 全局动态规划分卷。
 *
 * 一卷是字幕序列中连续的一段，分卷边界只能落在相邻字幕之间；
 * 每卷需同时满足：
 *   卷内时长 = 末条结束 − 首条开始 ≤ maxDurationMs
 *   卷内可见字符总数 ≤ maxChars
 *
 * 在所有满足两项上限的划分中依次优化（字典序目标）：
 *   1. 分卷数最少；
 *   2. 所有边界处的字幕间隔（下一条开始 − 上一条结束）总和最大；
 *   3. 边界序列更早（按边界位置字典序最小）。
 *
 * 实现为自后向前的 DP：dp[i] 是第 i 条（含）到末尾的最优划分。
 * 候选首卷为 [i, j)，其边界序列以 j 开头，因此第三级平局只需
 * 比较首刀位置 j（越小越早），其余后缀由 dp[j] 保证最优，
 * 无需“从头装满”的贪心。
 */
function planVolumes(cues, { maxDurationMs, maxChars }) {
  const oversized = findOversizedCues(cues, maxDurationMs, maxChars);
  if (oversized.length > 0) {
    return { feasible: false, oversized };
  }

  const n = cues.length;
  const prefixChars = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) {
    prefixChars[i + 1] = prefixChars[i] + cues[i].chars;
  }

  // 结束时间非递减时段时长随右端点单调，内层循环可安全提前终止；
  // 异常文件（时间乱序）退化为继续扫描，保证结果仍然正确。
  let endsNonDecreasing = true;
  for (let i = 1; i < n; i += 1) {
    if (cues[i].end < cues[i - 1].end) {
      endsNonDecreasing = false;
      break;
    }
  }

  const dp = new Array(n + 1);
  dp[n] = { volumes: 0, gapSum: 0, next: -1 };

  for (let i = n - 1; i >= 0; i -= 1) {
    let best = null;
    for (let j = i + 1; j <= n; j += 1) {
      const chars = prefixChars[j] - prefixChars[i];
      if (chars > maxChars) break; // 字符数随 j 严格单调，之后只会更差
      const duration = cues[j - 1].end - cues[i].start;
      if (duration > maxDurationMs) {
        if (endsNonDecreasing) break;
        continue;
      }
      const tail = dp[j];
      const candidate = {
        volumes: tail.volumes + 1,
        gapSum: tail.gapSum + (j < n ? cues[j].start - cues[j - 1].end : 0),
        next: j,
      };
      if (isBetterPlan(candidate, best)) {
        best = candidate;
      }
    }
    dp[i] = best; // 单条字幕均已通过超限检查，best 必然存在
  }

  const volumes = [];
  const boundaries = [];
  let cursor = 0;
  while (cursor < n) {
    const next = dp[cursor].next;
    volumes.push(buildVolume(cues, cursor, next, volumes.length + 1));
    if (next < n) boundaries.push(next);
    cursor = next;
  }

  return {
    feasible: true,
    volumes,
    boundaries,
    volumeCount: volumes.length,
    totalGapMs: dp[0].gapSum,
  };
}

function isBetterPlan(candidate, current) {
  if (current === null) return true;
  if (candidate.volumes !== current.volumes) {
    return candidate.volumes < current.volumes;
  }
  if (candidate.gapSum !== current.gapSum) {
    return candidate.gapSum > current.gapSum;
  }
  return candidate.next < current.next;
}

/** 生成一卷：统计原始范围，并把卷内时间统一回零（减去卷首字幕的原始开始）。 */
function buildVolume(cues, from, to, number) {
  const first = cues[from];
  const last = cues[to - 1];
  let charCount = 0;
  const shiftedCues = [];
  for (let i = from; i < to; i += 1) {
    const cue = cues[i];
    charCount += cue.chars;
    shiftedCues.push({
      ...cue,
      start: cue.start - first.start,
      end: cue.end - first.start,
    });
  }
  return {
    number,
    firstCueIndex: first.index,
    lastCueIndex: last.index,
    cueCount: to - from,
    charCount,
    startMs: first.start,
    endMs: last.end,
    durationMs: last.end - first.start,
    gapAfterMs: to < cues.length ? cues[to].start - last.end : null,
    cues: shiftedCues,
  };
}

/** 预览用的一卷摘要（不含字幕内容）。 */
function summarizeVolume(volume, fileName) {
  return {
    number: volume.number,
    fileName,
    firstCueIndex: volume.firstCueIndex,
    lastCueIndex: volume.lastCueIndex,
    cueCount: volume.cueCount,
    charCount: volume.charCount,
    startMs: volume.startMs,
    endMs: volume.endMs,
    start: formatTime(volume.startMs),
    end: formatTime(volume.endMs),
    durationMs: volume.durationMs,
    gapAfterMs: volume.gapAfterMs,
  };
}

/** 卷文件名：<基础名>.part01.srt，编号宽度随总卷数自适应（至少两位）。 */
function volumeFileName(baseName, number, totalVolumes) {
  const width = Math.max(2, String(totalVolumes).length);
  return `${baseName}.part${String(number).padStart(width, '0')}.srt`;
}

/** 清理上传文件名，得到可安全写入 ZIP 的基础名。 */
function sanitizeBaseName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/\.srt$/i, '')
    .replace(/[:*?"<>|\x00-\x1f]/g, '_')
    .trim();
  return cleaned || 'subtitles';
}

/** 卷文件的 SRT 内容：时间已回零，带 BOM 方便 Windows 直接打开。 */
function serializeVolume(volume) {
  return serializeSrtWithBom(volume.cues);
}

/** manifest.json 内容：记录每个卷文件名与原始时间范围。 */
function buildManifest({ sourceName, options, plan, fileNames }) {
  return {
    source: sourceName,
    generatedAt: new Date().toISOString(),
    options: {
      maxMinutes: options.maxMinutes,
      maxChars: options.maxChars,
      maxDurationMs: options.maxDurationMs,
    },
    volumeCount: plan.volumeCount,
    totalGapMs: plan.totalGapMs,
    volumes: plan.volumes.map((volume, i) => ({
      file: fileNames[i],
      cueCount: volume.cueCount,
      charCount: volume.charCount,
      firstCueIndex: volume.firstCueIndex,
      lastCueIndex: volume.lastCueIndex,
      durationMs: volume.durationMs,
      originalRange: {
        startMs: volume.startMs,
        endMs: volume.endMs,
        start: formatTime(volume.startMs),
        end: formatTime(volume.endMs),
      },
    })),
  };
}

module.exports = {
  LIMITS,
  DEFAULTS,
  findOversizedCues,
  planVolumes,
  summarizeVolume,
  volumeFileName,
  sanitizeBaseName,
  serializeVolume,
  buildManifest,
};
