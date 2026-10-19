import { createClient } from '@supabase/supabase-js';
import { compareSemanticText, trainSemanticModel } from '../semanticModel.js';

const TEACHER_EMAIL = 'kelvinkayuni13@gmail.com';
const MODEL_DOCUMENT_LIMIT = 500;
const RESPONSE_CHARACTER_LIMIT = 10000;
let cachedModelSignature = '';
let cachedModel = null;

function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error('The protected Cartographer scorer is not configured.');
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

async function queryResult(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

function modelSignature(documents, glossary, pairs) {
  return JSON.stringify({
    documents: documents.map(document => [document.id, document.created_at]),
    glossary: glossary.map(entry => [entry.id, entry.alias, entry.canonical_term]),
    pairs: pairs.map(pair => [pair.word_a, pair.word_b, pair.negative_form, pair.base_word])
  });
}

async function loadTeacher(client) {
  const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const teachers = (data.users || []).filter(user =>
    user.email?.toLowerCase() === TEACHER_EMAIL
      && user.app_metadata?.role === 'teacher'
  );
  if (teachers.length !== 1) throw new Error('The Cartographer teacher account could not be resolved.');
  return teachers[0];
}

async function loadSemanticModel(client, ownerId) {
  const [documents, glossary, pairs] = await Promise.all([
    queryResult(client.from('semantic_cartographer_documents')
      .select('id, name, text_content, created_at')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(MODEL_DOCUMENT_LIMIT)),
    queryResult(client.from('semantic_cartographer_glossary')
      .select('id, alias, canonical_term')
      .eq('owner_id', ownerId)
      .order('alias')),
    queryResult(client.from('semantic_cartographer_non_similar_pairs')
      .select('word_a, word_b, negative_form, base_word')
      .eq('owner_id', ownerId)
      .order('word_a'))
  ]);
  const signature = modelSignature(documents, glossary, pairs);
  if (!cachedModel || cachedModelSignature !== signature) {
    const negationRules = pairs.filter(pair => pair.negative_form && pair.base_word);
    cachedModel = {
      model: trainSemanticModel(documents, glossary, negationRules),
      negationRules,
      nonSimilarPairs: pairs.filter(pair => !pair.negative_form || !pair.base_word)
    };
    cachedModelSignature = signature;
  }
  return cachedModel;
}

function requestBody(body) {
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
  if (typeof body === 'string') return JSON.parse(body);
  return body && typeof body === 'object' ? body : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  let input;
  try {
    input = requestBody(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid request body.' });
  }
  if (!input) return res.status(400).json({ error: 'Invalid request body.' });

  const quizId = String(input.quizId || '');
  const username = String(input.username || '');
  const questionId = String(input.questionId || '');
  const response = String(input.response || '').trim();
  const ownerToken = String(input.attemptOwnerToken || '');
  const generation = Number(input.attemptGeneration);
  if (!quizId || !username || !questionId || !response || response.length > RESPONSE_CHARACTER_LIMIT
    || !ownerToken || !Number.isSafeInteger(generation)) {
    return res.status(400).json({ error: 'Required scoring information is missing or invalid.' });
  }

  try {
    const client = createServerClient();
    const [teacher, config, workspace, attempt] = await Promise.all([
      loadTeacher(client),
      queryResult(client.from('quiz_config')
        .select('quiz_id, published, stopped, end_time')
        .eq('id', 1)
        .maybeSingle()),
      queryResult(client.from('quiz_workspace').select('data').eq('id', 1).maybeSingle()),
      queryResult(client.from('quiz_active_attempts')
        .select('generation, owner_token, attempt_data')
        .eq('quiz_id', quizId)
        .eq('username', username)
        .maybeSingle())
    ]);

    if (!config?.published || config.stopped || config.quiz_id !== quizId
      || (config.end_time && Date.parse(config.end_time) < Date.now())) {
      return res.status(409).json({ error: 'This quiz is no longer active.' });
    }
    if (!attempt || Number(attempt.generation) !== generation || attempt.owner_token !== ownerToken) {
      return res.status(403).json({ error: 'The active attempt could not be verified.' });
    }
    const assignedQuestionIds = attempt.attempt_data?.questionOrderIds;
    if (!Array.isArray(assignedQuestionIds) || !assignedQuestionIds.some(id => String(id) === questionId)) {
      return res.status(403).json({ error: 'This question is not part of the active attempt.' });
    }

    const snapshot = workspace?.data?.currentQuizQuestions;
    if (snapshot?.quizId !== quizId || !Array.isArray(snapshot.questions)) {
      return res.status(409).json({ error: 'The published question snapshot is unavailable.' });
    }
    const question = snapshot.questions.find(item => String(item.id) === questionId);
    if (question?.type !== 'short-answer' || typeof question.answer !== 'string') {
      return res.status(400).json({ error: 'The requested question is not a published short-answer question.' });
    }

    const { model, negationRules, nonSimilarPairs } = await loadSemanticModel(client, teacher.id);
    const result = compareSemanticText(model, response, question.answer, negationRules, nonSimilarPairs);
    if (!Number.isFinite(result.score) || !Number.isFinite(result.coverage)) {
      throw new Error('Cartographer returned an invalid comparison.');
    }
    return res.status(200).json({ score: result.score, coverage: result.coverage });
  } catch (error) {
    console.error('Protected Cartographer scoring failed:', error?.message || 'unknown error');
    return res.status(503).json({ error: 'Cartographer scoring is unavailable.' });
  }
}