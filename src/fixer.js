'use strict';

const { formatTime } = require('./time');

const DEFAULTS = {
  minDurationMs: 500,
  maxCps: 15,
  minGapMs: 80,
};

function ceilDiv(a, b) {
  return Math.ceil(a / b);
}

function upperBound(sortedNumbers, value) {
  let low = 0;
  let high = sortedNumbers.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedNumbers[middle] <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * 有界单调回归：
 * 最小化 sum((y_i - target_i)^2)，同时满足：
 *   y_0 <= y_1 <= ...
 *   lower_i <= y_i <= upper_i
 *
 * 等权 PAVA（Pool Adjacent Violators Algorithm）。
 * 先在实数域求带上下界的非递减最小二乘解：合并后的块取
 * 目标均值，并裁剪到该块所有盒约束的交集；若相邻块值不再
 * 非递减则继续合并。最后整体向下取整，得到毫秒整数，且
 * 不破坏整数上下界与非递减约束。
 */
function boundedIsotonicRegression(targets, lower, upper) {
  const blocks = [];

  for (let i = 0; i < targets.length; i += 1) {
    let block = {
      start: i,
      end: i,
      sum: targets[i],
      count: 1,
      maxLower: lower[i],
      minUpper: upper[i],
      value: 0,
    };

    if (block.maxLower > block.minUpper) {
      return { error: { start: i, end: i } };
    }
    block.value = clipReal(block.sum / block.count, block.maxLower, block.minUpper);

    while (blocks.length > 0 && blocks[blocks.length - 1].value > block.value) {
      const previous = blocks.pop();
      block = {
        start: previous.start,
        end: block.end,
        sum: previous.sum + block.sum,
        count: previous.count + block.count,
        maxLower: Math.max(previous.maxLower, block.maxLower),
        minUpper: Math.min(previous.minUpper, block.minUpper),
        value: 0,
      };
      if (block.maxLower > block.minUpper) {
        return { error: { start: block.start, end: block.end } };
      }
      block.value = clipReal(
        block.sum / block.count,
        block.maxLower,
        block.minUpper
      );
    }

    blocks.push(block);
  }

  const result = new Array(targets.length);
  for (const block of blocks) {
    const value = Math.floor(block.value);
    for (let i = block.start; i <= block.end; i += 1) {
      result[i] = value;
    }
  }
  return { values: result };
}

function clipReal(value, lower, upper) {
  if (value < lower) return lower;
  if (Number.isFinite(upper) && value > upper) return upper;
  return value;
}

function summarizeCue(cue, requiredDuration) {
  return {
    index: cue.index,
    start: cue.start,
    end: cue.end,
    text: cue.text,
    chars: cue.chars,
    requiredDuration,
    locked: Boolean(cue.locked),
  };
}

/** 冲突段下端边界的文字描述：时间轴起点、某个切点，或锁定锚点的原始开始。 */
function describeLowerBoundary(cue, group, cuts) {
  if (cue.locked) {
    return `锁定字幕第 ${cue.index} 条的原始开始 ${formatTime(cue.start)}`;
  }
  if (group === 0) {
    return '时间轴起点 00:00:00,000';
  }
  return `第 ${group} 个切点 ${formatTime(cuts[group - 1])}`;
}

/** 冲突段上端边界的文字描述：某个切点，或锁定锚点的原始结束。 */
function describeUpperBoundary(cue, group, cuts) {
  if (cue.locked) {
    return `锁定字幕第 ${cue.index} 条的原始结束 ${formatTime(cue.end)}`;
  }
  return `第 ${group + 1} 个切点 ${formatTime(cuts[group])}`;
}

/**
 * 锁定字幕的原始区间覆盖了场景切点：锚点不可移动，直接无解。
 * 所需时间为锁定时长；可用时间为从锚点固定端看、切点内侧可容纳的跨度。
 */
function buildLockedSceneConflict(cue, group, cuts, sceneLower, sceneUpper) {
  const requiredMs = cue.requiredDuration;
  let availableMs;
  if (cue.start < sceneLower && cue.end > sceneUpper) {
    availableMs = sceneUpper - sceneLower;
  } else if (cue.start < sceneLower) {
    availableMs = cue.end - sceneLower;
  } else {
    availableMs = sceneUpper - cue.start;
  }
  const overflowMs = requiredMs - availableMs;

  const crossedCuts = cuts.filter((cut) => cue.start < cut && cut < cue.end);
  const lowerLabel =
    group === 0 ? '时间轴起点 00:00:00,000' : `第 ${group} 个切点 ${formatTime(sceneLower)}`;
  const upperLabel = Number.isFinite(sceneUpper)
    ? `第 ${group + 1} 个切点 ${formatTime(sceneUpper)}`
    : '时间轴终点';

  const reason =
    `锁定字幕第 ${cue.index} 条必须保留原始时间 ` +
    `${formatTime(cue.start)}–${formatTime(cue.end)}（时长 ${requiredMs} ms），` +
    `但该区间覆盖了场景切点 ${crossedCuts.map(formatTime).join('、')}。` +
    '锁定字幕作为双向时间锚点不可移动：' +
    `按其中点归属的区间（${lowerLabel} 至 ${upperLabel}），` +
    `从锚点位置最多可容纳 ${availableMs} ms，少于锁定时长 ${requiredMs} ms，` +
    `超出 ${overflowMs} ms。请调整场景切点位置，或解除该字幕的锁定。`;

  return {
    feasible: false,
    conflict: {
      type: 'locked-scene',
      fromIndex: cue.index,
      toIndex: cue.index,
      reason,
      lockedIndices: [cue.index],
      requiredMs,
      availableMs,
      overflowMs,
      cues: [summarizeCue(cue, cue.requiredDuration)],
    },
  };
}

function findShortestCapacityConflict(transformedLower, transformedUpper) {
  let best = null;

  // 单调栈保存从当前位置回看的“候选最大值”，索引递增、数值严格递减。
  const stack = [];
  for (let q = 0; q < transformedLower.length; q += 1) {
    const lowerValue = transformedLower[q];
    while (stack.length > 0 && stack[stack.length - 1].value <= lowerValue) {
      stack.pop();
    }
    stack.push({ index: q, value: lowerValue });

    const upperValue = transformedUpper[q];
    if (upperValue === Infinity) continue;

    // 数值递减：大于阈值的是前缀；找前缀中最后一个，即第一个不满足项的前一位。
    let low = 0;
    let high = stack.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (stack[middle].value > upperValue) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) {
      const p = stack[low - 1].index;
      if (!best || q - p < best.to - best.from) {
        best = { from: p, to: q };
      }
    }
  }

  return best;
}

