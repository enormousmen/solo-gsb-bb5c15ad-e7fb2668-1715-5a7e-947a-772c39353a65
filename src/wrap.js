'use strict';

const LIMITS = {
  minWidth: 2,
  maxWidth: 200,
  minLines: 1,
  maxLines: 10,
};

const DEFAULTS = {
  maxWidth: 40,
  maxLines: 2,
};

/**
 * 显示宽度为 2 的码点区间：中文、日文假名、谚文音节、
 * CJK 标点与全角形式等（East Asian Wide / Fullwidth）。
 */
const WIDE_RANGES = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // CJK 部首、CJK 符号与标点（含 0x3000 全角空格）
  [0x3041, 0x33ff], // 平假名、片假名、CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文音节
  [0xa960, 0xa97f], // 谚文字母扩展 A
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe10, 0xfe19], // 竖排形式
  [0xfe30, 0xfe52], // CJK 兼容形式
  [0xfe54, 0xfe66], // 小型变体
  [0xfe68, 0xfe6b],
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // 表情符号
  [0x1f900, 0x1f9ff], // 补充符号与表情
  [0x20000, 0x2fffd], // CJK 扩展 B 及以后
  [0x30000, 0x3fffd], // CJK 扩展 G/H
];

/** 组合附加符号、ZWJ、变体选择符等不占宽度的码点。 */
const ZERO_WIDTH_PATTERN =
  /[\p{Mn}\p{Mc}\p{Me}\u200d\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/u;

function isWide(codePoint) {
  for (const [lo, hi] of WIDE_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/**
 * 单个字素簇的显示宽度：
 * 组合符/连接符计 0，中文及全角字符计 2，其余可见字符计 1；
 * 簇宽取成员码点宽度的最大值（如 “e + 组合重音符” 仍为 1，
 * ZWJ 连接的表情序列仍为 2）。
 */
function clusterWidth(cluster) {
  let width = 0;
  for (const ch of cluster) {
    if (ZERO_WIDTH_PATTERN.test(ch)) continue;
    width = Math.max(width, isWide(ch.codePointAt(0)) ? 2 : 1);
  }
  return width;
}

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null;

/** 按字素簇切分；无 Intl.Segmenter 时退化为按码点切分。 */
function segmentGraphemes(text) {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** HTML 标签与 ASS 覆盖块：计 0 宽，且作为原子 token 不得从内部断开。 */
const MARKUP_PATTERN = /<[^>]*>|\{[^}]*\}/g;

/**
 * 把一行文本切为 token 序列：
 * - tag / ass：原子标记，宽度 0，其后不允许断行；
 * - space：空白字素簇，宽度按字符规则（全角空格为 2），其后允许断行；
 * - text：普通字素簇，标点（\p{P}）其后允许断行。
 */
function tokenize(line) {
  const tokens = [];
  let cursor = 0;

  const pushGraphemes = (slice) => {
    for (const cluster of segmentGraphemes(slice)) {
      if (/^\s+$/u.test(cluster)) {
        tokens.push({
          kind: 'space',
          text: cluster,
          width: clusterWidth(cluster),
          breakAfter: true,
        });
      } else {
        tokens.push({
          kind: 'text',
          text: cluster,
          width: clusterWidth(cluster),
          breakAfter: /^\p{P}/u.test(cluster),
        });
      }
    }
  };

  for (const match of line.matchAll(MARKUP_PATTERN)) {
    pushGraphemes(line.slice(cursor, match.index));
    const raw = match[0];
    tokens.push({
      kind: raw.startsWith('<') ? 'tag' : 'ass',
      text: raw,
      width: 0,
      breakAfter: false,
    });
    cursor = match.index + raw.length;
  }
  pushGraphemes(line.slice(cursor));
  return tokens;
}

/** 文本的显示宽度：标签与 ASS 覆盖计 0，其余按字素簇规则累计。 */
function measureWidth(text) {
  let width = 0;
  for (const line of String(text).split('\n')) {
    for (const token of tokenize(line)) width += token.width;
  }
  return width;
}

/** 断点序列字典序比较（同分时取更早的断点）。 */
function compareBreaks(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * 支配剪枝：entry 用 (overflow, minW, maxW, lines) 描述部分解。
 * a 支配 b 当且仅当 a 的超限宽度不超、行宽区间被包含（minW 不小、
 * maxW 不大）、行数不超，且断点序列不晚于 b——此时对任意相同的
 * 后续拼接，a 的结果在 (超限宽度, 极差, 断点数, 断点早晚) 四级
 * 字典序下都不劣于 b，b 可安全丢弃。
 */
function dominates(a, b) {
  if (a.overflow > b.overflow) return false;
  if (a.minW < b.minW) return false;
  if (a.maxW > b.maxW) return false;
  if (a.lines > b.lines) return false;
  if (compareBreaks(a.breaks, b.breaks) > 0) return false;
  return (
    a.overflow < b.overflow ||
    a.minW > b.minW ||
    a.maxW < b.maxW ||
    a.lines < b.lines ||
    compareBreaks(a.breaks, b.breaks) < 0
  );
}

function prune(front) {
  const kept = [];
  for (const candidate of front) {
    let dominated = false;
    for (const entry of kept) {
      if (dominates(entry, candidate)) {
        dominated = true;
        break;
      }
    }
    if (dominated) continue;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (dominates(candidate, kept[i])) kept.splice(i, 1);
    }
    kept.push(candidate);
  }
  return kept;
}

/** 最终方案比较：依次最少化超限宽度、行宽极差、断点数，同分取更早断点。 */
function compareFinal(a, b) {
  if (a.overflow !== b.overflow) return a.overflow - b.overflow;
  const rangeA = a.maxW - a.minW;
  const rangeB = b.maxW - b.minW;
  if (rangeA !== rangeB) return rangeA - rangeB;
  if (a.lines !== b.lines) return a.lines - b.lines;
  return compareBreaks(a.breaks, b.breaks);
}

/**
 * 用动态规划为单条字幕文本换行。
 *
 * 原文中的换行是硬断行（必须保留且计入行数）；软断点只能落在
 * 空白或标点之后，HTML 标签与 ASS 覆盖块是原子 token。
 * 软断行会吞掉断点两侧相邻的空白（行尾/行首空白不占宽度也不输出）。
 *
 * 返回 { feasible, overflow, lineCount, softBreaks, lines, wrappedText }：
 * - lines 为 [{ text, width }]，width 是该行显示宽度；
 * - feasible 表示在 maxLines 行内把超限宽度压到了 0；
 * - 原始硬行数已超过 maxLines 时原样返回并标记 feasible=false。
 */
function wrapText(text, maxWidth, maxLines) {
  const hardSegments = String(text).split('\n');
  const tokens = [];
  const after = []; // after[i]：第 i 个 token 之后的边界类型

  for (const segment of hardSegments) {
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

  const n = tokens.length;
  if (n === 0) {
    return {
      feasible: true,
      overflow: 0,
      lineCount: 1,
      softBreaks: 0,
      lines: [{ text: '', width: 0 }],
      wrappedText: '',
    };
  }
  after[n - 1] = 'end';

  // 行宽前缀和；行首/行尾空白不计入显示宽度。
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + tokens[i].width;

  const firstNonSpace = new Array(n + 1);
  firstNonSpace[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    firstNonSpace[i] = tokens[i].kind === 'space' ? firstNonSpace[i + 1] : i;
  }
  const lastNonSpace = new Array(n + 1).fill(-1);
  for (let j = 1; j <= n; j += 1) {
    lastNonSpace[j] = tokens[j - 1].kind === 'space' ? lastNonSpace[j - 1] : j - 1;
  }

  const lineWidth = (i, j) => {
    const lo = firstNonSpace[i];
    const hi = lastNonSpace[j];
    if (lo > hi) return 0;
    return prefix[hi + 1] - prefix[lo];
  };

  // hardLimit[j]：j 之前（不含 j）最近的硬断行位置，无则 0；
  // 行 [i, j) 不得跨越硬断行，即 i 不得小于该位置。
  const hardLimit = new Array(n + 1).fill(0);
  for (let j = 2; j <= n; j += 1) {
    hardLimit[j] = after[j - 2] === 'hard' ? j - 1 : hardLimit[j - 1];
  }

  // dp[j]：前 j 个 token（以行边界结尾）的帕累托前沿。
  const dp = Array.from({ length: n + 1 }, () => []);
  dp[0].push({ overflow: 0, minW: Infinity, maxW: -Infinity, lines: 0, breaks: [] });

  for (let j = 1; j <= n; j += 1) {
    const boundary = j === n ? 'end' : after[j - 1];
    if (boundary === 'none') continue;
    const isSoft = boundary === 'soft';
    for (let i = hardLimit[j]; i < j; i += 1) {
      if (i > 0 && after[i - 1] === 'none') continue;
      if (dp[i].length === 0) continue;
      const width = lineWidth(i, j);
      const over = Math.max(0, width - maxWidth);
      for (const entry of dp[i]) {
        const lines = entry.lines + 1;
        if (lines > maxLines) continue;
        dp[j].push({
          overflow: entry.overflow + over,
          minW: Math.min(entry.minW, width),
          maxW: Math.max(entry.maxW, width),
          lines,
          breaks: isSoft ? [...entry.breaks, j] : entry.breaks,
        });
      }
    }
    dp[j] = prune(dp[j]);
  }

  // 行数上限连原始硬行都容纳不下：原样返回并标记失败。
  if (dp[n].length === 0) {
    const lines = [];
    let start = 0;
    for (let j = 1; j <= n; j += 1) {
      if (j !== n && after[j - 1] !== 'hard') continue;
      lines.push({
        text: tokens.slice(start, j).map((t) => t.text).join(''),
        width: lineWidth(start, j),
      });
      start = j;
    }
    const overflow = lines.reduce(
      (sum, line) => sum + Math.max(0, line.width - maxWidth),
      0
    );
    return {
      feasible: false,
      reason: 'tooManyHardLines',
      overflow,
      lineCount: lines.length,
      softBreaks: 0,
      lines,
      wrappedText: lines.map((line) => line.text).join('\n'),
    };
  }

  let best = dp[n][0];
  for (const entry of dp[n]) {
    if (compareFinal(entry, best) < 0) best = entry;
  }

  // 按选中的软断点 + 全部硬断点切分，重建各行文本。
  const softSet = new Set(best.breaks);
  const lines = [];
  let start = 0;
  for (let j = 1; j <= n; j += 1) {
    const isBoundary = j === n || after[j - 1] === 'hard' || softSet.has(j);
    if (!isBoundary) continue;
    let lo = start;
    let hi = j;
    // 软断行吞掉断点两侧相邻的空白；硬断行保留原文。
    if (start > 0 && softSet.has(start)) {
      while (lo < hi && tokens[lo].kind === 'space') lo += 1;
    }
    if (j < n && softSet.has(j)) {
      while (hi > lo && tokens[hi - 1].kind === 'space') hi -= 1;
    }
    lines.push({
      text: tokens.slice(lo, hi).map((t) => t.text).join(''),
      width: lineWidth(start, j),
    });
    start = j;
  }

  return {
    feasible: best.overflow === 0,
    overflow: best.overflow,
    lineCount: lines.length,
    softBreaks: best.breaks.length,
    lines,
    wrappedText: lines.map((line) => line.text).join('\n'),
  };
}

/**
 * 为整组字幕换行。返回每条字幕的换行前后文本、逐行宽度与
 * 是否达标；任一字幕在行数上限内无法消除超限时 feasible=false。
 */
function wrapCues(cues, { maxWidth, maxLines }) {
  const results = cues.map((cue) => {
    const wrapped = wrapText(cue.text, maxWidth, maxLines);
    return {
      index: cue.index,
      start: cue.start,
      end: cue.end,
      originalText: cue.text,
      wrappedText: wrapped.wrappedText,
      lines: wrapped.lines,
      lineCount: wrapped.lineCount,
      overflow: wrapped.overflow,
      feasible: wrapped.feasible,
      reason: wrapped.reason,
      changed: wrapped.wrappedText !== cue.text,
    };
  });

  const failed = results.filter((cue) => !cue.feasible);
  return {
    feasible: failed.length === 0,
    cues: results,
    failedIndices: failed.map((cue) => cue.index),
    stats: {
      total: results.length,
      changed: results.filter((cue) => cue.changed).length,
      failed: failed.length,
    },
  };
}

module.exports = {
  LIMITS,
  DEFAULTS,
  measureWidth,
  tokenize,
  wrapText,
  wrapCues,
};
