'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clusterWidth,
  tokenize,
  displayWidth,
  wrapCueText,
  wrapCues,
} = require('../src/wrap');
const { parseSrt } = require('../src/srt');

test('宽度：中文及全角计 2，其他可见字符计 1，标签与 ASS 覆盖块计 0', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('你好'), 4);
  assert.equal(displayWidth('，。！'), 6);
  assert.equal(displayWidth('<i>你好</i>'), 4);
  assert.equal(displayWidth('<font color="red">字</font>'), 2);
  assert.equal(displayWidth('{\\an8}hello'), 5);
  assert.equal(displayWidth('a b'), 3); // 行内半角空格计 1
  assert.equal(displayWidth('a　b'), 4); // 全角空格计 2
  assert.equal(displayWidth('👨‍👩‍👧'), 2); // 单个字素簇
});

test('字素簇宽度：组合字符与表情按簇计算', () => {
  assert.equal(clusterWidth('e\u0301'), 1); // e + 组合音符是一个字素簇
  assert.equal(clusterWidth('🇨🇳'), 2);
  assert.equal(clusterWidth('1'), 1);
  assert.equal(clusterWidth('１'), 2); // 全角数字
});

test('分词：标签与覆盖块是不可断开的原子单元', () => {
  const tokens = tokenize('<font color="red">ab</font>{\\an8}cd ef');
  assert.deepEqual(
    tokens.map((token) => [token.kind, token.text, token.width]),
    [
      ['atom', '<font color="red">', 0],
      ['atom', 'a', 1],
      ['atom', 'b', 1],
      ['atom', '</font>', 0],
      ['atom', '{\\an8}', 0],
      ['atom', 'c', 1],
      ['atom', 'd', 1],
      ['space', ' ', 1],
      ['atom', 'e', 1],
      ['atom', 'f', 1],
    ]
  );
});

test('空白处断行；两种方案同分时取更早的断点', () => {
  // 「aaa|bbb ccc」与「aaa bbb|ccc」超限、极差、断点数都相同，应选更早的断点。
  const result = wrapCueText('aaa bbb ccc', 7, 2);
  assert.deepEqual(result.lines.map((line) => line.text), ['aaa', 'bbb ccc']);
  assert.deepEqual(result.lines.map((line) => line.width), [3, 7]);
  assert.equal(result.overflow, 0);
  assert.equal(result.range, 4);
  assert.equal(result.breaks, 1);
  assert.equal(result.changed, true);
  assert.equal(result.feasible, true);
});

test('标点后可直接断行（无空格）', () => {
  const result = wrapCueText('你好，世界你好', 10, 2);
  assert.deepEqual(result.lines.map((line) => line.text), ['你好，', '世界你好']);
  assert.deepEqual(result.lines.map((line) => line.width), [6, 8]);
  assert.equal(result.feasible, true);
});

test('标签与 ASS 覆盖块不会从内部断开，样式标记原样保留', () => {
  const html = wrapCueText('<i>hello world</i>', 5, 2);
  assert.deepEqual(html.lines.map((line) => line.text), ['<i>hello', 'world</i>']);
  assert.equal(html.text, '<i>hello\nworld</i>');

  const ass = wrapCueText('{\\an8}你好，世界', 6, 2);
  assert.deepEqual(ass.lines.map((line) => line.text), ['{\\an8}你好，', '世界']);
  assert.deepEqual(ass.lines.map((line) => line.width), [6, 4]);
});

test('目标顺序：超限宽度优先于行宽极差', () => {
  // 1 行超限 6；2 行无超限但极差 1 → 选 2 行。
  const result = wrapCueText('aaaa b c', 4, 2);
  assert.deepEqual(result.lines.map((line) => line.text), ['aaaa', 'b c']);
  assert.equal(result.overflow, 0);
  assert.equal(result.range, 1);
});

test('目标顺序：行宽极差优先于断点位置', () => {
  // 「aa|bb ccc」极差 3；「aa bb|ccc」极差 2 → 选后者（断点更晚但极差更小）。
  const result = wrapCueText('aa bb ccc', 5, 2);
  assert.deepEqual(result.lines.map((line) => line.text), ['aa bb', 'ccc']);
  assert.equal(result.overflow, 0);
  assert.equal(result.range, 2);
});

test('目标顺序：断点数（行数）在最后', () => {
  // 2 行即可无超限且极差为 0，不应拆成 3 行。
  const result = wrapCueText('aa bb cc dd', 5, 3);
  assert.deepEqual(result.lines.map((line) => line.text), ['aa bb', 'cc dd']);
  assert.equal(result.lineCount, 2);
  assert.equal(result.breaks, 1);
});

test('单行能容纳时不引入断点', () => {
  const result = wrapCueText('hello world', 20, 3);
  assert.deepEqual(result.lines.map((line) => line.text), ['hello world']);
  assert.equal(result.breaks, 0);
  assert.equal(result.changed, false);
});

test('原有换行作为强制断点保留并计入行数', () => {
  const kept = wrapCueText('aaa\nbbb', 10, 2);
  assert.deepEqual(kept.lines.map((line) => line.text), ['aaa', 'bbb']);
  assert.equal(kept.breaks, 0);
  assert.equal(kept.changed, false);
  assert.equal(kept.feasible, true);

  // 既有 3 行超过最多行数 2：无法合并，标记为不可行。
  const tooMany = wrapCueText('a\nb\nc', 10, 2);
  assert.equal(tooMany.feasible, false);
  assert.equal(tooMany.lineCount, 3);
});