function fixSubtitles(inputCues, cuts, inputOptions = {}) {
  const options = { ...DEFAULTS, ...inputOptions };

  const lockedSet = new Set(options.lockedIndices ?? []);
  if (lockedSet.size > 0) {
    const knownIndices = new Set(inputCues.map((cue) => cue.index));
    for (const lockIndex of lockedSet) {
      if (!knownIndices.has(lockIndex)) {
        throw new Error(
          `锁定字幕编号 ${lockIndex} 不存在（共 ${inputCues.length} 条字幕）。`
        );
      }
    }
  }

  const cues = inputCues.map((cue, arrayIndex) => {
    const locked = lockedSet.has(cue.index);
    // 锁定字幕保留原始起止时间：占用区间固定为原始时长，
    // 不参与最短时长/CPS 延长。
    const requiredDuration = locked
      ? cue.duration
      : Math.max(
          cue.duration,
          options.minDurationMs,
          ceilDiv(cue.chars * 1000, options.maxCps)
        );
    return {
      ...cue,
      arrayIndex,
      locked,
      originalDuration: cue.duration,
      requiredDuration,
    };
  });

  const groups = cues.map((cue) =>
    upperBound(cuts, Math.floor((cue.start + cue.end) / 2))
  );

  const count = cues.length;
  const lower = new Array(count);
  const upper = new Array(count);

  for (let i = 0; i < count; i += 1) {
    if (cues[i].locked) {
      // 锁定字幕是双边时间锚点：开始时间的下界与上界都钉死在原始值，
      // 形成单调链上的点约束，随有界单调回归向两侧传播，
      // 而不是先求解再覆盖时间。
      lower[i] = cues[i].start;
      upper[i] = cues[i].start;
    } else {
      const group = groups[i];
      lower[i] = group === 0 ? 0 : cuts[group - 1];
      upper[i] =
        group < cuts.length ? cuts[group] - cues[i].requiredDuration : Infinity;
    }
  }

  // 锁定字幕不可移动，若其原始区间覆盖场景切点则直接无解。
  for (let i = 0; i < count; i += 1) {
    const cue = cues[i];
    if (!cue.locked) continue;
    const group = groups[i];
    const sceneLower = group === 0 ? 0 : cuts[group - 1];
    const sceneUpper = group < cuts.length ? cuts[group] : Infinity;
    if (cue.start < sceneLower || cue.end > sceneUpper) {
      return buildLockedSceneConflict(cue, group, cuts, sceneLower, sceneUpper);
    }
  }

  // o_i 为从第 0 条依次排到第 i 条开始位置的累计偏移。
  const offsets = new Array(count).fill(0);
  for (let i = 1; i < count; i += 1) {
    offsets[i] =
      offsets[i - 1] + cues[i - 1].requiredDuration + options.minGapMs;
  }

  const targets = cues.map((cue, i) => cue.start - offsets[i]);
  const transformedLower = lower.map((value, i) => value - offsets[i]);
  const transformedUpper = upper.map((value, i) =>
    value === Infinity ? Infinity : value - offsets[i]
  );

  const capacityConflict = findShortestCapacityConflict(
    transformedLower,
    transformedUpper
  );

  // 相邻字幕若被切点分到相反侧，顺序约束与切点约束直接冲突。
  let orderConflict = null;
  for (let i = 0; i + 1 < count; i += 1) {
    if (groups[i] > groups[i + 1]) {
      orderConflict = { from: i, to: i + 1 };
      break;
    }
  }

  let conflictLocation = null;
  if (capacityConflict && (!orderConflict ||
    capacityConflict.to - capacityConflict.from <=
      orderConflict.to - orderConflict.from)) {
    conflictLocation = capacityConflict;
  } else if (orderConflict) {
    conflictLocation = orderConflict;
  }

  if (conflictLocation) {
    const p = conflictLocation.from;
    const q = conflictLocation.to;
    const firstGroup = groups[p];
    const lastGroup = groups[q];
    const lockedInSegment = [];
    for (let i = p; i <= q; i += 1) {
      if (cues[i].locked) lockedInSegment.push(cues[i].index);
    }

    let type = 'capacity';
    let reason;
    let metrics = {};

    if (q === p + 1 && firstGroup > lastGroup) {
      type = 'scene-order';
      reason =
        `第 ${cues[p].index} 条字幕的原始中点位于某个切点之后，` +
        `第 ${cues[q].index} 条字幕却必须位于更早的切点之前；` +
        '保持字幕顺序与禁止跨越切点无法同时满足。请人工拆分、删减或改排这两条字幕。';
      if (lockedInSegment.length > 0) {
        reason += `其中第 ${lockedInSegment.join('、')} 条为锁定字幕，起止时间不可调整。`;
      }
    } else {
      const lowerMs = lower[p];
      // 段右端的可用终点：未锁定字幕受切点限制，锁定字幕即其原始结束。
      const upperEndMs = upper[q] + cues[q].requiredDuration;
      const requiredMs =
        offsets[q] - offsets[p] + cues[q].requiredDuration;
      const availableMs = upperEndMs - lowerMs;
      const overflowMs = requiredMs - availableMs;
      const lowerLabel = describeLowerBoundary(cues[p], firstGroup, cuts);
      const upperLabel = describeUpperBoundary(cues[q], lastGroup, cuts);

      if (p === q) {
        reason =
          `第 ${cues[p].index} 条字幕按最短显示时长/每秒字符数至少需要 ${requiredMs} ms，` +
          `但其按原始中点所在区间（${lowerLabel} 至 ${upperLabel}）只有 ${availableMs} ms，` +
          `超出 ${overflowMs} ms。`;
      } else {
        reason =
          `第 ${cues[p].index}–${cues[q].index} 条是造成无解的最短连续字幕段：` +
          `在满足各条最短时长和相邻最小间隔 ${options.minGapMs} ms 后，` +
          `该段的时间联动需求至少为 ${requiredMs} ms，` +
          `但从 ${lowerLabel} 到 ${upperLabel} 的外层可用跨度只有 ${availableMs} ms，` +
          `超出 ${overflowMs} ms。`;
      }

      if (firstGroup !== lastGroup) {
        reason += ' 这组字幕跨越了一个或多个切点，各字幕还必须分别留在切点两侧。';
      }
      if (lockedInSegment.length > 0) {
        reason +=
          ` 冲突涉及的锁定字幕：第 ${lockedInSegment.join('、')} 条，` +
          '其原始起止时间作为锚点不可移动。';
      }

      metrics = {
        requiredMs,
        availableMs,
        overflowMs,
        lowerMs,
        upperMs: upperEndMs,
      };
    }

    return {
      feasible: false,
      conflict: {
        type,
        fromIndex: cues[p].index,
        toIndex: cues[q].index,
        reason,
        lockedIndices: lockedInSegment,
        cues: cues
          .slice(p, q + 1)
          .map((cue) => summarizeCue(cue, cue.requiredDuration)),
        ...metrics,
      },
    };
  }

  const regression = boundedIsotonicRegression(
    targets,
    transformedLower,
    transformedUpper
  );

  if (regression.error) {
    // 正常情况下前置的最短窗口检查已经给出更友好的诊断。
    const { start, end } = regression.error;
    const lockedInSegment = [];
    for (let i = start; i <= end; i += 1) {
      if (cues[i].locked) lockedInSegment.push(cues[i].index);
    }
    return {
      feasible: false,
      conflict: {
        type: 'capacity',
        fromIndex: cues[start].index,
        toIndex: cues[end].index,
        reason: `第 ${cues[start].index}–${cues[end].index} 条字幕的硬约束交集为空。`,
        lockedIndices: lockedInSegment,
        cues: cues
          .slice(start, end + 1)
          .map((cue) => summarizeCue(cue, cue.requiredDuration)),
      },
    };
  }

  const fixed = cues.map((cue, i) => {
    const start = regression.values[i] + offsets[i];
    const end = start + cue.requiredDuration;
    return {
      ...cue,
      start,
      end,
      duration: end - start,
      startShift: start - cue.start,
      endShift: end - cue.end,
      sceneGroup: groups[i],
      requiredDuration: cue.requiredDuration,
    };
  });

  validateResult(fixed, cuts, options);

  return {
    feasible: true,
    cues: fixed,
    stats: buildStats(fixed, options),
  };
}

