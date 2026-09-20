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

function renderRows(cues, maxWidth) {
  resultBody.replaceChildren();

  for (const cue of cues) {
    const row = document.createElement('tr');
    if (!cue.feasible) {
      row.classList.add('conflict-row');
    }

    addCell(row, '', String(cue.index));
    addCell(
      row,
      'time-before',
      `${formatMs(cue.start)}\n→ ${formatMs(cue.end)}`
    ).style.whiteSpace = 'pre-line';

    addCell(row, 'cue-text', cue.originalText);

    const afterCell = document.createElement('td');
    const lineList = document.createElement('div');
    lineList.className = 'wrap-lines';
    for (const line of cue.lines) {
      const lineRow = document.createElement('div');
      lineRow.className = 'wrap-line';

      const text = document.createElement('span');
      text.className = 'wrap-text';
      text.textContent = line.text;
      lineRow.appendChild(text);

      const width = document.createElement('span');
      width.className = 'line-width';
      if (line.width > maxWidth) width.classList.add('over');
      width.textContent = `宽 ${line.width}`;
      lineRow.appendChild(width);

      lineList.appendChild(lineRow);
    }
    afterCell.appendChild(lineList);
    row.appendChild(afterCell);

    const statusCell = document.createElement('td');
    if (!cue.feasible) {
      statusCell.appendChild(makeBadge('conflict', '超限'));
    } else if (cue.changed) {
      statusCell.appendChild(makeBadge('moved', '已换行'));
    } else {
      statusCell.appendChild(makeBadge('same', '未变'));
    }
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

  const { options, stats } = data;
  resultSummary.textContent =
    `共 ${stats.total} 条；${stats.changed} 条重新换行；` +
    `每行 ≤ ${options.maxWidth} 单位，≤ ${options.maxLines} 行，全部超限已消除。`;

  renderRows(data.cues, data.options.maxWidth);
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderFailed(data) {
  resultSection.hidden = false;
  downloadButton.hidden = true;
  resultTitle.textContent = '无法导出';
  resultSummary.textContent =
    `共 ${data.stats.total} 条，其中 ${data.stats.failed} 条在 ` +
    `${data.options.maxLines} 行内无法消除超限（每行 ≤ ${data.options.maxWidth} 单位），已拒绝导出。`;

  failedBox.hidden = false;
  failedBox.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = `超限字幕：共 ${data.stats.failed} 条`;
  failedBox.appendChild(heading);

  const failedSet = new Set(data.failedIndices);
  const list = document.createElement('ul');
  list.className = 'oversized-list';
  for (const cue of data.cues) {
    if (!failedSet.has(cue.index)) continue;
    const item = document.createElement('li');
    item.textContent =
      cue.reason === 'tooManyHardLines'
        ? `第 ${cue.index} 条：原有 ${cue.lineCount} 行已超过最多行数 ${data.options.maxLines}`
        : `第 ${cue.index} 条：在 ${data.options.maxLines} 行内最少仍超限 ${cue.overflow} 单位`;
    list.appendChild(item);
  }
  failedBox.appendChild(list);

  renderRows(data.cues, data.options.maxWidth);
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sourceBaseName() {
  const name = document.getElementById('subtitle').files[0]?.name ?? 'subtitles';
  return name.replace(/\.srt$/i, '') || 'subtitles';
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
      if (data.feasible === false && Array.isArray(data.cues)) {
        renderFailed(data);
        setMessage('存在无法在行数内消除超限的字幕，已拒绝导出。', 'error');
      } else {
        throw new Error(data.error || '处理失败，请检查文件和参数。');
      }
    } else {
      renderSuccess(data);
      setMessage('换行方案已生成，可预览逐行宽度并下载新的 SRT。', 'info');
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

downloadButton.addEventListener('click', async () => {
  clearMessage();
  downloadButton.disabled = true;
  downloadButton.textContent = '正在导出…';

  try {
    const formData = new FormData(form);
    const response = await fetch('/api/wrap/download', {
      method: 'POST',
      body: formData,
    });
    const contentType = response.headers.get('content-type') || '';

    if (response.ok && contentType.includes('text/plain')) {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sourceBaseName()}.wrapped.srt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage('换行后的 SRT 已生成并开始下载。', 'info');
    } else {
      const data = await response.json();
      if (data.feasible === false && Array.isArray(data.cues)) {
        renderFailed(data);
      }
      throw new Error(data.error || '导出失败，请重新分析后重试。');
    }
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    downloadButton.disabled = false;
    downloadButton.textContent = '下载换行后的 SRT';
  }
});
