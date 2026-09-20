'use strict';

const form = document.getElementById('fix-form');
const submitButton = document.getElementById('submit-button');
const formMessage = document.getElementById('form-message');
const resultSection = document.getElementById('result-section');
const resultTitle = document.getElementById('result-title');
const resultSummary = document.getElementById('result-summary');
const resultBody = document.getElementById('result-body');
const conflictBox = document.getElementById('conflict-box');
const downloadButton = document.getElementById('download-button');

let currentFixedSrt = '';

function formatMs(ms) {
  const value = Math.max(0, Math.round(ms));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const milliseconds = value % 1000;

  const hms = [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
  return `${hms},${String(milliseconds).padStart(3, '0')}`;
}

function shiftLabel(ms) {
  if (ms === 0) return '无变化';
  const seconds = ms / 1000;
  const sign = ms > 0 ? '+' : '';
  return `${sign}${seconds.toFixed(3)} 秒`;
}

function setMessage(text, type) {
  formMessage.hidden = false;
  formMessage.textContent = text;
  formMessage.className = `message ${type}`;
}

function clearMessage() {
  formMessage.hidden = true;
  formMessage.textContent = '';
}

function addCell(row, className, text) {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = text;
  row.appendChild(cell);
  return cell;
}

function makeBadge(kind, text) {
  const badge = document.createElement('span');
  badge.className = `badge ${kind}`;
  badge.textContent = text;
  return badge;
}

function renderSuccess(data) {
  resultSection.hidden = false;
  conflictBox.hidden = true;
  conflictBox.replaceChildren();
  downloadButton.hidden = false;
  resultTitle.textContent = '修复完成';

  const stats = data.stats;
  let summary =
    `共 ${stats.total} 条；${stats.moved} 条时间变化，${stats.extended} 条因最短时长/CPS 被延长；` +
    `相邻字幕最小间隔 ${stats.minGapMs} ms。`;
  if (stats.locked > 0) {
    summary += ` ${stats.locked} 条锁定字幕作为锚点保持原始起止时间。`;
  }
  resultSummary.textContent = summary;

  currentFixedSrt = data.fixedSrt;
  renderRows(data.originalCues, data.fixedCues, new Set());
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderConflict(data) {
  resultSection.hidden = false;
  downloadButton.hidden = true;
  resultTitle.textContent = '约束无解';
  resultSummary.textContent =
    '已展示原始字幕；红色行是系统定位出的造成冲突的最短连续字幕段。';
  currentFixedSrt = '';

  const conflict = data.conflict;
  conflictBox.hidden = false;
  conflictBox.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent =
    conflict.fromIndex === conflict.toIndex
      ? `冲突字幕：第 ${conflict.fromIndex} 条`
      : `最短冲突段：第 ${conflict.fromIndex}–${conflict.toIndex} 条`;
  conflictBox.appendChild(heading);

  const reason = document.createElement('p');
  reason.textContent = conflict.reason;
  conflictBox.appendChild(reason);

  if (conflict.requiredMs !== undefined) {
    const meta = document.createElement('p');
    meta.className = 'conflict-meta';
    meta.textContent =
      `最少需要 ${conflict.requiredMs} ms，可用 ${conflict.availableMs} ms，` +
      `超出 ${conflict.overflowMs} ms。`;
    conflictBox.appendChild(meta);
  }

  if (Array.isArray(conflict.lockedIndices) && conflict.lockedIndices.length > 0) {
    const lockedMeta = document.createElement('p');
    lockedMeta.className = 'conflict-meta';
    lockedMeta.textContent =
      `冲突的锁定字幕：第 ${conflict.lockedIndices.join('、')} 条` +
      '（锚点保持原始起止时间，不可移动）。';
    conflictBox.appendChild(lockedMeta);
  }

  const ids = new Set(conflict.cues.map((cue) => cue.index));
  renderRows(data.originalCues, null, ids);
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRows(originalCues, fixedCues, conflictIds) {
  resultBody.replaceChildren();

  originalCues.forEach((original, index) => {
    const fixed = fixedCues ? fixedCues[index] : null;
    const row = document.createElement('tr');
    if (conflictIds.has(original.index)) {
      row.classList.add('conflict-row');
    }
    if (original.locked) {
      row.classList.add('locked-row');
    }

    addCell(row, '', String(original.index));

    addCell(
      row,
      'time-before',
      `${formatMs(original.start)}\n→ ${formatMs(original.end)}`
    ).style.whiteSpace = 'pre-line';

    const afterCell = addCell(row, 'time-after');
    if (fixed) {
      afterCell.textContent = `${formatMs(fixed.start)}\n→ ${formatMs(fixed.end)}`;
      afterCell.style.whiteSpace = 'pre-line';
    } else {
      afterCell.textContent = '—';
    }

    addCell(row, 'cue-text', original.text);
    addCell(row, '', String(original.chars));

    const changeCell = document.createElement('td');
    if (fixed) {
      if (fixed.locked) {
        changeCell.appendChild(makeBadge('locked', '已锁定'));
      } else {
        const moved = fixed.startShift !== 0 || fixed.endShift !== 0;
        changeCell.appendChild(makeBadge(moved ? 'moved' : 'same', moved ? '已调整' : '未变'));

        if (moved) {
          const detail = document.createElement('div');
          detail.className = 'shift';
          detail.textContent =
            `开始 ${shiftLabel(fixed.startShift / 1)}；` +
            `结束 ${shiftLabel(fixed.endShift)}`;
          changeCell.appendChild(detail);
        }
      }
    } else {
      let hasBadge = false;
      if (conflictIds.has(original.index)) {
        changeCell.appendChild(makeBadge('conflict', '冲突'));
        hasBadge = true;
      }
      if (original.locked) {
        changeCell.appendChild(makeBadge('locked', '已锁定'));
        hasBadge = true;
      }
      if (!hasBadge) {
        changeCell.textContent = '—';
      }
    }
    row.appendChild(changeCell);

    resultBody.appendChild(row);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage();

  const fileInput = document.getElementById('subtitle');
  if (!fileInput.files[0]) {
    setMessage('请先选择 SRT 文件。', 'error');
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = '正在分析…';

  try {
    const formData = new FormData(form);
    const response = await fetch('/api/fix', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      if (data.feasible === false) {
        renderConflict(data);
        setMessage('当前约束无解，请查看下方最短冲突段及原因。', 'error');
      } else {
        throw new Error(data.error || '处理失败，请检查文件和参数。');
      }
    } else {
      renderSuccess(data);
      setMessage('修复成功，可预览对照并下载新的 SRT 文件。', 'info');
    }
  } catch (error) {
    resultSection.hidden = true;
    setMessage(error.message, 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '分析并修复时轴';
  }
});

downloadButton.addEventListener('click', () => {
  if (!currentFixedSrt) return;
  const blob = new Blob(['﻿' + currentFixedSrt], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const originalName = document.getElementById('subtitle').files[0]?.name ?? 'fixed.srt';
  link.href = url;
  link.download = originalName.replace(/\.srt$/i, '') + '.fixed.srt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});
