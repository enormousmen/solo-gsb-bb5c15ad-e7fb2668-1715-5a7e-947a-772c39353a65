'use strict';

const form = document.getElementById('split-form');
const submitButton = document.getElementById('split-submit');
const formMessage = document.getElementById('split-message');
const resultSection = document.getElementById('split-result');
const resultTitle = document.getElementById('split-result-title');
const resultSummary = document.getElementById('split-summary');
const resultBody = document.getElementById('split-body');
const oversizedBox = document.getElementById('oversized-box');
const downloadButton = document.getElementById('split-download');

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

function gapLabel(ms) {
  if (ms === null || ms === undefined) return '—';
  return `${(ms / 1000).toFixed(3)} 秒`;
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

function renderPlan(data) {
  resultSection.hidden = false;
  oversizedBox.hidden = true;
  oversizedBox.replaceChildren();
  downloadButton.hidden = false;
  resultTitle.textContent = '分卷方案';

  const options = data.options;
  resultSummary.textContent =
    `共 ${data.volumeCount} 卷；每卷 ≤ ${options.maxMinutes} 分钟、≤ ${options.maxChars} 字；` +
    `边界间隔总和 ${data.totalGapMs} ms。`;

  resultBody.replaceChildren();
  for (const volume of data.volumes) {
    const row = document.createElement('tr');

    const nameCell = addCell(row, '', `第 ${volume.number} 卷`);
    const fileHint = document.createElement('div');
    fileHint.className = 'shift';
    fileHint.textContent = volume.fileName;
    nameCell.appendChild(fileHint);

    addCell(
      row,
      'time-before',
      `${volume.start}\n→ ${volume.end}`
    ).style.whiteSpace = 'pre-line';
    addCell(row, '', String(volume.cueCount));
    addCell(row, '', String(volume.charCount));
    addCell(row, '', gapLabel(volume.gapAfterMs));

    resultBody.appendChild(row);
  }
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderOversized(data) {
  resultSection.hidden = false;
  downloadButton.hidden = true;
  resultTitle.textContent = '无法分卷导出';
  resultSummary.textContent =
    '以下单条字幕自身已超过每卷上限，任何分卷方案都无法容纳，请调整上限或修改字幕后重试。';
  resultBody.replaceChildren();

  oversizedBox.hidden = false;
  oversizedBox.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = `超限字幕：共 ${data.oversizedCues.length} 条`;
  oversizedBox.appendChild(heading);

  const list = document.createElement('ul');
  list.className = 'oversized-list';
  for (const cue of data.oversizedCues) {
    const item = document.createElement('li');
    item.textContent = `第 ${cue.index} 条：${cue.reasons.join('；')}`;
    list.appendChild(item);
  }
  oversizedBox.appendChild(list);
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
    const response = await fetch('/api/split', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      if (data.feasible === false && Array.isArray(data.oversizedCues)) {
        renderOversized(data);
        setMessage('存在自身超限的单条字幕，已拒绝导出。', 'error');
      } else {
        throw new Error(data.error || '处理失败，请检查文件和参数。');
      }
    } else {
      renderPlan(data);
      setMessage('分卷方案已生成，可预览各卷范围并下载 ZIP。', 'info');
    }
  } catch (error) {
    resultSection.hidden = true;
    setMessage(error.message, 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '分析分卷方案';
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
  downloadButton.textContent = '正在打包…';

  try {
    const formData = new FormData(form);
    const response = await fetch('/api/split/download', {
      method: 'POST',
      body: formData,
    });
    const contentType = response.headers.get('content-type') || '';

    if (response.ok && contentType.includes('application/zip')) {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sourceBaseName()}.volumes.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage('ZIP 已生成并开始下载。', 'info');
    } else {
      const data = await response.json();
      if (data.feasible === false && Array.isArray(data.oversizedCues)) {
        renderOversized(data);
      }
      throw new Error(data.error || '打包失败，请重新分析后重试。');
    }
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    downloadButton.disabled = false;
    downloadButton.textContent = '下载 ZIP';
  }
});
