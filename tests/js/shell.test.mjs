import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements, statementAt, completionContext } from '../../src/ZawMongo/wwwroot/js/shelllex.js';
import { isWrite, changesAll } from '../../src/ZawMongo/wwwroot/js/shellcheck.js';

test('statements split like the backend splits them', () => {
  const s = "use shop\ndb.c.find({ a: 'x;y' })\n  .sort({ b: 1 });db.c.countDocuments({})\n// note\ndb.c.insertOne({\n  a: /;/\n})";
  assert.deepEqual(splitStatements(s).map(x => x.text), ['use shop', "db.c.find({ a: 'x;y' })\n  .sort({ b: 1 })", 'db.c.countDocuments({})', 'db.c.insertOne({\n  a: /;/\n})']);
});

test('the statement at the caret', () => {
  const s = 'db.a.find()\n\ndb.b.find()';
  assert.equal(statementAt(s, 2).text, 'db.a.find()');
  assert.equal(statementAt(s, 12).text, 'db.a.find()');
  assert.equal(statementAt(s, s.length).text, 'db.b.find()');
});

test('completion contexts', () => {
  assert.deepEqual(completionContext('db.or', 5), { kind: 'dbmember', prefix: 'or' });
  assert.deepEqual(completionContext('db.orders.fi', 12), { kind: 'method', coll: 'orders', prefix: 'fi' });
  assert.deepEqual(completionContext('db.orders.find({}).so', 21), { kind: 'cursor', prefix: 'so' });
  assert.equal(completionContext('db.c.find({ a: { $g', 19).kind, 'operator');
});

test('writes are recognised, reads are not', () => {
  for (const w of ['db.c.insertOne({})', 'db.c.updateMany({}, { $set: { a: 1 } })', 'db.c.drop()', "db.c.aggregate([{ $out: 'x' }])", 'db.runCommand({ dropIndexes: "c", index: "*" })'])
    assert.ok(isWrite(w), w);
  for (const r of ['db.c.find({ note: "insertOne(" })', 'db.c.aggregate([{ $match: {} }])', 'db.runCommand({ ping: 1 })', "db.runCommand('ping')", 'show dbs'])
    assert.ok(!isWrite(r), r);
});

test('empty-filter changes are flagged', () => {
  assert.ok(changesAll('db.c.deleteMany({})'));
  assert.ok(changesAll('db.c.updateMany( { }, { $set: { a: 1 } })'));
  assert.ok(!changesAll('db.c.deleteMany({ a: 1 })'));
});
