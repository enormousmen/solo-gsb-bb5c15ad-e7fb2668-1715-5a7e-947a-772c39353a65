'use strict';

const LIMITS = {
  minWidth: 4,
  maxWidth: 200,
  minLines: 1,
  maxLines: 10,
  maxTokensPerCue: 1000,
};

const DEFAULTS = {
  maxWidth: 40,
  maxLines: 2,
};

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null;

/** 把文本切成字素簇（用户可感知的最小字符单位）；无 Intl.Segmenter 时退化为码点切分。 */
function graphemes(text) {
  if (segmenter) {
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** 中文及全角码位区间（East Asian Wide/Fullwidth 的常用子集）。 */
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首与符号（含 、。《》等）
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名与 CJK 兼容字符
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f000 && cp <= 0x1faff) || // 表情符号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以后
  );
}

/** 字素簇显示宽度：含中文/全角码位计 2，其余计 1。 */
function clusterWidth(cluster) {
  for (const ch of cluster) {
    if (isWideCodePoint(ch.codePointAt(0))) return 2;
  }
  return 1;
}

/** 允许在其后断行的标点：句读、收束类括号与引号、连字符等。 */
const BREAK_AFTER = new Set([
  ...",.;:!?)]}'\"",
  ...'-–—…～',
  ...'、，。；：？！',
  ...'）】》」』’”',
]);

/**
 * 把字幕文本切为词法单元序列：
 * - atom：单个字素簇（可见字符/标点），或 HTML 标签、ASS 覆盖块
 *   （宽度 0，且作为整体不可从内部断开）；
 * - space：连续空白游程（不含换行），断行落在此处时整段被吸收；
 * - newline：原文件已有的换行，作为强制断点保留并计入行数。
 */
function tokenize(text) {
  const tokens = [];
  let pendingSpace = null;

  const flushSpace = () => {
    if (!pendingSpace) return;
    let width = 0;
    for (const cluster of graphemes(pendingSpace.text)) {
      width += clusterWidth(cluster);
    }
    pendingSpace.width = width;
    tokens.push(pendingSpace);
    pendingSpace = null;
  };
  const pushSpace = (chunk) => {
    if (pendingSpace) {
      pendingSpace.text += chunk;
    } else {
      pendingSpace = { kind: 'space', text: chunk, width: 0, punct: false };
    }
  };

  // 先切出标签/覆盖块与纯文本段，再对纯文本段做字素簇切分。
  const tagPattern = /<[^>]*>|\{[^}]*\}/g;
  const parts = [];
  let last = 0;
  for (let match = tagPattern.exec(text); match; match = tagPattern.exec(text)) {
    if (match.index > last) {
      parts.push({ isTag: false, text: text.slice(last, match.index) });
    }
    parts.push({ isTag: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ isTag: false, text: text.slice(last) });

  for (const part of parts) {
    if (part.isTag) {
      flushSpace();
      tokens.push({ kind: 'atom', text: part.text, width: 0, punct: false });
      continue;
    }
    for (const cluster of graphemes(part.text)) {
      if (cluster === '\n') {
        flushSpace();
        tokens.push({ kind: 'newline', text: '\n', width: 0, punct: false });
      } else if (/^\s+$/.test(cluster)) {
        pushSpace(cluster);
      } else {
        flushSpace();
        tokens.push({
          kind: 'atom',
          text: cluster,
          width: clusterWidth(cluster),
          punct: BREAK_AFTER.has(cluster),
        });
      }
    }
  }
  flushSpace();
  return tokens;
}

/** 单条字幕的换行上下文：前缀宽度、行宽与行文本渲染（行首/行尾空白不计宽、不渲染）。 */
function createContext(tokens) {
  const prefix = new Array(tokens.length + 1).fill(0);
  for (let i = 0; i < tokens.length; i += 1) {
    prefix[i + 1] = prefix[i] + tokens[i].width;
  }

  function lineWidth(a, b) {
    let width = prefix[b] - prefix[a];
    if (a < b && tokens[a].kind === 'space') width -= tokens[a].width;
    if (b - 1 > a && tokens[b - 1].kind === 'space') width -= tokens[b - 1].width;
    return width;
  }

  function lineText(a, b) {
    let text = '';
    for (let i = a; i < b; i += 1) text += tokens[i].text;
    return text.replace(/^\s+|\s+$/g, '');
  }

  return { lineWidth, lineText };
}

