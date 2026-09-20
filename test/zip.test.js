'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createZip, crc32 } = require('../src/zip');
const { parseZipEntries } = require('./helpers');

test('crc32 与已知值一致', () => {
  // 标准测试向量：CRC32("123456789") = 0xCBF43926
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('生成的 ZIP 可解析出全部条目与内容', () => {
  const entries = [
    {
      name: 'movie.part01.srt',
      data: Buffer.from('﻿1\n00:00:00,000 --> 00:00:01,000\n你好\n', 'utf8'),
    },
    {
      name: 'manifest.json',
      data: Buffer.from('{"volumeCount":1}\n', 'utf8'),
    },
  ];

  const zip = createZip(entries, new Date(2026, 8, 19, 12, 30, 0));
  const parsed = parseZipEntries(zip);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'movie.part01.srt');
  assert.equal(parsed[0].method, 0);
  assert.equal(parsed[0].utf8, true);
  assert.equal(parsed[0].crc32, crc32(entries[0].data));
  assert.deepEqual(parsed[0].data, entries[0].data);
  assert.equal(parsed[1].name, 'manifest.json');
  assert.deepEqual(parsed[1].data, entries[1].data);
});

test('UTF-8 文件名原样保留', () => {
  const zip = createZip([
    { name: '电影.part01.srt', data: Buffer.from('x') },
  ]);
  const parsed = parseZipEntries(zip);
  assert.equal(parsed[0].name, '电影.part01.srt');
});

test('空条目列表抛出错误', () => {
  assert.throws(() => createZip([]), /至少需要一个条目/);
});
