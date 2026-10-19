import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticCartographerMarksAwarded } from '../semanticCartographerScoring.js';

test('Cartographer awards zero below 30 percent regardless of coverage', () => {
  assert.equal(semanticCartographerMarksAwarded(0, 5), 0);
  assert.equal(semanticCartographerMarksAwarded(29.9, 5), 0);
});

test('Cartographer awards proportional marks from 30 up to below 80 percent', () => {
  assert.equal(semanticCartographerMarksAwarded(30, 5), 1.5);
  assert.equal(semanticCartographerMarksAwarded(65, 4), 2.6);
  assert.equal(semanticCartographerMarksAwarded(79.9, 5), 4);
});

test('Cartographer awards full marks at 80 percent or higher', () => {
  assert.equal(semanticCartographerMarksAwarded(80, 5), 5);
  assert.equal(semanticCartographerMarksAwarded(100, 5), 5);
});

test('Cartographer mark conversion rejects invalid similarities and bounds marks', () => {
  assert.equal(semanticCartographerMarksAwarded(NaN, 5), 0);
  assert.equal(semanticCartographerMarksAwarded(-1, 5), 0);
  assert.equal(semanticCartographerMarksAwarded(101, 5), 0);
  assert.equal(semanticCartographerMarksAwarded(70, 0), 0);
});