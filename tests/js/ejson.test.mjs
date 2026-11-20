import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeOf, toShell, summary, columnsOf, editValue, toRelaxedJson } from '../../src/ZawMongo/wwwroot/js/ejson.js';

const doc = {
  _id: { $oid: '5f1d7f3b9d1e8a0001a1b2c3' }, i: { $numberInt: '7' }, l: { $numberLong: '9007199254740993' }, d: { $numberDouble: '1.0' },
  m: { $numberDecimal: '9.99' }, at: { $date: { $numberLong: '1704164645000' } }, u: { $binary: { base64: 'ABEiM0RVZneImaq7zN3u/w==', subType: '04' } },
  r: { $regularExpression: { pattern: 'a/b', options: 'i' } }, s: 'x', n: null, arr: [{ $numberInt: '1' }], o: { 'a b': true },
};

test('types are recognised from canonical Extended JSON', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, typeOf(v)])), {
    _id: 'objectId', i: 'int', l: 'long', d: 'double', m: 'decimal', at: 'date', u: 'uuid', r: 'regex', s: 'string', n: 'null', arr: 'array', o: 'object',
  });
  assert.equal(typeOf(undefined), 'missing');
});

test('shell syntax keeps every type readable back exactly', () => {
  assert.equal(toShell(doc, 0),
    '{ _id: ObjectId("5f1d7f3b9d1e8a0001a1b2c3"), i: 7, l: NumberLong("9007199254740993"), d: 1.0, m: NumberDecimal("9.99"), ' +
    'at: ISODate("2024-01-02T03:04:05.000Z"), u: UUID("00112233-4455-6677-8899-aabbccddeeff"), r: /a\\/b/i, s: "x", n: null, arr: [1], o: { "a b": true } }');
  assert.match(toShell(doc, 2), /^\{\n  _id: ObjectId/);
});

test('grid summaries are short', () => {
  assert.equal(summary(doc.o), '{ 1 field }');
  assert.equal(summary(doc.arr), '[ 1 item ]');
  assert.equal(summary(doc.at), '2024-01-02T03:04:05.000Z');
  assert.equal(summary(doc.l), '9007199254740993');
});

test('columns put _id first', () => {
  assert.deepEqual(columnsOf([{ a: 1, _id: 1 }, { b: 2 }]), ['_id', 'a', 'b']);
});

test('a string field stays a string whatever is typed; other fields read shell syntax', () => {
  assert.equal(editValue('old', '42'), '"42"');
  assert.equal(editValue({ $numberInt: '1' }, '42'), '42');
  assert.equal(editValue(undefined, 'hello'), '"hello"');
  assert.equal(editValue(undefined, 'ISODate("2024-01-01")'), 'ISODate("2024-01-01")');
});

test('relaxed JSON for the clipboard keeps big longs exact', () => {
  const j = JSON.parse(toRelaxedJson({ a: { $numberInt: '1' }, l: doc.l, at: doc.at }));
  assert.deepEqual(j, { a: 1, l: { $numberLong: '9007199254740993' }, at: { $date: '2024-01-02T03:04:05.000Z' } });
});
