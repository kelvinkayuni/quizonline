import { roundToOneDecimal, shortAnswerMarksAwarded, shortAnswerMatchScore } from './shortAnswerMatching.js';
import assert from 'node:assert/strict';
const cases = [
  ['the study of gemstones', 'the branch of science that studies gemstones'],
  ['the study of gemstones', 'study gemstones'],
  ['the study of gemstones', 'gemstones are studied by scientists'],
  ['the study of gemstones', 'the study of stones'],
  ['water', 'not water'],
  ['water', 'water is not clean'],
  ['run', 'running'],
  ['run', 'the athlete is running'],
  ['sunlight', 'sunlight is important'],
  ['plant', 'this is not a plant'],
  ['sunlight; plant; make food', 'plants use sunlight to make food'],
  ['car/automobile; home/house', 'automobile house'],
  ['sunlight; plant; make food', 'plants use sunlight to make'],
  ['water; heat; light; air; soil', 'water'],
  ['water; heat; light; air; soil', 'water heat'],
  ['water; heat; light; air; soil; mineral; root; leaf; stem; seed', 'water heat light air soil mineral root leaf stem']
];
for (const [expected, response] of cases) {
  console.log(JSON.stringify({ expected, response, score: shortAnswerMatchScore(expected, response) }));
}

assert.equal(shortAnswerMatchScore('plant', 'this is not a plant'), 0);
assert.equal(shortAnswerMatchScore('water', 'not water'), 0);
assert.equal(shortAnswerMatchScore('water', 'water is not clean'), 1);
assert.equal(shortAnswerMatchScore('water; heat; light; air; soil', 'water'), 0.2);
assert.equal(shortAnswerMatchScore('water; heat; light; air; soil', 'water heat'), 0.4);
assert.equal(shortAnswerMatchScore('water; heat; light; air; soil; mineral; root; leaf; stem; seed', 'water heat light air soil mineral root leaf stem'), 0.9);
assert.equal(shortAnswerMarksAwarded(0.2, 5), 0);
assert.equal(shortAnswerMarksAwarded(0.2001, 5), 1);
assert.equal(shortAnswerMarksAwarded(0.6, 5), 3);
assert.equal(shortAnswerMarksAwarded(0.899, 5), 4.5);
assert.equal(shortAnswerMarksAwarded(0.9, 5), 5);
assert.equal(shortAnswerMarksAwarded(0.899, 1), 0.9);
assert.equal(shortAnswerMarksAwarded(0.9, 1), 1);
assert.equal(shortAnswerMarksAwarded(0.6, 1.5), 0.9);
assert.equal(roundToOneDecimal(0.1 + 0.2), 0.3);
