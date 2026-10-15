import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSemanticText, createSemanticMap, trainSemanticModel } from '../semanticModel.js';

test('corpus context gives related terms closer vectors than unrelated terms', () => {
  const model = trainSemanticModel([{ text_content: 'Diamond is hard. Sapphire is hard. Diamond resists scratching. Sapphire resists abrasion. River water flows. River water floods.' }]);
  const related = compareSemanticText(model, 'diamond', 'sapphire');
  const unrelated = compareSemanticText(model, 'diamond', 'river');
  assert.ok(related.score > unrelated.score);
  assert.equal(related.knownA, 1);
  assert.equal(related.knownB, 1);
});

test('map output has bounded coordinates and links contextual terms', () => {
  const model = trainSemanticModel([{ text_content: 'Quartz is a mineral. Feldspar is a mineral. Quartz crystals are hard. Feldspar crystals are hard.' }]);
  const map = createSemanticMap(model);
  assert.ok(map.nodes.length > 0);
  assert.ok(map.edges.length > 0);
  assert.ok(map.nodes.every(node => node.x >= 42 && node.x <= 858 && node.y >= 40 && node.y <= 520));
});

test('unseen terms are excluded and report corpus coverage', () => {
  const model = trainSemanticModel([{ text_content: 'Ruby is a red gemstone. Sapphire is a blue gemstone.' }]);
  const result = compareSemanticText(model, 'ruby mystery', 'sapphire');
  assert.equal(result.knownA, 1);
  assert.equal(result.knownB, 1);
  assert.equal(result.coverage, 67);
});