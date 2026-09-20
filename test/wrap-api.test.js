'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

const SAMPLE_SRT =
  '1\n00:00:00,000 --> 00:00:02,000\nhello world foo\n\n' +
  '2\n00:00:02,500 --> 00:00:04,000\n短字幕\n\n' +
  '3\n00:00:04,500 --> 00:00:06,000\n<i>保持</i> {\\an8}样式\n';

let server;
let port;

test.before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function postWrap(fields, srt, { path = '/api/wrap', fileName = 'sample.srt' } = {}) {
  const form = new FormData();
  if (srt !== null) {
    form.append('subtitle', new Blob([srt], { type: 'text/plain' }), fileName);
  }
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    body: form,
  });
  return response;
}

test('换行预览：返回逐行宽度与换行前后文本', async () => {
  const response = await postWrap({ maxWidth: '6', maxLines: '3' }, SAMPLE_SRT);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.feasible, true);
  assert.deepEqual(data.options, { maxWidth: 6, maxLines: 3 });
  assert.equal(data.stats.total, 3);
  assert.equal(data.stats.failed, 0);

  const [first, second, third] = data.cues;
  assert.equal(first.index, 1);
  assert.equal(first.originalText, 'hello world foo');
  assert.equal(first.wrappedText, 'hello\nworld\nfoo');
  assert.deepEqual(
    first.lines.map((l) => [l.text, l.width]),
    [
      ['hello', 5],
      ['world', 5],
      ['foo', 3],
    ]
  );
  assert.equal(first.changed, true);
  assert.equal(first.feasible, true);

  // “短字幕”宽 6，刚好不超限，保持未变。
  assert.equal(second.changed, false);
  assert.equal(second.wrappedText, '短字幕');

  // 标签与 ASS 覆盖块计 0 宽、保持完整；可见宽 7 超 6，在空白处断行。
  assert.equal(third.changed, true);
  assert.deepEqual(
    third.lines.map((l) => [l.text, l.width]),
    [
      ['<i>保持</i>', 4],
      ['{\\an8}样式', 4],
    ]
  );
});

test('行数内无法消除超限：422 并标出字幕', async () => {
  const response = await postWrap({ maxWidth: '4', maxLines: '1' }, SAMPLE_SRT);
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.feasible, false);
  assert.match(data.error, /拒绝导出/);
  assert.deepEqual(data.failedIndices, [1, 2, 3]);
  assert.equal(data.stats.failed, 3);

  const first = data.cues[0];
  assert.equal(first.feasible, false);
  assert.ok(first.overflow > 0);
  // 预览仍给出最小超限的换行结果。
  assert.ok(Array.isArray(first.lines));
});

test('下载：保留编号、时轴与样式标记的新 SRT', async () => {
  const response = await postWrap(
    { maxWidth: '6', maxLines: '3' },
    SAMPLE_SRT,
    { path: '/api/wrap/download' }
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  const disposition = response.headers.get('content-disposition');
  assert.match(disposition, /attachment/);
  assert.match(disposition, /sample\.wrapped\.srt/);

  // fetch 的 text() 会剥离 BOM，改用原始字节解码。
  const body = Buffer.from(await response.arrayBuffer()).toString('utf8');
  // 带 BOM，编号从 1 连续，时轴原样保留。
  assert.ok(body.startsWith('﻿'));
  assert.match(body, /1\n00:00:00,000 --> 00:00:02,000\nhello\nworld\nfoo/);
  assert.match(body, /2\n00:00:02,500 --> 00:00:04,000\n短字幕/);
  assert.match(body, /3\n00:00:04,500 --> 00:00:06,000\n<i>保持<\/i>\n\{\\an8\}样式/);
});

test('下载：UTF-8 文件名保留在 Content-Disposition 中', async () => {
  const response = await postWrap(
    { maxWidth: '40', maxLines: '2' },
    SAMPLE_SRT,
    { path: '/api/wrap/download', fileName: '电影字幕.srt' }
  );

  assert.equal(response.status, 200);
  const disposition = response.headers.get('content-disposition');
  assert.ok(disposition.includes(encodeURIComponent('电影字幕.wrapped.srt')));
});

test('下载：存在无法消除超限的字幕时同样拒绝导出', async () => {
  const response = await postWrap(
    { maxWidth: '4', maxLines: '1' },
    SAMPLE_SRT,
    { path: '/api/wrap/download' }
  );
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.feasible, false);
  assert.ok(data.failedIndices.length > 0);
});

test('换行预览：缺少文件返回 400', async () => {
  const response = await postWrap({ maxWidth: '40' }, null);
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.match(data.error, /上传/);
});

test('换行预览：参数越界或非整数返回 400', async () => {
  const tooNarrow = await postWrap({ maxWidth: '1' }, SAMPLE_SRT);
  assert.equal(tooNarrow.status, 400);
  assert.match((await tooNarrow.json()).error, /每行最大显示宽度/);

  const tooWide = await postWrap({ maxWidth: '201' }, SAMPLE_SRT);
  assert.equal(tooWide.status, 400);

  const fractionalWidth = await postWrap({ maxWidth: '40.5' }, SAMPLE_SRT);
  assert.equal(fractionalWidth.status, 400);
  assert.match((await fractionalWidth.json()).error, /整数/);

  const noLines = await postWrap({ maxLines: '0' }, SAMPLE_SRT);
  assert.equal(noLines.status, 400);
  assert.match((await noLines.json()).error, /最多行数/);

  const tooManyLines = await postWrap({ maxLines: '11' }, SAMPLE_SRT);
  assert.equal(tooManyLines.status, 400);
});

test('换行预览：SRT 格式错误返回 400', async () => {
  const response = await postWrap({ maxWidth: '40' }, '这不是字幕内容');
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.match(data.error, /时间行/);
});

test('缺省参数使用默认值', async () => {
  const response = await postWrap({}, SAMPLE_SRT);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data.options, { maxWidth: 40, maxLines: 2 });
});

test('原有接口不受影响', async () => {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal((await health.json()).ok, true);

  const form = new FormData();
  form.append(
    'subtitle',
    new Blob(['1\n00:00:00,000 --> 00:00:00,500\naaaaaaaaaa\n'], { type: 'text/plain' }),
    'sample.srt'
  );
  const fix = await fetch(`http://127.0.0.1:${port}/api/fix`, {
    method: 'POST',
    body: form,
  });
  assert.equal(fix.status, 200);
  assert.equal((await fix.json()).feasible, true);
});
