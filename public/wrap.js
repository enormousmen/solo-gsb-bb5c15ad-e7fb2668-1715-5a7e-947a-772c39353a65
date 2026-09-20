'use strict';

const form = document.getElementById('wrap-form');
const submitButton = document.getElementById('wrap-submit');
const formMessage = document.getElementById('wrap-message');
const resultSection = document.getElementById('wrap-result');
const resultTitle = document.getElementById('wrap-result-title');
const resultSummary = document.getElementById('wrap-summary');
const resultBody = document.getElementById('wrap-body');
const failedBox = document.getElementById('failed-box');
const downloadButton = document.getElementById('wrap-download');

let currentWrappedSrt = '';

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

/** 逐行渲染文本与行宽；超过每行最大宽度的行用红色标出。 */
function lineList(lines, maxWidth) {
  const list = document.createElement('div');
  list.className = 'line-list';
  for (const line of lines) {
    const item = document.createElement('div');
    item.className = 'line-row';

    const text = document.createElement('span');
    text.className = 'line-text';
    text.textContent = line.text === '' ? '（空行）' : line.text;

    const chip = document.createElement('span');
    chip.className = line.width > maxWidth ? 'width-chip over' : 'width-chip';
    chip.textContent = `宽 ${line.width}`;

    item.appendChild(text);
    item.appendChild(chip);
    list.appendChild(item);
  }
  return list;
}

function renderRows(data) {
  const maxWidth = data.options.maxWidth;
  resultBody.replaceChildren();

  for (const cue of data.results) {
    const row = document.createElement('tr');
    if (!cue.feasible) {
      row.classList.add('failed-row');
    }

    addCell(row, '', String(cue.index));

    addCell(
      row,
      'time-before',
      `${formatMs(cue.start)}\n→ ${formatMs(cue.end)}`
    ).style.whiteSpace = 'pre-line';

    const beforeCell = addCell(row, 'text-col', '');
    beforeCell.appendChild(lineList(cue.originalLines, maxWidth));

    const afterCell = addCell(row, 'text-col', '');
    afterCell.appendChild(lineList(cue.lines, maxWidth));

    const statusCell = document.createElement('td');
    if (!cue.feasible) {
      statusCell.appendChild(makeBadge('conflict', '超限'));
    } else if (cue.changed) {
      statusCell.appendChild(makeBadge('moved', '已换行'));
    } else {
      statusCell.appendChild(makeBadge('same', '未变'));
    }
    const detail = document.createElement('div');
    detail.className = 'shift';
    detail.textContent =
      `${cue.lineCount} 行 · ${cue.breaks} 断点 · 极差 ${cue.range}` +
      (cue.overflow > 0 ? ` · 超限 ${cue.overflow}` : '');
    statusCell.appendChild(detail);
    row.appendChild(statusCell);

    resultBody.appendChild(row);
  }
}

function renderSuccess(data) {
  resultSection.hidden = false;
  failedBox.hidden = true;
  failedBox.replaceChildren();
  downloadButton.hidden = false;
  resultTitle.textContent = '换行完成';

  const { stats, options } = data;
  resultSummary.textContent =
    `共 ${stats.total} 条；${stats.changed} 条重新换行；` +
    `每行宽度 ≤ ${options.maxWidth}，最多 ${options.maxLines} 行。`;

  currentWrappedSrt = data.wrappedSrt;
  renderRows(data);
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderFailed(data) {
  resultSection.hidden = false;
  downloadButton.hidden = true;
  resultTitle.textContent = '无法导出';
  resultSummary.textContent =
    '以下字幕在最多行数内仍无法消除超限，已拒绝导出；请放宽参数或修改字幕后重试。';
  currentWrappedSrt = '';

  failedBox.hidden = false;
  failedBox.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = `超限字幕：共 ${data.failedCues.length} 条`;
  failedBox.appendChild(heading);

  const list = document.createElement('ul');
  list.className = 'oversized-list';
  for (const cue of data.failedCues) {
    const item = document.createElement('li');
    item.textContent = `第 ${cue.index} 条：${cue.reason}`;
    list.appendChild(item);
  }
  failedBox.appendChild(list);

  renderRows(data);
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    const response = await fetch('/api/wrap', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      if (data.feasible === false && Array.isArray(data.failedCues)) {
        renderFailed(data);
        setMessage('存在无法在行数内消除超限的字幕，已拒绝导出。', 'error');
      } else {
        throw new Error(data.error || '处理失败，请检查文件和参数。');
      }
    } else {
      renderSuccess(data);
      setMessage('换行完成，可预览各行宽度并下载新的 SRT 文件。', 'info');
    }
  } catch (error) {
    resultSection.hidden = true;
    setMessage(error.message, 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '分析换行方案';
  }
});

// 参数或文件变化后，旧预览与新条件可能不一致，先隐藏结果要求重新分析。
form.addEventListener('input', () => {
  resultSection.hidden = true;
  downloadButton.hidden = true;
});

downloadButton.addEventListener('click', () => {
  if (!currentWrappedSrt) return;
  const blob = new Blob(['﻿' + currentWrappedSrt], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const originalName = document.getElementById('subtitle').files[0]?.name ?? 'subtitles.srt';
  link.href = url;
  link.download = originalName.replace(/\.srt$/i, '') + '.wrapped.srt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});
