import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSemanticText, createSemanticMap, normalizeCorpusText, normalizeSemanticWord, tokenizeSemanticText, trainSemanticModel } from '../semanticModel.js';

test('semantic tokenization keeps negation and selected short terms but drops stopwords', () => {
  assert.deepEqual(
    tokenizeSemanticText('AI and no gemstones, not safe, never durable, without water.'),
    ['ai', 'no', 'gemstone', 'not', 'safe', 'never', 'durable', 'without', 'water']
  );
});

test('possessives do not produce malformed apostrophe terms', () => {
  assert.deepEqual(tokenizeSemanticText("it's"), []);
  assert.deepEqual(tokenizeSemanticText("student's"), ['student']);
});

test('non-similar rules accept one word including stopwords and negated words', () => {
  assert.equal(normalizeSemanticWord('is'), 'is');
  assert.equal(normalizeSemanticWord("isn't"), "isn't");
  assert.equal(normalizeSemanticWord('not a word pair'), '');
});

test('directional contraction rules normalize to base word plus not', () => {
  const rules = [{ negative_form: "hasn't", base_word: 'has' }];
  assert.deepEqual(tokenizeSemanticText("hasn't gemstones", [], rules), ['not', 'gemstone']);
  assert.deepEqual(tokenizeSemanticText('has not gemstones', [], rules), ['not', 'gemstone']);
  assert.equal(normalizeSemanticWord('does'), 'does');
  assert.deepEqual(tokenizeSemanticText("doesn't damage", [], [{ negative_form: "doesn't", base_word: 'does' }]), ['does', 'not', 'damage']);
});

test('contractions and expanded negation compare through the same model path', () => {
  const rules = [{ negative_form: "isn't", base_word: 'is' }];
  const model = trainSemanticModel([{ text_content: 'Gemstones are studied. Gemstones are researched. Study describes gemstones. Research describes gemstones.' }], [], rules);
  const contractedAndExpanded = compareSemanticText(model, "isn't the study of gemstones", 'is not the study of gemstones', rules);
  const contractedAgainstPositive = compareSemanticText(model, "isn't the study of gemstones", 'is the study of gemstones', rules);
  const expandedAgainstPositive = compareSemanticText(model, 'is not the study of gemstones', 'is the study of gemstones', rules);
  assert.equal(contractedAndExpanded.score, 100);
  assert.equal(contractedAgainstPositive.score, expandedAgainstPositive.score);
  assert.equal(contractedAgainstPositive.nonSimilarPairMatched, false);
});

test('negation reverses the next term in a semantic comparison', () => {
  const model = trainSemanticModel([{ text_content: 'Safe material protects people. Safe mineral limits damage. Safe treatment prevents injury.' }]);
  const positive = compareSemanticText(model, 'safe', 'safe');
  const negated = compareSemanticText(model, 'safe', 'not safe');
  const sentenceBoundary = compareSemanticText(model, 'safe', 'not. safe');
  assert.equal(positive.score, 100);
  assert.equal(negated.score, 0);
  assert.equal(sentenceBoundary.score, 100);
  assert.equal(negated.knownB, 2);
});

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
  assert.ok(map.nodes.every(node => node.coordinateX >= -1 && node.coordinateX <= 1 && node.coordinateY >= -1 && node.coordinateY <= 1));
  assert.ok(map.nodes.every(node => node.x >= 90 && node.x <= 850 && node.y >= 50 && node.y <= 510));
});

test('saved coordinates stay fixed for the same corpus and drift gradually for a new revision', () => {
  const model = trainSemanticModel([{ text_content: 'Quartz is a mineral. Feldspar is a mineral. Quartz crystals are hard.' }]);
  const firstMap = createSemanticMap(model, 60, [], 'revision-1');
  const saved = firstMap.nodes.map(node => ({ term: node.word, x: node.coordinateX, y: node.coordinateY, model_signature: 'revision-1' }));
  const sameRevision = createSemanticMap(model, 60, saved, 'revision-1');
  assert.deepEqual(sameRevision.nodes.map(node => [node.coordinateX, node.coordinateY]), firstMap.nodes.map(node => [node.coordinateX, node.coordinateY]));
  const nextRevision = createSemanticMap(model, 60, saved, 'revision-2');
  assert.ok(nextRevision.nodes.every((node, index) => Math.abs(node.coordinateX - saved[index].x) <= .3 && Math.abs(node.coordinateY - saved[index].y) <= .3));
});

test('unseen terms are excluded and report corpus coverage', () => {
  const model = trainSemanticModel([{ text_content: 'Ruby is a red gemstone. Sapphire is a blue gemstone.' }]);
  const result = compareSemanticText(model, 'ruby mystery', 'sapphire');
  assert.equal(result.knownA, 1);
  assert.equal(result.knownB, 1);
  assert.equal(result.coverage, 67);
});

test('plural forms share one canonical term and retain their observed spellings', () => {
  const model = trainSemanticModel([{ text_content: 'Gemstones resist scratching. A gemstone can resist abrasion. Glass is different.' }]);
  const gemstone = model.terms.find(term => term.word === 'gemstone');
  assert.equal(model.frequencies.get('gemstone'), 2);
  assert.deepEqual(new Set(gemstone.forms.map(form => form.surface)), new Set(['Gemstones', 'gemstone']));
  assert.equal(model.frequencies.get('glass'), 1);
});

test('teacher glossary aliases map variants to a canonical term', () => {
  const model = trainSemanticModel([{ text_content: 'Jewellery settings hold gemstones. Jewelry settings protect gemstones.' }], [
    { alias: 'jewellery', canonical_term: 'jewelry' }
  ]);
  assert.equal(model.frequencies.get('jewelry'), 2);
  assert.equal(model.frequencies.has('jewellery'), false);
});

test('identical normalized passages are counted once across documents', () => {
  const model = trainSemanticModel([
    { text_content: 'Quartz resists scratching.' },
    { text_content: '  QUARTZ   resists scratching.  ' }
  ]);
  assert.equal(model.stats.passages, 1);
  assert.equal(model.stats.duplicatePassages, 1);
  assert.equal(model.frequencies.get('quartz'), 1);
});

test('document duplicate normalization ignores case, Unicode dash variants, and spacing', () => {
  assert.equal(normalizeCorpusText('Long–term   GEMSTONES'), normalizeCorpusText('long-term gemstones'));
});