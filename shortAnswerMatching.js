const spellingVariantGroups = [
  ['gemmology', 'gemology'],
  ['colour', 'color'],
  ['favour', 'favor'],
  ['honour', 'honor'],
  ['labour', 'labor'],
  ['neighbour', 'neighbor'],
  ['centre', 'center'],
  ['theatre', 'theater'],
  ['metre', 'meter'],
  ['organise', 'organize'],
  ['analyse', 'analyze'],
  ['organisation', 'organization'],
  ['civilisation', 'civilization'],
  ['dialogue', 'dialog'],
  ['catalogue', 'catalog'],
  ['programme', 'program'],
  ['traveller', 'traveler'],
  ['jewellery', 'jewelry'],
  ['anaemia', 'anemia'],
  ['paediatric', 'pediatric'],
  ['oestrogen', 'estrogen'],
  ['foetus', 'fetus'],
  ['encyclopaedia', 'encyclopedia'],
  ['aesthetic', 'esthetic'],
  ['defence', 'defense'],
  ['offence', 'offense'],
  ['licence', 'license']
];

const spellingVariants = new Map(
  spellingVariantGroups.flatMap(group => group.map(word => [word, group[0]]))
);

const irregularPlurals = new Map([
  ['children', 'child'],
  ['men', 'man'],
  ['women', 'woman'],
  ['feet', 'foot'],
  ['teeth', 'tooth'],
  ['geese', 'goose'],
  ['mice', 'mouse'],
  ['lice', 'louse'],
  ['oxen', 'ox'],
  ['indices', 'index'],
  ['matrices', 'matrix'],
  ['analyses', 'analysis'],
  ['criteria', 'criterion'],
  ['phenomena', 'phenomenon'],
  ['data', 'datum'],
  ['cacti', 'cactus'],
  ['fungi', 'fungus']
]);

const invariantWords = new Set([
  'news', 'series', 'species', 'means', 'crossroads', 'headquarters',
  'mathematics', 'physics', 'economics', 'politics', 'athletics', 'measles'
]);

function tokenize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function normalizeSpelling(word) {
  return spellingVariants.get(word) || word
    .replace(/our$/, 'or')
    .replace(/re$/, 'er')
    .replace(/isation$/, 'ization')
    .replace(/ise$/, 'ize')
    .replace(/yse$/, 'yze')
    .replace(/ogue$/, 'og')
    .replace(/ll(?=(?:ed|ing|er|or|ation)$)/, 'l');
}

function singularForms(word) {
  const forms = new Set([word]);
  const irregular = irregularPlurals.get(word);
  if (irregular) forms.add(irregular);
  if (word.endsWith('ies') && word.length > 3) forms.add(`${word.slice(0, -3)}y`);
  if (/(?:ches|shes|xes|zes|sses)$/.test(word)) forms.add(word.slice(0, -2));
  if (word.endsWith('es') && word.length > 3) forms.add(word.slice(0, -2));
  if (word.endsWith('ves')) {
    forms.add(`${word.slice(0, -3)}f`);
    forms.add(`${word.slice(0, -3)}fe`);
  }
  if (word.endsWith('s') && !invariantWords.has(word) && !/(?:ss|us|is)$/.test(word)) forms.add(word.slice(0, -1));
  return forms;
}

function wordForms(word) {
  const forms = new Set();
  for (const singular of singularForms(word)) {
    const normalized = normalizeSpelling(singular);
    forms.add(normalized);
    const normalizedSingular = irregularPlurals.get(normalized);
    if (normalizedSingular) forms.add(normalizedSingular);
    for (const form of singularForms(normalized)) forms.add(form);
  }
  return forms;
}

export function shortAnswerMatches(expectedAnswer, studentResponse) {
  const expectedWords = tokenize(expectedAnswer);
  const studentWords = tokenize(studentResponse);
  if (!expectedWords.length || expectedWords.length > studentWords.length) return false;

  const expectedForms = expectedWords.map(wordForms);
  for (let start = 0; start <= studentWords.length - expectedWords.length; start++) {
    const phraseMatches = expectedForms.every((forms, offset) =>
      [...wordForms(studentWords[start + offset])].some(form => forms.has(form))
    );
    if (phraseMatches) return true;
  }
  return false;
}