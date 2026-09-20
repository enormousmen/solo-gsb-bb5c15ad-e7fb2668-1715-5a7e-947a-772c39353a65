'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');

const { parseSrt, serializeSrt, serializeSrtWithBom } = require('./src/srt');
const { parseFlexibleTime } = require('./src/time');
const { DEFAULTS, fixSubtitles } = require('./src/fixer');
const {
  LIMITS: SPLIT_LIMITS,
  DEFAULTS: SPLIT_DEFAULTS,
  planVolumes,
  summarizeVolume,
  volumeFileName,
  sanitizeBaseName,
  serializeVolume,
  buildManifest,
} = require('./src/split');
const {
  LIMITS: WRAP_LIMITS,
  DEFAULTS: WRAP_DEFAULTS,
  wrapCues,
} = require('./src/wrap');
const { createZip } = require('./src/zip');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
});

app.use(express.static(path.join(__dirname, 'public')));

function parseNumberField(value, name, { min, max, integer = false, fallback }) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的数字。`);
  }
  if (integer && !Number.isInteger(number)) {
    throw new Error(`${name} 必须是整数。`);
  }
  return number;
}

function parseCuts(text) {
  const pieces = String(text ?? '')
    .split(/[\n,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const cuts = pieces.map(parseFlexibleTime);
  const uniqueSorted = [...new Set(cuts)].sort((a, b) => a - b);

  if (uniqueSorted.some((cut) => cut <= 0)) {
    throw new Error('场景切点必须大于 0。');
  }
  if (uniqueSorted.length > 1000) {
    throw new Error('场景切点最多为 1000 个。');
  }
  return uniqueSorted;
}

/**
 * 解析锁定字幕编号：从 1 开始的正整数，
 * 可用换行、空格、逗号、分号或顿号分隔，重复编号自动去重。
 */
function parseLocks(text, cueCount) {
  const pieces = String(text ?? '')
    .split(/[\s,;，；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const seen = new Set();
  const indices = [];
  for (const piece of pieces) {
    if (!/^\d+$/.test(piece)) {
      throw new Error(
        `锁定字幕编号无效：${piece}（应为正整数，多个编号用逗号、空格或换行分隔）。`
      );
    }
    const value = Number(piece);
    if (value < 1 || value > cueCount) {
      throw new Error(`锁定字幕编号 ${value} 超出范围（共 ${cueCount} 条字幕）。`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      indices.push(value);
    }
  }
  return indices.sort((a, b) => a - b);
}

app.post('/api/fix', upload.single('subtitle'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请先上传 .srt 字幕文件。' });
    }

    const minDurationSeconds = parseNumberField(
      req.body.minDurationSeconds,
      '最短显示时长',
      { min: 0.05, max: 60, fallback: DEFAULTS.minDurationMs / 1000 }
    );
    const maxCps = parseNumberField(
      req.body.maxCps,
      '最大每秒字符数',
      { min: 1, max: 100, fallback: DEFAULTS.maxCps }
    );
    const minGapMs = parseNumberField(
      req.body.minGapMs,
      '最小间隔',
      { min: 0, max: 10000, integer: true, fallback: DEFAULTS.minGapMs }
    );
    const cuts = parseCuts(req.body.cuts);

    const content = req.file.buffer.toString('utf8');
    const originalCues = parseSrt(content);
    const lockedIndices = parseLocks(req.body.locks, originalCues.length);
    const result = fixSubtitles(originalCues, cuts, {
      minDurationMs: Math.round(minDurationSeconds * 1000),
      maxCps,
      minGapMs,
      lockedIndices,
    });

    const lockedSet = new Set(lockedIndices);
    const annotatedOriginalCues = originalCues.map((cue) => ({
      ...cue,
      locked: lockedSet.has(cue.index),
    }));

    if (!result.feasible) {
      return res.status(422).json({
        feasible: false,
        cuts,
        options: { minDurationSeconds, maxCps, minGapMs },
        lockedIndices,
        originalCues: annotatedOriginalCues,
        conflict: result.conflict,
      });
    }

    return res.json({
      feasible: true,
      cuts,
      options: { minDurationSeconds, maxCps, minGapMs },
      lockedIndices,
      originalCues: annotatedOriginalCues,
      fixedCues: result.cues,
      fixedSrt: serializeSrt(result.cues),
      stats: result.stats,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/** busboy 按 latin1 解码文件名，这里还原为 UTF-8（纯 ASCII 不受影响）。 */
function originalFileName(file) {
  const raw = String(file.originalname || '');
  const restored = Buffer.from(raw, 'latin1').toString('utf8');
  return restored || 'subtitles.srt';
}

/**
 * 字幕分卷导出：预览（JSON）与下载（ZIP）共用同一套校验与规划。
 * download=false 返回每卷原始范围/字幕数/字符数；
 * download=true 返回打包好的 ZIP（卷内时间回零 + manifest.json）。
 */
function handleSplitRequest(req, res, { download }) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请先上传 .srt 字幕文件。' });
    }

    const maxMinutes = parseNumberField(
      req.body.maxMinutes,
      '每卷最长分钟数',
      {
        min: SPLIT_LIMITS.minMinutes,
        max: SPLIT_LIMITS.maxMinutes,
        fallback: SPLIT_DEFAULTS.maxMinutes,
      }
    );
    const maxChars = parseNumberField(
      req.body.maxChars,
      '每卷最多字符数',
      {
        min: SPLIT_LIMITS.minChars,
        max: SPLIT_LIMITS.maxChars,
        integer: true,
        fallback: SPLIT_DEFAULTS.maxChars,
      }
    );
    const maxDurationMs = Math.round(maxMinutes * 60_000);

    const content = req.file.buffer.toString('utf8');
    const cues = parseSrt(content);
    const plan = planVolumes(cues, { maxDurationMs, maxChars });

    const options = { maxMinutes, maxChars, maxDurationMs };
    const sourceName = originalFileName(req.file);

    if (!plan.feasible) {
      return res.status(422).json({
        feasible: false,
        error: `有 ${plan.oversized.length} 条字幕自身超限，无法分卷导出。`,
        options,
        oversizedCues: plan.oversized,
      });
    }

    const baseName = sanitizeBaseName(sourceName);
    const fileNames = plan.volumes.map((volume) =>
      volumeFileName(baseName, volume.number, plan.volumeCount)
    );

    if (download) {
      const entries = plan.volumes.map((volume, i) => ({
        name: fileNames[i],
        data: Buffer.from(serializeVolume(volume), 'utf8'),
      }));
      const manifest = buildManifest({ sourceName, options, plan, fileNames });
      entries.push({
        name: 'manifest.json',
        data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      });

      const zip = createZip(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="volumes.zip"; filename*=UTF-8''${encodeURIComponent(`${baseName}.volumes.zip`)}`
      );
      return res.send(zip);
    }

    return res.json({
      feasible: true,
      sourceName,
      options,
      volumeCount: plan.volumeCount,
      totalGapMs: plan.totalGapMs,
      volumes: plan.volumes.map((volume, i) =>
        summarizeVolume(volume, fileNames[i])
      ),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
}

app.post('/api/split', upload.single('subtitle'), (req, res) =>
  handleSplitRequest(req, res, { download: false })
);

app.post('/api/split/download', upload.single('subtitle'), (req, res) =>
  handleSplitRequest(req, res, { download: true })
);

/**
 * 字幕智能换行：预览（JSON）与下载（SRT）共用同一套校验与求解。
 * download=false 返回每条字幕换行前后的文本与逐行宽度；
 * download=true 返回保留编号、时轴与样式标记的新 SRT。
 * 任一字幕在行数上限内无法消除超限时返回 422 并拒绝导出。
 */
function handleWrapRequest(req, res, { download }) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请先上传 .srt 字幕文件。' });
    }

    const maxWidth = parseNumberField(req.body.maxWidth, '每行最大显示宽度', {
      min: WRAP_LIMITS.minWidth,
      max: WRAP_LIMITS.maxWidth,
      integer: true,
      fallback: WRAP_DEFAULTS.maxWidth,
    });
    const maxLines = parseNumberField(req.body.maxLines, '最多行数', {
      min: WRAP_LIMITS.minLines,
      max: WRAP_LIMITS.maxLines,
      integer: true,
      fallback: WRAP_DEFAULTS.maxLines,
    });

    const content = req.file.buffer.toString('utf8');
    const cues = parseSrt(content);
    const result = wrapCues(cues, { maxWidth, maxLines });
    const options = { maxWidth, maxLines };

    if (!result.feasible) {
      return res.status(422).json({
        feasible: false,
        error: `有 ${result.stats.failed} 条字幕在 ${maxLines} 行内无法消除超限，已拒绝导出。`,
        options,
        cues: result.cues,
        failedIndices: result.failedIndices,
        stats: result.stats,
      });
    }

    if (download) {
      const wrappedCues = cues.map((cue, i) => ({
        ...cue,
        text: result.cues[i].wrappedText,
      }));
      const baseName = sanitizeBaseName(originalFileName(req.file));
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="wrapped.srt"; filename*=UTF-8''${encodeURIComponent(`${baseName}.wrapped.srt`)}`
      );
      return res.send(Buffer.from(serializeSrtWithBom(wrappedCues), 'utf8'));
    }

    return res.json({
      feasible: true,
      options,
      cues: result.cues,
      stats: result.stats,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
}

app.post('/api/wrap', upload.single('subtitle'), (req, res) =>
  handleWrapRequest(req, res, { download: false })
);

app.post('/api/wrap/download', upload.single('subtitle'), (req, res) =>
  handleWrapRequest(req, res, { download: true })
);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SRT 时轴修复工具已启动：http://localhost:${PORT}`);
  });
}

module.exports = app;
