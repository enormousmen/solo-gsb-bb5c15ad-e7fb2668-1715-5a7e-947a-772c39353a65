'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');
const { parseZipEntries } = require('./helpers');

// 三条字幕各占 40 秒，相邻间隔 10 秒；每卷最长 1 分钟时每卷只能放一条。
const SAMPLE_SRT =
  '1\n00:00:00,000 --> 00:00:40,000\n第一卷内容\n\n' +
  '2\n00:00:50,000 --> 00:01:30,000\n第二卷内容\n\n' +
  '3\n00:01:40,000 --> 00:02:20,000\n第三卷内容\n';

let server;
let port;

test.before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function postSplit(fields, srt, { path = '/api/split', fileName = 'sample.srt' } = {}) {
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

test('分卷预览：返回每卷原始时间范围、字幕数与字符数', async () => {
  const response = await postSplit({ maxMinutes: '1', maxChars: '1000' }, SAMPLE_SRT);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.feasible, true);
  assert.equal(data.volumeCount, 3);
  assert.equal(data.options.maxDurationMs, 60000);
  assert.equal(data.totalGapMs, 20000);

  const [first, second, third] = data.volumes;
  assert.equal(first.fileName, 'sample.part01.srt');
  assert.equal(first.start, '00:00:00,000');
  assert.equal(first.end, '00:00:40,000');
  assert.equal(first.cueCount, 1);
  assert.equal(first.charCount, 5);
  assert.equal(first.gapAfterMs, 10000);
  assert.equal(second.startMs, 50000);
  assert.equal(second.endMs, 90000);
  assert.equal(third.gapAfterMs, null);
});

test('分卷预览：缺少文件返回 400', async () => {
  const response = await postSplit({ maxMinutes: '1' }, null);
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.match(data.error, /上传/);
});

test('分卷预览：参数越界返回 400', async () => {
  const tooShort = await postSplit({ maxMinutes: '0.5' }, SAMPLE_SRT);
  assert.equal(tooShort.status, 400);
  assert.match((await tooShort.json()).error, /每卷最长分钟数/);

  const tooLong = await postSplit({ maxMinutes: '31' }, SAMPLE_SRT);
  assert.equal(tooLong.status, 400);

  const tooFewChars = await postSplit({ maxChars: '99' }, SAMPLE_SRT);
  assert.equal(tooFewChars.status, 400);
  assert.match((await tooFewChars.json()).error, /每卷最多字符数/);

  const tooManyChars = await postSplit({ maxChars: '20001' }, SAMPLE_SRT);
  assert.equal(tooManyChars.status, 400);

  const fractionalChars = await postSplit({ maxChars: '100.5' }, SAMPLE_SRT);
  assert.equal(fractionalChars.status, 400);
  assert.match((await fractionalChars.json()).error, /整数/);
});

test('单条字幕自身超限：422 并列出编号与原因', async () => {
  const srt =
    `1\n00:00:00,000 --> 00:01:30,000\n${'超'.repeat(150)}\n\n` +
    '2\n00:01:40,000 --> 00:01:45,000\n正常字幕\n';
  const response = await postSplit({ maxMinutes: '1', maxChars: '100' }, srt);
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.feasible, false);
  assert.equal(data.oversizedCues.length, 1);
  assert.equal(data.oversizedCues[0].index, 1);
  assert.equal(data.oversizedCues[0].reasons.length, 2);
  assert.match(data.oversizedCues[0].reasons.join(''), /时长/);
  assert.match(data.oversizedCues[0].reasons.join(''), /字符/);
});

test('下载 ZIP：包含回零的卷文件与 manifest.json', async () => {
  const response = await postSplit(
    { maxMinutes: '1', maxChars: '1000' },
    SAMPLE_SRT,
    { path: '/api/split/download' }
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/zip/);
  assert.match(response.headers.get('content-disposition'), /attachment/);

  const zip = Buffer.from(await response.arrayBuffer());
  const entries = parseZipEntries(zip);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['sample.part01.srt', 'sample.part02.srt', 'sample.part03.srt', 'manifest.json']
  );

  // 第二卷原始开始是 00:00:50,000，回零后应从 00:00:00,000 开始。
  const secondVolume = entries[1].data.toString('utf8');
  assert.match(secondVolume, /^﻿1\n00:00:00,000 --> 00:00:40,000/);
  assert.match(secondVolume, /第二卷内容/);

  const manifest = JSON.parse(entries[3].data.toString('utf8'));
  assert.equal(manifest.source, 'sample.srt');
  assert.equal(manifest.volumeCount, 3);
  assert.equal(manifest.options.maxDurationMs, 60000);
  assert.equal(manifest.volumes.length, 3);
  assert.equal(manifest.volumes[0].file, 'sample.part01.srt');
  assert.deepEqual(manifest.volumes[0].originalRange, {
    startMs: 0,
    endMs: 40000,
    start: '00:00:00,000',
    end: '00:00:40,000',
  });
  assert.equal(manifest.volumes[1].originalRange.startMs, 50000);
  assert.equal(manifest.volumes[2].file, 'sample.part03.srt');
});

test('下载 ZIP：单条超限同样拒绝导出', async () => {
  const srt = `1\n00:00:00,000 --> 00:02:00,000\n${'长'.repeat(50)}\n`;
  const response = await postSplit({ maxMinutes: '1' }, srt, {
    path: '/api/split/download',
  });
  const data = await response.json();

  assert.equal(response.status, 422);
  assert.equal(data.feasible, false);
  assert.equal(data.oversizedCues[0].index, 1);
});

test('UTF-8 文件名在清单与卷文件名中原样保留', async () => {
  const response = await postSplit({ maxMinutes: '5', maxChars: '1000' }, SAMPLE_SRT, {
    path: '/api/split/download',
    fileName: '电影字幕.srt',
  });

  assert.equal(response.status, 200);
  const zip = Buffer.from(await response.arrayBuffer());
  const entries = parseZipEntries(zip);
  assert.equal(entries[0].name, '电影字幕.part01.srt');

  const manifest = JSON.parse(entries[entries.length - 1].data.toString('utf8'));
  assert.equal(manifest.source, '电影字幕.srt');
  assert.equal(manifest.volumeCount, 1);
});

test('原有修复接口不受影响', async () => {
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
