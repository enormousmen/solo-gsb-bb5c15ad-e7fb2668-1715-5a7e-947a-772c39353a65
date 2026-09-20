'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

// 第 1 条需要按标点断行；第 2 条含样式标签需要在空格处断行；第 3 条无需换行。
const SAMPLE_SRT =
  '1\n00:00:01,000 --> 00:00:03,000\n你好世界，你好\n\n' +
  '2\n00:00:04,000 --> 00:00:06,000\n<i>hello world</i>\n\n' +
  '3\n00:00:07,000 --> 00:00:09,000\n短句\n';

let server;
let port;

test.before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function postWrap(fields, srt, { fileName = 'sample.srt' } = {}) {
  const form = new FormData();
  if (srt !== null) {
    form.append('subtitle', new Blob([srt], { type: 'text/plain' }), fileName);
  }
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return fetch(`http://127.0.0.1:${port}/api/wrap`, {
    method: 'POST',
    body: form,
  });
}

test('换行成功：预览各行宽度，导出的 SRT 保留编号、时轴与样式标记', async () => {
  const response = await postWrap({ maxWidth: '10', maxLines: '2' }, SAMPLE_SRT);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.feasible, true);
  assert.deepEqual(data.options, { maxWidth: 10, maxLines: 2 });
  assert.equal(data.stats.total, 3);
  assert.equal(data.stats.changed, 2);
  assert.equal(data.stats.failed, 0);

  const [first, second, third] = data.results;
  assert.equal(first.index, 1);
  assert.equal(first.start, 1000);
  assert.equal(first.end, 3000);
  assert.deepEqual(first.originalLines, [{ text: '你好世界，你好', width: 14 }]);
  assert.deepEqual(first.lines, [
    { text: '你好世界，', width: 10 },
    { text: '你好', width: 4 },
  ]);
  assert.equal(first.changed, true);
  assert.equal(first.feasible, true);

  assert.deepEqual(second.lines, [
    { text: '<i>hello', width: 5 },
    { text: 'world</i>', width: 5 },
  ]);

  assert.deepEqual(third.lines, [{ text: '短句', width: 4 }]);
  assert.equal(third.changed, false);

  assert.equal(
    data.wrappedSrt,
    '1\n00:00:01,000 --> 00:00:03,000\n你好世界，\n你好\n\n' +
      '2\n00:00:04,000 --> 00:00:06,000\n<i>hello\nworld</i>\n\n' +
      '3\n00:00:07,000 --> 00:00:09,000\n短句\n'
  );
});

test('ASS 覆盖块计 0 宽且不断开，导出的 SRT 原样保留', async () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\n{\\an8}你好，世界\n';
  const response = await postWrap({ maxWidth: '6', maxLines: '2' }, srt);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.feasible, true);
  assert.deepEqual(data.results[0].lines, [
    { text: '{\\an8}你好，', width: 6 },
    { text: '世界', width: 4 },
  ]);
  assert.match(data.wrappedSrt, /\{\\an8\}你好，\n世界/);
});

test('参数缺省时使用默认值', async () => {
  const response = await postWrap({}, SAMPLE_SRT);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data.options, { maxWidth: 40, maxLines: 2 });
});

test('无法在行数内消除超限：422 标出字幕并拒绝导出', async () => {
  const srt =
    `1\n00:00:01,000 --> 00:00:03,000\n${'长'.repeat(20)}\n\n` +
    '2\n00:00:04,000 --> 00:00:06,000\n正常字幕\n';
  const response = await postWrap({ maxWidth: '8', maxLines: '2' }, srt);
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.feasible, false);
  assert.match(data.error, /拒绝导出/);
  assert.equal(data.wrappedSrt, undefined);
  assert.equal(data.failedCues.length, 1);
  assert.equal(data.failedCues[0].index, 1);
  assert.equal(data.failedCues[0].overflow, 32); // 20 个汉字宽 40，超 8 计 32
  assert.match(data.failedCues[0].reason, /超限/);
  // 预览仍包含全部字幕的最佳尝试
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].feasible, false);
  assert.equal(data.results[1].feasible, true);
});

test('缺少文件返回 400', async () => {
  const response = await postWrap({ maxWidth: '10' }, null);
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.match(data.error, /上传/);
});

test('参数越界或非法返回 400', async () => {
  const narrow = await postWrap({ maxWidth: '3' }, SAMPLE_SRT);
  assert.equal(narrow.status, 400);
  assert.match((await narrow.json()).error, /每行最大显示宽度/);

  const wide = await postWrap({ maxWidth: '201' }, SAMPLE_SRT);
  assert.equal(wide.status, 400);

  const fractionalWidth = await postWrap({ maxWidth: '10.5' }, SAMPLE_SRT);
  assert.equal(fractionalWidth.status, 400);
  assert.match((await fractionalWidth.json()).error, /整数/);

  const zeroLines = await postWrap({ maxLines: '0' }, SAMPLE_SRT);
  assert.equal(zeroLines.status, 400);
  assert.match((await zeroLines.json()).error, /最多行数/);

  const tooManyLines = await postWrap({ maxLines: '11' }, SAMPLE_SRT);
  assert.equal(tooManyLines.status, 400);

  const fractionalLines = await postWrap({ maxLines: '2.5' }, SAMPLE_SRT);
  assert.equal(fractionalLines.status, 400);
});

test('SRT 格式错误返回 400', async () => {
  const response = await postWrap({ maxWidth: '10' }, '这不是字幕内容');
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.match(data.error, /时间行/);
});

test('原有修复与分卷接口不受影响', async () => {
  const form = new FormData();
  form.append(
    'subtitle',
    new Blob(['1\n00:00:00,000 --> 00:00:00,500\naaaaaaaaaa\n'], { type: 'text/plain' }),
    'sample.srt'
  );
  const response = await fetch(`http://127.0.0.1:${port}/api/fix`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.feasible, true);
});
