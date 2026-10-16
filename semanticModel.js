import pluralize from 'pluralize';

const STOPWORDS = new Set('a an and are as at be been but by for from had has have he her hers him his i if in into is it its of on or our she that the their them then there these they this those to was we were what when where which who will with would you your'.split(' '));
const NEGATION_TERMS = new Set(['no', 'not', 'never', 'without']);
const LOCAL_NEGATION_TERMS = new Set(['no', 'without']);
const SHORT_TERM_ALLOWLIST = new Set(['ai']);
const APPROVED_ACTION_ROLE_FAMILIES = {
  measurement: new Set(['measure', 'weigh', 'calibrate', 'compare', 'detect', 'determine', 'estimate', 'examine', 'focus', 'identify', 'judge', 'observe']),
  opticalProcess: new Set(['absorb', 'emit', 'enter', 'emerge', 'pass', 'polarize', 'refract', 'reflect', 'transmit', 'vibrate', 'rotate', 'illuminate', 'disperse']),
  materialProcessing: new Set(['carve', 'compose', 'create', 'cut', 'drill', 'dye', 'fill', 'form', 'grow', 'heat', 'mine', 'process', 'produce', 'shape', 'treat', 'yield', 'polish', 'saturate']),
  causalChange: new Set(['affect', 'allow', 'become', 'cause', 'change', 'consist', 'contain', 'contribute', 'depend', 'develop', 'enhance', 'increase', 'lead', 'occur', 'prevent', 'protect', 'reduce', 'vary', 'improve']),
  evidenceDescription: new Set(['associate', 'describe', 'display', 'explain', 'include', 'indicate', 'relate', 'report', 'represent', 'resemble', 'reveal', 'show', 'suggest', 'support', 'mean']),
  transactionUsage: new Set(['adjust', 'apply', 'buy', 'find', 'follow', 'get', 'give', 'help', 'learn', 'leave', 'look', 'make', 'need', 'offer', 'place', 'provide', 'require', 'sell', 'take', 'use'])
};
const APPROVED_ACTION_LEMMAS = new Set(Object.values(APPROVED_ACTION_ROLE_FAMILIES).flatMap(set => [...set]));
const DISALLOWED_ACTION_LEMMAS = new Set(['be', 'have', 'gemstone', 'jadeite', 'tanzanite']);

function normalizedSurfaceForm(word) {
  return word.normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-');
}

