'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

const SAMPLE_SRT =
  '1\n00:00:00,000 --> 00:00:00,500\naaaaaaaaaa\n\n' +
  '2\n00:00:02,000 --> 00:00:03,000\nlocked line\n\n' +
  '3\n00:00:03,100 --> 00:00:03,400\ncccccccccc\n';

let server;
let port;

test.before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function postFix(fields, srt) {
  const form = new FormData();
  form.append('subtitle', new Blob([srt], { type: 'text/plain' }), 'sample.srt');
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/fix`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json();
  return { status: response.status, data };
}

test('API：锁定字幕保持原始时间并在结果中标记', async () => {
  const { status, data } = await postFix(
    { minDurationSeconds: '1', maxCps: '100', minGapMs: '100', locks: '2' },
    SAMPLE_SRT
  );

  assert.equal(status, 200);
  assert.equal(data.feasible, true);
  assert.deepEqual(data.lockedIndices, [2]);
  assert.equal(data.stats.locked, 1);

  const lockedCue = data.fixedCues[1];
  assert.equal(lockedCue.locked, true);
  assert.equal(lockedCue.start, 2000);
  assert.equal(lockedCue.end, 3000);
  assert.equal(data.originalCues[1].locked, true);
  assert.equal(data.originalCues[0].locked, false);

  // 下载内容与预览一致：序列化结果中锁定字幕保持原始时间。
  assert.match(data.fixedSrt, /00:00:02,000 --> 00:00:03,000/);
});

test('API：不传锁定参数时行为兼容', async () => {
  const { status, data } = await postFix({}, SAMPLE_SRT);

  assert.equal(status, 200);
  assert.equal(data.feasible, true);
  assert.deepEqual(data.lockedIndices, []);
  assert.equal(data.stats.locked, 0);
  assert.ok(data.fixedCues.every((cue) => cue.locked === false));
});

test('API：两个锁定锚点冲突时返回 422 与锚点信息', async () => {
  const srt =
    '1\n00:00:00,000 --> 00:00:01,000\naaaaa\n\n' +
    '2\n00:00:01,050 --> 00:00:02,000\nbbbbb\n';
  const { status, data } = await postFix({ locks: '1,2', minGapMs: '100' }, srt);

  assert.equal(status, 422);
  assert.equal(data.feasible, false);
  assert.deepEqual(data.lockedIndices, [1, 2]);
  assert.deepEqual(data.conflict.lockedIndices, [1, 2]);
  assert.equal(data.conflict.requiredMs, 2050);
  assert.equal(data.conflict.availableMs, 2000);
  assert.equal(data.originalCues[0].locked, true);
  assert.equal(data.originalCues[1].locked, true);
});

test('API：锁定编号超出范围返回 400', async () => {
  const { status, data } = await postFix({ locks: '9' }, SAMPLE_SRT);

  assert.equal(status, 400);
  assert.match(data.error, /超出范围/);
});

test('API：锁定编号格式错误返回 400', async () => {
  const { status, data } = await postFix({ locks: 'abc' }, SAMPLE_SRT);

  assert.equal(status, 400);
  assert.match(data.error, /无效/);
});
