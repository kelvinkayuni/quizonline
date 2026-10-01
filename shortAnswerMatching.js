const spellingVariantGroups = [
  ['gemmology', 'gemology'],
  ['aluminium', 'aluminum'],
  ['sulphur', 'sulfur'],
  ['mould', 'mold'],
  ['plough', 'plow'],
  ['tyre', 'tire'],
  ['cheque', 'check'],
  ['grey', 'gray'],
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

const synonymGroups = [
  ['destination', 'attraction'],
  ['storytelling', 'branding'],
  ['promotion', 'advertising'],
  ['tourist', 'visitor'],
  ['guide', 'interpreter'],
  ['resort', 'lodge'],
  ['guesthouse', 'inn'],
  ['brochure', 'pamphlet'],
  ['booking', 'reservation'],
  ['carat', 'weight'],
  ['clarity', 'purity'],
  ['heavy', 'heavier'],
  ['low', 'lower'],
  ['tough', 'tougher', 'more_tough'],
  ['breaking', 'chipping'],
  ['withstand', 'endure', 'resist', 'tolerate', 'survive', 'bear', 'sustain'],
  ['brittle', 'less_tough', 'more_brittle'],
  ['appraisal', 'valuation'],
  ['authenticity', 'provenance'],
  ['simulant', 'imitation'],
  ['synthetic', 'labgrown'],
  ['deposit', 'ore body'],
  ['matrix', 'host rock'],
  ['prospecting', 'exploration'],
  ['tailings', 'mine waste'],
  ['diamond', 'brilliant'],
  ['ruby', 'red corundum'],
  ['sapphire', 'blue corundum'],
  ['emerald', 'green beryl'],
  ['aquamarine', 'blue beryl'],
  ['amethyst', 'purple quartz'],
  ['citrine', 'yellow quartz'],
  ['peridot', 'olivine'],
  ['spinel', 'balas ruby'],
  ['chrysoberyl', "cat's eye"],
  ['student', 'pupil'],
  ['teacher', 'instructor'],
  ['car', 'automobile'],
  ['house', 'home'],
  ['job', 'occupation'],
  ['child', 'kid'],
  ['lawyer', 'attorney'],
  ['movie', 'film', 'cinema'],
  ['shop', 'store'],
  ['information', 'data'],
  ['equipment', 'tools'],
  ['furniture', 'furnishings'],
  ['advice', 'guidance'],
  ['homework', 'assignment'],
  ['trousers', 'pants'],
  ['jumper', 'sweater'],
  ['lift', 'elevator', 'raise'],
  ['biscuit', 'cookie'],
  ['crisps', 'chips'],
  ['cellphone', 'mobile'],
  ['pc', 'computer'],
  ['tv', 'television'],
  ['photo', 'picture'],
  ['fridge', 'refrigerator'],
  ['bike', 'bicycle'],
  ['cab', 'taxi'],
  ['mail', 'post'],
  ['parcel', 'package'],
  ['resume', 'cv'],
  ['happy', 'glad'],
  ['angry', 'mad'],
  ['fast', 'quick'],
  ['small', 'tiny'],
  ['smart', 'clever'],
  ['rich', 'wealthy'],
  ['poor', 'needy'],
  ['sick', 'ill'],
  ['beauty', 'beautiful', 'pretty'],
  ['football', 'soccer'],
  ['holiday', 'vacation'],
  ['rubbish', 'trash'],
  ['lorry', 'truck'],
  ['torch', 'flashlight'],
  ['flat', 'apartment'],
  ['queue', 'line'],
  ['nappy', 'diaper'],
  ['sweets', 'candy'],
  ['trainers', 'sneakers'],
  ['autumn', 'fall'],
  ['underground', 'subway'],
  ['timetable', 'schedule'],
  ['maths', 'math'],
  ['aeroplane', 'airplane'],
  ['petrol', 'gas'],
  ['bonnet', 'hood'],
  ['boot', 'trunk'],
  ['high', 'higher', 'large', 'larger', 'big'],
  ['buy', 'purchase'],
  ['doctor', 'physician'],
  ['gem', 'gemstone'],
  ['make', 'produce'],
  ['beauty', 'beautiful']
];

const synonyms = new Map(
  synonymGroups.flatMap(group => group.map(word => [word, group[0]]))
);

const irregularRoots = new Map([
  ['ran', 'run'],
  ['saw', 'see'],
  ['seen', 'see'],
  ['took', 'take'],
  ['given', 'give'],
  ['spoke', 'speak'],
  ['spoken', 'speak'],
  ['wrote', 'write'],
  ['written', 'write'],
  ['children', 'child'],
  ['made', 'make'],
  ['bought', 'buy'],
  ['went', 'go'],
  ['gone', 'go'],
  ['did', 'do'],
  ['done', 'do'],
  ['had', 'have']
]);
const invariantWords = new Set([
  'news', 'series', 'species', 'means', 'crossroads', 'headquarters',
  'mathematics', 'physics', 'economics', 'politics', 'athletics', 'measles'
]);
const negationWords = new Set([
  'not', 'never', 'no', 'none', 'cannot', 'cant', 'dont', 'doesnt', 'didnt',
  'isnt', 'arent', 'wasnt', 'werent', 'havent', 'hasnt', 'hadnt', 'without',
  'lack', 'lacks', 'lacking'
]);
const stopWords = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'from', 'by', 'for',
  'and', 'or', 'but', 'through', 'with', 'as', 'this', 'that', 'these',
  'those', 'it', 'its', 'there', 'here', 'which', 'who', 'whom', 'what',
  'when', 'where', 'while', 'because', 'into', 'onto', 'about', 'over',
  'under', 'after', 'before', 'than', 'then', 'also', 'very', 'more',
  'most', 'some', 'any', 'each', 'every', 'all', 'both', 'their', 'his',
  'her', 'our', 'your', 'my', 'me', 'you', 'we', 'they', 'he', 'she',
  'i', 'us', 'them', 'him'
]);
const ignorableBetweenWords = new Set(['is', 'more', 'prone', 'less']);
const auxiliaryVerbs = new Set([
  'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had'
]);
const smallNumbers = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4],
  ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
  ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13],
  ['fourteen', 14], ['fifteen', 15], ['sixteen', 16], ['seventeen', 17],
  ['eighteen', 18], ['nineteen', 19]
]);
const tensNumbers = new Map([
  ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50],
  ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90]
]);
const compoundPhrases = [
  { words: ['high', 'specific', 'gravity'], value: 'high_density' },
  { words: ['lower', 'specific', 'gravity'], value: 'low_density' },
  { words: ['low', 'specific', 'gravity'], value: 'low_density' },
  { words: ['lower', 'density'], value: 'low_density' },
  { words: ['low', 'density'], value: 'low_density' },
  { words: ['less', 'dense'], value: 'low_density' },
  { words: ['high', 'density'], value: 'high_density' },
  { words: ['dense'], value: 'high_density' },
  { words: ['more', 'tough'], value: 'more_tough' },
  { words: ['less', 'tough'], value: 'less_tough' },
  { words: ['more', 'brittle'], value: 'more_brittle' },
  { words: ['light', 'weight', 'stone'], value: 'light_stone' },
  { words: ['light', 'stone'], value: 'light_stone' },
  { words: ['data', 'base'], value: 'database' },
  { words: ['high', 'school'], value: 'highschool' },
  { words: ['ice', 'cream'], value: 'icecream' },
  { words: ['class', 'room'], value: 'classroom' },
  { words: ['e', 'mail'], value: 'email' },
  { words: ['cell', 'phone'], value: 'cellphone' },
  { words: ['note', 'book'], value: 'notebook' },
  { words: ['text', 'book'], value: 'textbook' },
  { words: ['web', 'site'], value: 'website' },
  { words: ['lap', 'top'], value: 'laptop' },
  { words: ['water', 'fall'], value: 'waterfall' },
  { words: ['well', 'being'], value: 'wellbeing' }
];
const acceptedPhraseGroups = [
  { words: ['tour', 'operator'], value: 'tour_operator' },
  { words: ['travel', 'agency'], value: 'tour_operator' },
  { words: ['digital', 'marketing'], value: 'digital_marketing' },
  { words: ['online', 'promotion'], value: 'digital_marketing' },
  { words: ['brand', 'ambassador'], value: 'influencer' },
  { words: ['community', 'engagement'], value: 'community_engagement' },
  { words: ['local', 'participation'], value: 'community_engagement' },
  { words: ['responsible', 'tourism'], value: 'responsible_tourism' },
  { words: ['ethical', 'tourism'], value: 'responsible_tourism' },
  { words: ['risk', 'management'], value: 'risk_management' },
  { words: ['safety', 'planning'], value: 'risk_management' },
  { words: ['carrying', 'capacity'], value: 'carrying_capacity' },
  { words: ['visitor', 'limit'], value: 'carrying_capacity' },
  { words: ['museum'], value: 'museum' },
  { words: ['exhibition', 'hall'], value: 'museum' },
  { words: ['ticketing'], value: 'ticketing' },
  { words: ['pass', 'issuance'], value: 'ticketing' },
  { words: ['seasonality'], value: 'seasonality' },
  { words: ['peak', 'season'], value: 'seasonality' },
  { words: ['off', 'season'], value: 'seasonality' },
  { words: ['certification'], value: 'certification' },
  { words: ['lab', 'report'], value: 'certification' },
  { words: ['lab', 'grown'], value: 'synthetic' },
  { words: ['ore', 'body'], value: 'deposit' },
  { words: ['alluvial', 'deposit'], value: 'alluvial_deposit' },
  { words: ['placer', 'deposit'], value: 'alluvial_deposit' },
  { words: ['host', 'rock'], value: 'matrix' },
  { words: ['beneficiation'], value: 'beneficiation' },
  { words: ['ore', 'dressing'], value: 'beneficiation' },
  { words: ['mine', 'waste'], value: 'tailings' },
  { words: ['pit'], value: 'pit' },
  { words: ['open', 'cast', 'mine'], value: 'pit' },
  { words: ['shaft'], value: 'shaft' },
  { words: ['underground', 'tunnel'], value: 'shaft' },
  { words: ['artisanal', 'mining'], value: 'artisanal_mining' },
  { words: ['small', 'scale', 'mining'], value: 'artisanal_mining' },
  { words: ['red', 'corundum'], value: 'ruby' },
  { words: ['blue', 'corundum'], value: 'sapphire' },
  { words: ['green', 'beryl'], value: 'emerald' },
  { words: ['blue', 'beryl'], value: 'aquamarine' },
  { words: ['purple', 'quartz'], value: 'amethyst' },
  { words: ['yellow', 'quartz'], value: 'citrine' },
  { words: ['balas', 'ruby'], value: 'spinel' },
  { words: ['cat', 'eye'], value: 'chrysoberyl' },
  { words: ['cats', 'eye'], value: 'chrysoberyl' }
];
const meaningPhrases = [
  { words: ['not', 'good'], value: 'bad' },
  { words: ['united', 'nations'], value: 'un' },
  ...compoundPhrases,
  ...acceptedPhraseGroups
];
const eStemWords = new Set([
  'make', 'use', 'write', 'drive', 'take', 'give', 'come', 'live',
  'produce', 'change', 'bake', 'move', 'create', 'dance', 'measure'
]);
function expandContractions(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
  .replace(/[’‘]/g, "'")
  .replace(/\blet's\b/g, 'let us')
  .replace(/\by'all\b/g, 'you all')
  .replace(/\bgonna\b/g, 'going to')
  .replace(/\bwanna\b/g, 'want to')
  .replace(/\bcan't\b/g, 'can not')
  .replace(/\bcannot\b/g, 'can not')
  .replace(/\bwon't\b/g, 'will not')
  .replace(/\bshan't\b/g, 'shall not')
  .replace(/\bain't\b/g, 'is not')
  .replace(/\b([a-z]+)n't\b/g, '$1 not')
  .replace(/\b(i)'m\b/g, '$1 am')
  .replace(/\b(you|we|they|he|she|it)'re\b/g, '$1 are')
  .replace(/\b(i|you|we|they|he|she|it)'ve\b/g, '$1 have')
  .replace(/\b(i|you|we|they|he|she|it)'ll\b/g, '$1 will')
  .replace(/\b(i|you|he|she|it|we|they|that|there|who|what)'d\b/g, '$1 would')
  .replace(/\b(it|he|she|that|there|who|what|where|when|how)'s\b/g, '$1 is')
  .replace(/([\p{L}\p{N}])'s\b/gu, '$1')
  .replace(/([\p{L}\p{N}])'(?=\s|$)/gu, '$1');
}
function tokenize(value) {
  return expandContractions(value)
    .replace(/[\p{Pd}]/gu, ' ')
  .match(/[\p{L}\p{N}]+/gu) || [];
}

function numberSequence(tokens, start) {
  let cursor = start;
  let current = 0;
  let total = 0;
  let foundNumber = false;

  while (cursor < tokens.length) {
    const word = tokens[cursor];
    if (smallNumbers.has(word)) {
      current += smallNumbers.get(word);
      foundNumber = true;
      cursor++;
    } else if (tensNumbers.has(word)) {
      current += tensNumbers.get(word);
      foundNumber = true;
      cursor++;
    } else if (word === 'hundred' && foundNumber) {
      current = Math.max(1, current) * 100;
      cursor++;
    } else if (word === 'thousand' && foundNumber) {
      total += Math.max(1, current) * 1000;
      current = 0;
      cursor++;
    } else if (word === 'and' && foundNumber && cursor + 1 < tokens.length && smallNumbers.has(tokens[cursor + 1])) {
      cursor++;
    } else {
      break;
    }
  }

  return foundNumber ? { end: cursor, value: String(total + current) } : null;
}

function normalizeNumberWords(tokens) {
  const normalized = [];
  for (let index = 0; index < tokens.length;) {
    const sequence = numberSequence(tokens, index);
    if (sequence) {
      normalized.push(sequence.value);
      index = sequence.end;
    } else {
      normalized.push(tokens[index]);
      index++;
    }
  }
  return normalized;
}

function replacePhrases(tokens) {
  const output = [];
  for (let index = 0; index < tokens.length;) {
    const phrase = meaningPhrases.find(candidate =>
      candidate.words.every((word, offset) => tokens[index + offset] === word)
    );
    if (phrase) {
      output.push(phrase.value);
      index += phrase.words.length;
    } else {
      output.push(tokens[index]);
      index++;
    }
  }
  return output;
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

function rootWord(word) {
  const normalized = normalizeSpelling(word);
  if (irregularRoots.has(normalized)) return irregularRoots.get(normalized);

  if (normalized.endsWith('ies') && normalized.length > 4) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith('ied') && normalized.length > 4) return `${normalized.slice(0, -3)}y`;

  if (normalized.endsWith('ing') && normalized.length > 5) {
    let root = normalized.slice(0, -3);
    if (/(.)\1$/.test(root)) root = root.slice(0, -1);
    if (eStemWords.has(`${root}e`)) root = `${root}e`;
    return root;
  }

  if (normalized.endsWith('ed') && normalized.length > 4) {
    let root = normalized.slice(0, -2);
    if (/(.)\1$/.test(root)) root = root.slice(0, -1);
    if (eStemWords.has(`${root}e`)) root = `${root}e`;
    return root;
  }

  if (normalized.endsWith('er') && normalized.length > 4) {
    let root = normalized.slice(0, -2);
    if (/(.)\1$/.test(root)) root = root.slice(0, -1);
    if (eStemWords.has(`${root}e`)) root = `${root}e`;
    return root;
  }

  if (normalized.endsWith('es') && normalized.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(normalized)) {
    return normalized.slice(0, -2);
  }
  if (normalized.endsWith('s') && normalized.length > 3 && !invariantWords.has(normalized) && !/(?:ss|us|is)$/.test(normalized)) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

function canonicalizeTokens(tokens) {
  const numbered = normalizeNumberWords(tokens);
  const phrasesReplaced = replacePhrases(numbered);
  const compoundsReplaced = replacePhrases(phrasesReplaced);
  return compoundsReplaced.map(word => {
    const directSynonym = synonyms.get(word);
    if (directSynonym) return directSynonym;
    const normalized = normalizeSpelling(word);
    const normalizedSynonym = synonyms.get(normalized);
    if (normalizedSynonym) return normalizedSynonym;
    const root = normalizeSpelling(rootWord(normalized));
    return synonyms.get(root) || root;
  });
}

function normalizeAnswerTokens(value) {
  const tokens = canonicalizeTokens(tokenize(value));
  const normalized = [];
  let negated = false;

  for (let index = 0; index < tokens.length; index++) {
    const word = tokens[index];
    if (negationWords.has(word)) {
      negated = true;
      continue;
    }
    const isConnectorBetweenWords = index > 0
      && index < tokens.length - 1
      && (ignorableBetweenWords.has(word) || (word === 'to' && tokens[index - 1] === 'prone'));
    if (isConnectorBetweenWords) {
      continue;
    }

    const baseWord = word.replace(/^neg_/, '');
    if (baseWord && !stopWords.has(baseWord) && !auxiliaryVerbs.has(baseWord)) {
      normalized.push(negated ? `neg_${baseWord}` : baseWord);
    } else if (baseWord) {
      normalized.push(negated ? `neg_${baseWord}` : baseWord);
    }
    negated = false;
  }

  return normalized.length ? normalized : tokens;
}

function orderedPhraseMatch(expected, response) {
  if (!expected.length || !response.length || expected.length === 1) return false;

  let expectedIndex = 0;
  for (const word of response) {
    if (word === expected[expectedIndex]) {
      expectedIndex += 1;
      if (expectedIndex === expected.length) return true;
    }
  }

  return false;
}

function overlapCount(expected, response) {
  const available = new Map();
  response.forEach(word => available.set(word, (available.get(word) || 0) + 1));
  let matched = 0;

  expected.forEach(word => {
    const baseWord = word.replace(/^neg_/, '');
    const count = available.get(word) || 0;
    const negatedCount = available.get(`neg_${baseWord}`) || 0;

    if (word.startsWith('neg_')) {
      if (count > 0) {
        matched++;
        available.set(word, count - 1);
      }
    } else if (count > 0) {
      matched++;
      available.set(word, count - 1);
    } else if (negatedCount > 0) {
      // A negated concept directly blocks the positive concept.
      available.set(`neg_${baseWord}`, negatedCount - 1);
    }
  });

  return matched;
}

function expectedGroups(expectedAnswer) {
  return String(expectedAnswer || '').split(';').map(group =>
    group.split('/').map(normalizeAnswerTokens).filter(words => words.length)
  ).filter(alternatives => alternatives.length);
}

export function shortAnswerMatchScore(expectedAnswer, studentResponse) {
  const responseWords = normalizeAnswerTokens(studentResponse);
  const groups = expectedGroups(expectedAnswer);
  if (!responseWords.length || !groups.length) return 0;

  let totalMatched = 0;
  let totalExpected = 0;

  groups.forEach(alternatives => {
    const best = alternatives
      .map(words => {
        const orderedMatch = orderedPhraseMatch(words, responseWords);
        return {
          words,
          matched: orderedMatch ? words.length : overlapCount(words, responseWords)
        };
      })
      .sort((left, right) => right.matched / right.words.length - left.matched / left.words.length)[0];
    totalMatched += best.matched;
    totalExpected += best.words.length;
  });

  const similarity = totalExpected ? totalMatched / totalExpected : 0;
  if (similarity === 1) return 1;
  return similarity >= 0.5 ? 0.5 : 0;
}

export function shortAnswerMatches(expectedAnswer, studentResponse) {
  return shortAnswerMatchScore(expectedAnswer, studentResponse) === 1;
}