test('无法在行数内消除超限时标记为不可行', () => {
  // 无空白无标点的长串不可断行。
  const result = wrapCueText('你好世界你好世界', 4, 3);
  assert.equal(result.feasible, false);
  assert.ok(result.overflow > 0);
});

test('wrapCues：整体可行性、失败清单与替换后的文本', () => {
  const cues = parseSrt(
    '1\n00:00:01,000 --> 00:00:02,000\n你好世界，你好\n\n' +
      `2\n00:00:03,000 --> 00:00:04,000\n${'长'.repeat(10)}\n`
  );
  const result = wrapCues(cues, { maxWidth: 10, maxLines: 2 });
  assert.equal(result.feasible, false);
  assert.equal(result.failedCues.length, 1);
  assert.equal(result.failedCues[0].index, 2);
  assert.match(result.failedCues[0].reason, /超限/);
  assert.equal(result.results[0].feasible, true);
  assert.equal(result.results[1].feasible, false);

  const ok = wrapCues(cues.slice(0, 1), { maxWidth: 10, maxLines: 2 });
  assert.equal(ok.feasible, true);
  assert.equal(ok.wrappedCues[0].text, '你好世界，\n你好');
  assert.equal(ok.wrappedCues[0].start, 1000); // 时轴保持不变
  assert.equal(ok.stats.changed, 1);
  assert.equal(ok.stats.failed, 0);
});

test('单条字幕过长时抛出带编号的可读错误', () => {
  const cues = [{ index: 5, start: 0, end: 1000, text: 'a'.repeat(1200) }];
  assert.throws(() => wrapCues(cues, { maxWidth: 40, maxLines: 2 }), /第 5 条字幕/);
});

/** 暴力枚举全部合法断点组合，返回与 DP 相同字典序下的最优解。 */
function bruteForceBest(text, maxWidth, maxLines) {
  const tokens = tokenize(text);
  const T = tokens.length;

  const containsNewline = (a, b) => {
    for (let i = a; i < b; i += 1) {
      if (tokens[i].kind === 'newline') return true;
    }
    return false;
  };
  const render = (a, b) => {
    let piece = '';
    for (let i = a; i < b; i += 1) piece += tokens[i].text;
    return piece.replace(/^\s+|\s+$/g, '');
  };

  function* wrappings(start, linesLeft) {
    if (linesLeft === 0) {
      // 全部词法单元已用完才算完成（末尾换行只终结最后一行，不产生空行）。
      if (start >= T) yield [];
      return;
    }
    if (start >= T) return;
    for (let j = start + 1; j <= T; j += 1) {
      if (containsNewline(start, j)) break;
      const atNewline = j < T && tokens[j].kind === 'newline';
      const prev = tokens[j - 1];
      const legal =
        j === T ||
        atNewline ||
        prev.kind === 'space' ||
        (prev.kind === 'atom' && prev.punct);
      if (!legal) continue;
      const next = atNewline ? j + 1 : j;
      for (const rest of wrappings(next, linesLeft - 1)) {
        yield [j, ...rest];
      }
    }
  }

  const seqLex = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  };

  let best = null;
  for (let k = 1; k <= maxLines; k += 1) {
    for (const ends of wrappings(0, k)) {
      const lines = [];
      let start = 0;
      for (const end of ends) {
        lines.push(render(start, end));
        start = end < T && tokens[end].kind === 'newline' ? end + 1 : end;
      }
      const widths = lines.map((line) => displayWidth(line));
      const o = widths.reduce((sum, width) => sum + Math.max(0, width - maxWidth), 0);
      const range = Math.max(...widths) - Math.min(...widths);
      const candidate = { o, range, k, ends, lines };
      if (
        !best ||
        candidate.o < best.o ||
        (candidate.o === best.o && candidate.range < best.range) ||
        (candidate.o === best.o && candidate.range === best.range && candidate.k < best.k) ||
        (candidate.o === best.o &&
          candidate.range === best.range &&
          candidate.k === best.k &&
          seqLex(candidate.ends, best.ends) < 0)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

test('换行 DP 与暴力枚举一致（随机化对照）', () => {
  const alphabet = ['a', 'b', 'c', ' ', ' ', '，', '。', '你', '好', '\n', '<i>', '</i>'];
  let seed = 20260920;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let iter = 0; iter < 300; iter += 1) {
    const length = 1 + Math.floor(rand() * 12);
    let text = '';
    for (let i = 0; i < length; i += 1) {
      text += alphabet[Math.floor(rand() * alphabet.length)];
    }
    const maxWidth = 3 + Math.floor(rand() * 7);
    const maxLines = 1 + Math.floor(rand() * 4);

    const expected = bruteForceBest(text, maxWidth, maxLines);
    const actual = wrapCueText(text, maxWidth, maxLines);
    const label = `text=${JSON.stringify(text)} maxWidth=${maxWidth} maxLines=${maxLines}`;

    if (!expected) {
      assert.equal(actual.feasible, false, `应无解：${label}`);
      continue;
    }
    assert.equal(actual.overflow, expected.o, `超限宽度：${label}`);
    assert.equal(actual.range, expected.range, `行宽极差：${label}`);
    assert.equal(actual.lineCount, expected.k, `行数：${label}`);
    assert.deepEqual(
      actual.lines.map((line) => line.text),
      expected.lines,
      `断点序列：${label}`
    );
    actual.lines.forEach((line, i) => {
      assert.equal(line.width, displayWidth(expected.lines[i]), `行宽：${label} 第 ${i} 行`);
    });
    assert.equal(actual.feasible, expected.o === 0, `可行性：${label}`);
  }
});