function validateResult(cues, cuts, options) {
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (!Number.isInteger(cue.start) || !Number.isInteger(cue.end) || cue.end <= cue.start) {
      throw new Error(`内部错误：第 ${cue.index} 条调整结果无效。`);
    }
    if (cue.locked && (cue.startShift !== 0 || cue.endShift !== 0)) {
      throw new Error(`内部错误：第 ${cue.index} 条锁定字幕的起止时间被改动。`);
    }
    if (cue.start < 0) {
      throw new Error(`内部错误：第 ${cue.index} 条早于时间轴起点。`);
    }
    for (const cut of cuts) {
      if (cue.start < cut && cue.end > cut) {
        throw new Error(`内部错误：第 ${cue.index} 条跨越切点 ${formatTime(cut)}。`);
      }
    }
    if (i > 0) {
      const gap = cue.start - cues[i - 1].end;
      if (gap < options.minGapMs) {
        throw new Error(`内部错误：第 ${cues[i - 1].index} 与第 ${cue.index} 条间隔不足。`);
      }
    }
  }
}

function buildStats(cues, options) {
  let moved = 0;
  let extended = 0;
  let locked = 0;
  let totalAbsShift = 0;

  for (const cue of cues) {
    if (cue.locked) locked += 1;
    if (cue.startShift !== 0 || cue.endShift !== 0) moved += 1;
    if (cue.requiredDuration > cue.originalDuration) extended += 1;
    totalAbsShift += Math.abs(cue.startShift) + Math.abs(cue.endShift);
  }

  return {
    total: cues.length,
    moved,
    extended,
    locked,
    totalAbsShift,
    minGapMs: options.minGapMs,
  };
}

module.exports = {
  DEFAULTS,
  fixSubtitles,
};
