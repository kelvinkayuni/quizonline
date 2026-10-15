import pluralize from 'pluralize';

const STOPWORDS = new Set('a an and are as at be been but by for from had has have he her hers him his i if in into is it its of on or our she that the their them then there these they this those to was we were what when where which who will with would you your'.split(' '));

function normalizedSurfaceForm(word) {
  return word.normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-');
}

function createGlossaryMap(glossary) {
  if (glossary instanceof Map) return glossary;
  return new Map((glossary || []).map(entry => [
    pluralize.singular(normalizedSurfaceForm(entry.alias).toLowerCase()),
    pluralize.singular(normalizedSurfaceForm(entry.canonical_term).toLowerCase())
  ]));
}

function canonicalTerm(word, glossary) {
  const singular = pluralize.singular(normalizedSurfaceForm(word).toLowerCase());
  return glossary.get(singular) || singular;
}

function tokenizeWithSurfaceForms(text, glossary) {
  return (String(text || '').normalize('NFKC').match(/[\p{L}][\p{L}\p{M}'’ʼ\-‐‑‒–—−]*/gu) || [])
    .map(raw => {
      const surface = normalizedSurfaceForm(raw).replace(/^[-']+|[-']+$/g, '');
      return { term: canonicalTerm(surface, glossary), surface };
    })
    .filter(token => token.term.length > 2 && !STOPWORDS.has(token.term));
}

export function tokenizeSemanticText(text, glossary = []) {
  const glossaryMap = createGlossaryMap(glossary);
  return tokenizeWithSurfaceForms(text, glossaryMap).map(token => token.term);
}

export function trainSemanticModel(documents, glossary = []) {
  const glossaryMap = createGlossaryMap(glossary);
  const frequencies = new Map();
  const surfaceForms = new Map();
  const cooccurrence = new Map();
  const seenPassages = new Set();
  let passageCount = 0;
  let duplicatePassages = 0;
  let totalPairs = 0;

  for (const document of documents || []) {
    const passages = String(document.text_content || '').normalize('NFKC').split(/(?:[.!?;\n]+|\s+[-*]\s+)/).map(text => tokenizeWithSurfaceForms(text, glossaryMap)).filter(tokens => tokens.length);
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

function vectorForText(model, text) {
  const tokens = tokenizeSemanticText(text, model?.glossary);
  const vector = new Map();
  const known = new Set();
  for (const token of tokens) {
    const source = model?.vectors.get(token);
    if (!source) continue;
    known.add(token);
    for (const [context, value] of source) vector.set(context, (vector.get(context) || 0) + value / Math.max(1, tokens.length));
  }
  return { vector, known: known.size, total: new Set(tokens).size };
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

export function compareSemanticText(model, textA, textB) {
  const a = vectorForText(model, textA);
  const b = vectorForText(model, textB);
  const coverageCount = a.known + b.known;
  const totalCount = a.total + b.total;
  return {
    score: Math.round(cosineSimilarity(a.vector, b.vector) * 100),
    knownA: a.known,
    knownB: b.known,
    coverage: totalCount ? Math.round((coverageCount / totalCount) * 100) : 0
  };
}

export function createSemanticMap(model, limit = 60) {
  const nodes = (model?.terms || []).slice(0, limit).map((term, index) => {
    const seed = [...term.word].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, index + 1);
    const angle = (seed % 10000) / 10000 * Math.PI * 2;
    const radius = .18 + ((seed >>> 8) % 1000) / 1600;
    return { ...term, rawX: Math.cos(angle) * radius, rawY: Math.sin(angle) * radius };
  });
  const edges = [];
  const similarities = new Map();
  for (let left = 0; left < nodes.length; left++) {
    for (let right = left + 1; right < nodes.length; right++) {
      const similarity = cosineSimilarity(nodes[left].vector, nodes[right].vector);
      similarities.set(`${left}:${right}`, similarity);
      if (similarity >= .18) edges.push({ left, right, similarity });
    }
  }

  const positions = nodes.map(node => ({ x: node.rawX, y: node.rawY }));
  for (let iteration = 0; iteration < 110; iteration++) {
    const movement = positions.map(() => ({ x: 0, y: 0 }));
    for (let left = 0; left < positions.length; left++) {
      for (let right = left + 1; right < positions.length; right++) {
        let dx = positions[right].x - positions[left].x;
        let dy = positions[right].y - positions[left].y;
        const distance = Math.max(.001, Math.hypot(dx, dy));
        const similarity = similarities.get(`${left}:${right}`) || 0;
        const target = .09 + (1 - similarity) * .6;
        const force = similarity > .1 ? (distance - target) * .012 : -Math.max(0, .22 - distance) * .018;
        dx = (dx / distance) * force;
        dy = (dy / distance) * force;
        movement[left].x += dx;
        movement[left].y += dy;
        movement[right].x -= dx;
        movement[right].y -= dy;
      }
    }
    const cooling = 1 - iteration / 145;
    for (let index = 0; index < positions.length; index++) {
      positions[index].x += (movement[index].x - positions[index].x * .012) * cooling;
      positions[index].y += (movement[index].y - positions[index].y * .012) * cooling;
    }
  }

  const xs = positions.map(position => position.x);
  const ys = positions.map(position => position.y);
  const minX = Math.min(...xs, -.1);
  const maxX = Math.max(...xs, .1);
  const minY = Math.min(...ys, -.1);
  const maxY = Math.max(...ys, .1);
  const mappedNodes = nodes.map((node, index) => ({ ...node, x: 42 + ((positions[index].x - minX) / (maxX - minX || 1)) * 816, y: 40 + ((positions[index].y - minY) / (maxY - minY || 1)) * 480 }));
  return {
    nodes: mappedNodes,
    edges: edges.map(edge => ({ x1: mappedNodes[edge.left].x, y1: mappedNodes[edge.left].y, x2: mappedNodes[edge.right].x, y2: mappedNodes[edge.right].y, similarity: edge.similarity }))
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