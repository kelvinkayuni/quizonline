import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureQuestionPersistenceId, getPublishedQuestionSnapshot, normalizeQuestionType } from '../questionPersistence.js';

test('question save retries keep the same stable UUID', () => {
  const question = { id: 'local-question-1' };

  const firstId = ensureQuestionPersistenceId(question);
  const retryId = ensureQuestionPersistenceId(question);

  assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(retryId, firstId);
});

test('question save preserves an existing Supabase UUID', () => {
  const question = { id: '9e8e85d7-783d-41d6-89ae-fc694615a196' };

  assert.equal(ensureQuestionPersistenceId(question), question.id);
});

test('question type defaults to multiple-choice for legacy drafts', () => {
  assert.equal(normalizeQuestionType(undefined), 'multiple-choice');
  assert.equal(normalizeQuestionType(''), 'multiple-choice');
  assert.equal(normalizeQuestionType('multiple-choice'), 'multiple-choice');
  assert.equal(normalizeQuestionType('short-answer'), 'short-answer');
  assert.throws(() => normalizeQuestionType('unsupported'), /supported question type/);
});

test('student questions come only from the matching published snapshot', () => {
  const snapshot = [{ id: 'published-question' }];
  const workspace = { currentQuizQuestions: { quizId: 'quiz-a', questions: snapshot } };

  assert.equal(getPublishedQuestionSnapshot({ quiz_id: 'quiz-a', published: true, stopped: false }, workspace), snapshot);
  assert.equal(getPublishedQuestionSnapshot({ quiz_id: 'quiz-b', published: true, stopped: false }, workspace), null);
  assert.equal(getPublishedQuestionSnapshot({ quiz_id: 'quiz-a', published: false, stopped: false }, workspace), null);
  assert.equal(getPublishedQuestionSnapshot({ quiz_id: 'quiz-a', published: true, stopped: true }, workspace), null);
});