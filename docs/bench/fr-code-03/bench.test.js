const test = require('node:test');
const assert = require('node:assert');
const { slugify } = require('./text');
const { median } = require('./stats');
const { parseDuration } = require('./duration');

test('slugify trims dashes on both ends', () => {
  assert.strictEqual(slugify('  Hello, World!  '), 'hello-world');
  assert.strictEqual(slugify('A  B'), 'a-b');
});

test('median sorts numbers numerically', () => {
  assert.strictEqual(median([10, 9, 2]), 9);
  assert.strictEqual(median([1, 3, 2, 4]), 2.5);
  const xs = [3, 1, 2];
  median(xs);
  assert.deepStrictEqual(xs, [3, 1, 2]);
});

test('parseDuration rejects text with anything but h/m/s parts', () => {
  assert.strictEqual(parseDuration('1h30m'), 5400);
  assert.strictEqual(parseDuration('45s'), 45);
  assert.strictEqual(parseDuration('0s'), 0);
  assert.strictEqual(parseDuration('10 apples'), null);
});