/** 单行文本的显示宽度（用于预览换行前的各行）。 */
function displayWidth(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0;
  const ctx = createContext(tokens);
  return ctx.lineWidth(0, tokens.length);
}

/** 决策链（断点位置序列）按字典序比较，小者断点更早。 */
function seqCompare(a, b) {
  let x = a;
  let y = b;
  while (x && y) {
    if (x.j !== y.j) return x.j - y.j;
    x = x.next;
    y = y.next;
  }
  if (x) return 1;
  if (y) return -1;
  return 0;
}

/**
 * 前沿剪枝：若状态 Y 的成本不劣于 X（超限不多、最窄行不更窄、最宽行不更宽）
 * 且断点序列不晚于 X，则任何前缀下 Y 的合成结果都不劣于 X，X 可安全丢弃。
 */
function prune(candidates, keyOf) {
  const list = [...candidates.values()];
  const kept = [];
  for (let a = 0; a < list.length; a += 1) {
    const x = list[a];
    let dominated = false;
    for (let b = 0; b < list.length; b += 1) {
      if (a === b) continue;
      const y = list[b];
      if (
        y.o <= x.o &&
        y.mn >= x.mn &&
        y.mx <= x.mx &&
        seqCompare(y.node, x.node) <= 0
      ) {
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push(x);
  }
  const out = new Map();
  for (const state of kept) out.set(keyOf(state.o, state.mn, state.mx), state);
  return out;
}

/**
 * 动态规划求解单条字幕的最佳断点序列。
 *
 * dp[i][k] 是 tokens[i..] 用恰好 k 行排版的 Pareto 前沿，元素为
 * { o, mn, mx, node }：o 为总超限宽度，mn/mx 为最窄/最宽行宽，
 * node 为断点决策链（用于同分取更早断点）。
 *
 * 行末只能落在：空白游程后、句读标点后、强制换行处或文本末尾；
 * 行不得跨越强制换行。目标字典序：超限宽度 → 行宽极差 → 行数 → 更早断点。
 */
function solve(tokens, ctx, maxWidth, maxLines) {
  const T = tokens.length;

  // nextNewline[i]：下标 ≥ i 的第一个强制换行位置，没有则为 T。
  const nextNewline = new Array(T + 1);
  nextNewline[T] = T;
  let seen = T;
  for (let i = T - 1; i >= 0; i -= 1) {
    if (tokens[i].kind === 'newline') seen = i;
    nextNewline[i] = seen;
  }

  // 宽度与超限都不超过总宽度（≤ 2 × maxTokensPerCue），用整数键去重。
  const keyOf = (o, mn, mx) => (o * 4200 + mn) * 4200 + mx;

  const dp = Array.from({ length: T + 1 }, () => Array(maxLines + 1).fill(null));
  dp[T][0] = new Map([[-1, { o: 0, mn: Infinity, mx: -Infinity, node: null }]]);

  for (let k = 1; k <= maxLines; k += 1) {
    for (let i = T - 1; i >= 0; i -= 1) {
      if (tokens[i].kind === 'newline') continue; // 行不会从强制换行符开始
      const limit = nextNewline[i];
      const candidates = new Map();

      for (let j = i + 1; j <= limit; j += 1) {
        const atNewline = j < T && tokens[j].kind === 'newline';
        if (j !== T && !atNewline) {
          const prev = tokens[j - 1];
          const legal = prev.kind === 'space' || (prev.kind === 'atom' && prev.punct);
          if (!legal) continue;
        }
        const width = ctx.lineWidth(i, j);
        const overflow = Math.max(0, width - maxWidth);
        const suffix = dp[atNewline ? j + 1 : j][k - 1];
        if (!suffix) continue;

        for (const state of suffix.values()) {
          const o = overflow + state.o;
          const mn = Math.min(width, state.mn);
          const mx = Math.max(width, state.mx);
          const node = { j, next: state.node };
          const key = keyOf(o, mn, mx);
          const existing = candidates.get(key);
          if (!existing || seqCompare(node, existing.node) < 0) {
            candidates.set(key, { o, mn, mx, node });
          }
        }
      }
      dp[i][k] = prune(candidates, keyOf);
    }
  }

  let best = null;
  for (let k = 1; k <= maxLines; k += 1) {
    const states = dp[0][k];
    if (!states) continue;
    for (const state of states.values()) {
      const candidate = { ...state, lines: k, range: state.mx - state.mn };
      if (
        !best ||
        candidate.o < best.o ||
        (candidate.o === best.o && candidate.range < best.range) ||
        (candidate.o === best.o &&
          candidate.range === best.range &&
          candidate.lines < best.lines) ||
        (candidate.o === best.o &&
          candidate.range === best.range &&
          candidate.lines === best.lines &&
          seqCompare(candidate.node, best.node) < 0)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * 换行单条字幕文本。返回换行前后各行（含行宽）、目标函数值与可行性：
 * feasible = 在最多行数内消除了全部超限。
 */
function wrapCueText(text, maxWidth, maxLines) {
  const tokens = tokenize(text);
  if (tokens.length > LIMITS.maxTokensPerCue) {
    throw new Error(
      `单条字幕过长（${tokens.length} 个字素簇，上限 ${LIMITS.maxTokensPerCue}），无法智能换行。`
    );
  }
  const ctx = createContext(tokens);
  const originalLines = text.split('\n').map((line) => ({
    text: line,
    width: displayWidth(line),
  }));

  const best = solve(tokens, ctx, maxWidth, maxLines);

  if (!best) {
    // 既有换行（强制断点）自身已超过最多行数：保留原文，按原行统计超限。
    const lines = [];
    let start = 0;
    for (let i = 0; i <= tokens.length; i += 1) {
      if (i === tokens.length || tokens[i].kind === 'newline') {
        lines.push({ text: ctx.lineText(start, i), width: ctx.lineWidth(start, i) });
        start = i + 1;
      }
    }
    const overflow = lines.reduce((sum, line) => sum + Math.max(0, line.width - maxWidth), 0);
    const widths = lines.map((line) => line.width);
    return {
      originalLines,
      lines,
      text,
      overflow,
      range: widths.length > 0 ? Math.max(...widths) - Math.min(...widths) : 0,
      breaks: 0,
      lineCount: lines.length,
      changed: false,
      feasible: false,
    };
  }

  const lines = [];
  let node = best.node;
  let start = 0;
  while (node) {
    lines.push({ text: ctx.lineText(start, node.j), width: ctx.lineWidth(start, node.j) });
    start = node.j < tokens.length && tokens[node.j].kind === 'newline' ? node.j + 1 : node.j;
    node = node.next;
  }

  const newText = lines.map((line) => line.text).join('\n');
  const forcedBreaks = tokens.filter((token) => token.kind === 'newline').length;

  return {
    originalLines,
    lines,
    text: newText,
    overflow: best.o,
    range: best.range,
    breaks: lines.length - 1 - forcedBreaks,
    lineCount: lines.length,
    changed: newText !== text,
    feasible: best.o === 0,
  };
}

/**
 * 批量换行。返回每条字幕的换行前后对照、失败清单（无法在行数内消除超限）
 * 以及文本已替换的 wrappedCues（编号、时轴与样式标记保持不变）。
 */
function wrapCues(cues, { maxWidth, maxLines }) {
  const results = [];
  const wrappedCues = [];

  for (const cue of cues) {
    let wrapped;
    try {
      wrapped = wrapCueText(cue.text, maxWidth, maxLines);
    } catch (error) {
      throw new Error(`第 ${cue.index} 条字幕：${error.message}`);
    }
    const { text, ...rest } = wrapped;
    results.push({
      index: cue.index,
      start: cue.start,
      end: cue.end,
      ...rest,
    });
    wrappedCues.push({ ...cue, text });
  }

  const failedCues = results
    .filter((result) => !result.feasible)
    .map((result) => ({
      index: result.index,
      overflow: result.overflow,
      lineCount: result.lineCount,
      reason:
        result.lineCount > maxLines
          ? `既有换行已达 ${result.lineCount} 行，超过最多行数 ${maxLines}` +
            (result.overflow > 0 ? `，且仍超限 ${result.overflow}` : '')
          : `在最多 ${maxLines} 行内仍超限 ${result.overflow}（行宽超过每行最大宽度 ${maxWidth}）`,
    }));

  return {
    feasible: failedCues.length === 0,
    results,
    failedCues,
    wrappedCues,
    stats: {
      total: cues.length,
      changed: results.filter((result) => result.changed).length,
      failed: failedCues.length,
    },
  };
}

module.exports = {
  LIMITS,
  DEFAULTS,
  BREAK_AFTER,
  clusterWidth,
  tokenize,
  displayWidth,
  wrapCueText,
  wrapCues,
};
