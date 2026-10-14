const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ensureQuestionPersistenceId(question) {
  if (!question || typeof question !== 'object') {
    throw new Error('A question is required before it can be saved.');
  }
  if (!UUID_PATTERN.test(String(question.id || ''))) {
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      throw new Error('Secure question ID generation is unavailable in this browser.');
    }
    question.id = globalThis.crypto.randomUUID();
  }
  return question.id;
}

export function getPublishedQuestionSnapshot(config, workspace) {
  const snapshot = workspace?.currentQuizQuestions;
  if (!config?.published || config.stopped || !config.quiz_id
    || snapshot?.quizId !== config.quiz_id || !Array.isArray(snapshot.questions)) {
    return null;
  }
  return snapshot.questions;
}