function normalizedSingularTerm(word) {
  const normalized = normalizedSurfaceForm(word).toLowerCase().replace(/'s$/u, '');
  return normalized === 'does' ? normalized : pluralize.singular(normalized);
}

function createGlossaryMap(glossary) {
  if (glossary instanceof Map) return glossary;
  return new Map((glossary || []).map(entry => [
    normalizedSingularTerm(entry.alias),
    normalizedSingularTerm(entry.canonical_term)
  ]));
}

function canonicalTerm(word, glossary) {
  const singular = normalizedSingularTerm(word);
  return glossary.get(singular) || singular;
}

export function normalizeSemanticWord(word, glossary = []) {
  const surface = normalizedSurfaceForm(String(word || '').normalize('NFKC').trim());
  if (!/^[\p{L}\p{M}]+(?:['-][\p{L}\p{M}]+)*$/u.test(surface)) return '';
  return canonicalTerm(surface, createGlossaryMap(glossary));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandNegationRules(text, negationRules, glossary) {
  let expanded = normalizedSurfaceForm(String(text || '').normalize('NFKC'));
  for (const rule of negationRules || []) {
    const negativeForm = normalizeSemanticWord(rule.negative_form ?? rule.negativeForm, glossary);
    const baseWord = normalizeSemanticWord(rule.base_word ?? rule.baseWord, glossary);
    if (!negativeForm || !baseWord || negativeForm === baseWord) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}_])${escapeRegExp(negativeForm)}(?=$|[^\\p{L}\\p{M}\\p{N}_])`, 'giu');
    expanded = expanded.replace(pattern, (_match, prefix) => `${prefix}${baseWord} not`);
  }
  return expanded;
}

function tokenizeWithSurfaceForms(text, glossary) {
  return (String(text || '').normalize('NFKC').match(/[\p{L}][\p{L}\p{M}'’ʼ\-‐‑‒–—−]*/gu) || [])
    .map(raw => {
      const surface = normalizedSurfaceForm(raw).replace(/^[-']+|[-']+$/g, '');
      return { term: canonicalTerm(surface, glossary), surface };
    })
    .filter(token => {
      const isNegation = NEGATION_TERMS.has(token.term);
      const isAllowedShortTerm = SHORT_TERM_ALLOWLIST.has(token.term);
      return (token.term.length > 2 || isNegation || isAllowedShortTerm)
        && (!STOPWORDS.has(token.term) || isNegation || isAllowedShortTerm);
    });
}

export function tokenizeSemanticText(text, glossary = [], negationRules = []) {
  const glossaryMap = createGlossaryMap(glossary);
  return tokenizeWithSurfaceForms(expandNegationRules(text, negationRules, glossaryMap), glossaryMap).map(token => token.term);
}

export function trainSemanticModel(documents, glossary = [], negationRules = []) {
  const glossaryMap = createGlossaryMap(glossary);
  const frequencies = new Map();
  const surfaceForms = new Map();
  const cooccurrence = new Map();
  const seenPassages = new Set();
  let passageCount = 0;
  let duplicatePassages = 0;
  let totalPairs = 0;

  for (const document of documents || []) {
    const expandedText = expandNegationRules(document.text_content, negationRules, glossaryMap);
    const passages = expandedText.split(/(?:[.!?;\n]+|\s+[-*]\s+)/).map(text => tokenizeWithSurfaceForms(text, glossaryMap)).filter(tokens => tokens.length);
    for (const tokens of passages) {
      const words = tokens.map(token => token.term);
      const passageKey = words.join(' ');
      if (seenPassages.has(passageKey)) {
        duplicatePassages++;
        continue;
      }
      seenPassages.add(passageKey);
      passageCount++;
      for (let index = 0; index < words.length; index++) {
        const word = words[index];
        frequencies.set(word, (frequencies.get(word) || 0) + 1);
        if (!surfaceForms.has(word)) surfaceForms.set(word, new Map());
        const forms = surfaceForms.get(word);
        const surface = tokens[index].surface;
        forms.set(surface, (forms.get(surface) || 0) + 1);
        for (let offset = 1; offset <= 5 && index + offset < words.length; offset++) {
          const neighbor = words[index + offset];
          if (word === neighbor) continue;
          const weight = 1 / offset;
          addCooccurrence(cooccurrence, word, neighbor, weight);
          addCooccurrence(cooccurrence, neighbor, word, weight);
          totalPairs += weight * 2;
        }
      }
    }
  }

  const rowTotals = new Map();
  const columnTotals = new Map();
  for (const [word, contexts] of cooccurrence) {
    for (const [context, weight] of contexts) {
      rowTotals.set(word, (rowTotals.get(word) || 0) + weight);
      columnTotals.set(context, (columnTotals.get(context) || 0) + weight);
    }
  }

  const vectors = new Map();
  for (const [word, contexts] of cooccurrence) {
    const vector = new Map();
    for (const [context, weight] of contexts) {
      const probabilityRatio = (weight * totalPairs) / ((rowTotals.get(word) || 1) * (columnTotals.get(context) || 1));
      const positivePmi = Math.log(probabilityRatio);
      if (positivePmi > 0) vector.set(context, positivePmi);
    }
    if (vector.size) vectors.set(word, vector);
  }

  const terms = [...frequencies].map(([word, count]) => ({
    word,
    count,
    forms: [...(surfaceForms.get(word) || [])].map(([surface, formCount]) => ({ surface, count: formCount })).sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface)),
    vector: vectors.get(word) || new Map()
  })).filter(term => term.vector.size).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  return { terms, vectors, frequencies, glossary: glossaryMap, stats: { terms: frequencies.size, passages: passageCount, duplicatePassages, documents: documents?.length || 0 } };
}

function addCooccurrence(matrix, word, context, weight) {
  if (!matrix.has(word)) matrix.set(word, new Map());
  const row = matrix.get(word);
  row.set(context, (row.get(context) || 0) + weight);
}

function splitNegationPassages(text) {
  const withoutAdditiveNegation = String(text || '')
    .replace(/\bnot\s+only\b/giu, ' ')
    .replace(/\bbut\s+also\b/giu, ' ');
  return withoutAdditiveNegation.split(/(?:[.!?;,\n]+|\s+[-*]\s+|\s+\bbut\b\s+|\s+\balthough\b\s+|\s+\bwhile(?=\s+(?:[\p{L}\p{M}'’ʼ-]+\s+){0,2}(?:am|is|are|was|were|be|been|being|has|have|had|does|do|did|can|could|may|might|will|would|must|contain|contains|form|forms|remain|remains|occur|occurs|increase|increases|decrease|decreases|rise|rises|rose|fall|falls|fell|change|changes|changed|show|shows|indicate|indicates)\b)\s+)/iu);
}

function vectorForText(model, text, negationRules) {
  const expandedText = expandNegationRules(text, negationRules, model?.glossary);
  const passages = splitNegationPassages(expandedText)
    .map(passage => tokenizeSemanticText(passage, model?.glossary));
  const tokens = passages.flat();
  const vector = new Map();
  const known = new Set();
  for (const passage of passages) {
    let clausePolarity = 1;
    const locallyNegatedIndexes = new Set();
    for (let index = 0; index < passage.length; index++) {
      const token = passage[index];
      if (NEGATION_TERMS.has(token)) {
        known.add(token);
        if (LOCAL_NEGATION_TERMS.has(token)) {
          if (index + 1 < passage.length) locallyNegatedIndexes.add(index + 1);
        } else {
          clausePolarity *= -1;
        }
        continue;
      }
      const source = model?.vectors.get(token);
      if (source) {
        known.add(token);
        const polarity = clausePolarity * (locallyNegatedIndexes.has(index) ? -1 : 1);
        for (const [context, value] of source) {
          vector.set(context, (vector.get(context) || 0) + polarity * value / Math.max(1, tokens.length));
        }
      }
    }
  }
  return { vector, known: known.size, total: new Set(tokens).size };
}

function actionRoleFamilyForToken(token) {
  const normalized = normalizeSemanticWord(token, []);
  if (!normalized || DISALLOWED_ACTION_LEMMAS.has(normalized)) return null;
  for (const [family, actions] of Object.entries(APPROVED_ACTION_ROLE_FAMILIES)) {
    if (actions.has(normalized)) return family;
  }
  return null;
}

function actionRoleVectorForText(text, glossary) {
  const tokens = tokenizeSemanticText(text, glossary);
  const vector = new Map();
  for (const token of tokens) {
    const family = actionRoleFamilyForToken(token);
    if (!family) continue;
    vector.set(family, (vector.get(family) || 0) + 1);
  }
  return vector;
}

function comparisonContainsWord(text, word, glossary) {
  const words = String(text || '').normalize('NFKC').match(/[\p{L}][\p{L}\p{M}'’ʼ\-‐‑‒–—−]*/gu) || [];
  return words.some(candidate => normalizeSemanticWord(candidate, glossary) === word);
}

function cosineSimilarity(vectorA, vectorB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of vectorA.values()) normA += value * value;
  for (const value of vectorB.values()) normB += value * value;
  for (const [key, value] of vectorA) dot += value * (vectorB.get(key) || 0);
  if (!normA || !normB) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(normA * normB)));
}

export function compareSemanticText(model, textA, textB, negationRules = [], legacyNonSimilarPairs = []) {
  const a = vectorForText(model, textA, negationRules);
  const b = vectorForText(model, textB, negationRules);
  const nonSimilarPairMatched = legacyNonSimilarPairs.some(pair => {
    const wordA = normalizeSemanticWord(pair.word_a ?? pair.wordA, model?.glossary);
    const wordB = normalizeSemanticWord(pair.word_b ?? pair.wordB, model?.glossary);
    return wordA && wordB && (
      (comparisonContainsWord(textA, wordA, model?.glossary) && comparisonContainsWord(textB, wordB, model?.glossary))
      || (comparisonContainsWord(textA, wordB, model?.glossary) && comparisonContainsWord(textB, wordA, model?.glossary))
    );
  });
  const baseScore = cosineSimilarity(a.vector, b.vector);
  const actionRoleBoost = (() => {
    const vectorA = actionRoleVectorForText(textA, model?.glossary);
    const vectorB = actionRoleVectorForText(textB, model?.glossary);
    if (!vectorA.size || !vectorB.size) return 0;
    const mergedKeys = new Set([...vectorA.keys(), ...vectorB.keys()]);
    const paddedA = new Map();
    const paddedB = new Map();
    for (const key of mergedKeys) {
      paddedA.set(key, vectorA.get(key) || 0);
      paddedB.set(key, vectorB.get(key) || 0);
    }
    return cosineSimilarity(paddedA, paddedB);
  })();
  const blendedScore = nonSimilarPairMatched ? 0 : Math.max(0, Math.min(1, baseScore * 0.85 + actionRoleBoost * 0.15));
  const finalScore = nonSimilarPairMatched ? 0 : Math.max(baseScore, blendedScore);
  const coverageCount = a.known + b.known;
  const totalCount = a.total + b.total;
  return {
    score: Math.round(finalScore * 100),
    baseScore: Math.round(baseScore * 100),
    roleBoost: actionRoleBoost,
    nonSimilarPairMatched,
    knownA: a.known,
    knownB: b.known,
    coverage: totalCount ? Math.round((coverageCount / totalCount) * 100) : 0
  };
}

function stableProjectionCoefficient(word, axis) {
  let hash = axis === 'x' ? 2166136261 : 2246822519;
  for (const character of word) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return ((hash >>> 0) / 2147483647.5) - 1;
}

function projectWordVector(vector) {
  let projectedX = 0;
  let projectedY = 0;
  let magnitude = 0;
  for (const [context, weight] of vector) {
    projectedX += weight * stableProjectionCoefficient(context, 'x');
    projectedY += weight * stableProjectionCoefficient(context, 'y');
    magnitude += weight * weight;
  }
  const scale = Math.sqrt(magnitude) || 1;
  return {
    x: Math.tanh((projectedX / scale) * 1.8) * .94,
    y: Math.tanh((projectedY / scale) * 1.8) * .94
  };
}

function clampCoordinate(value) {
  return Math.max(-1, Math.min(1, value));
}

export function createSemanticMap(model, limit = 60, savedCoordinates = [], modelSignature = '') {
  const terms = (model?.terms || []).slice(0, limit);
  const savedByTerm = new Map(savedCoordinates.map(coordinate => [coordinate.term, coordinate]));
  const availableAnchors = terms.map(term => ({ term, saved: savedByTerm.get(term.word) })).filter(item => item.saved);
  const nodes = terms.map(term => {
    const target = projectWordVector(term.vector);
    const saved = savedByTerm.get(term.word);
    let coordinateX = target.x;
    let coordinateY = target.y;

    if (saved) {
      if (saved.model_signature === modelSignature) {
        coordinateX = Number(saved.x);
        coordinateY = Number(saved.y);
      } else {
        coordinateX = Number(saved.x) * .85 + target.x * .15;
        coordinateY = Number(saved.y) * .85 + target.y * .15;
      }
    } else if (availableAnchors.length) {
      const neighbors = availableAnchors.map(anchor => ({
        x: Number(anchor.saved.x),
        y: Number(anchor.saved.y),
        similarity: cosineSimilarity(term.vector, anchor.term.vector)
      })).filter(anchor => anchor.similarity > .1).sort((left, right) => right.similarity - left.similarity).slice(0, 5);
      const totalWeight = neighbors.reduce((sum, neighbor) => sum + neighbor.similarity ** 2, 0);
      if (totalWeight) {
        const anchorX = neighbors.reduce((sum, neighbor) => sum + neighbor.x * neighbor.similarity ** 2, 0) / totalWeight;
        const anchorY = neighbors.reduce((sum, neighbor) => sum + neighbor.y * neighbor.similarity ** 2, 0) / totalWeight;
        coordinateX = anchorX * .7 + target.x * .3;
        coordinateY = anchorY * .7 + target.y * .3;
      }
    }

    coordinateX = clampCoordinate(coordinateX);
    coordinateY = clampCoordinate(coordinateY);
    return {
      ...term,
      coordinateX,
      coordinateY,
      x: 90 + (coordinateX + 1) * 380,
      y: 50 + (1 - coordinateY) * 230
    };
  });
  const edges = [];
  for (let left = 0; left < nodes.length; left++) {
    for (let right = left + 1; right < nodes.length; right++) {
      const similarity = cosineSimilarity(nodes[left].vector, nodes[right].vector);
      if (similarity >= .18) edges.push({ left, right, similarity });
    }
  }
  return {
    nodes,
    edges: edges.map(edge => ({ x1: nodes[edge.left].x, y1: nodes[edge.left].y, x2: nodes[edge.right].x, y2: nodes[edge.right].y, similarity: edge.similarity }))
  };
}

export function normalizeCorpusText(text) {
  return String(text || '').normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}