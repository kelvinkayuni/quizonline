import assert from 'node:assert/strict';
import test from 'node:test';
import { getAttemptConflictReason } from '../studentAttemptReconciliation.js';

const matchingAttempt = {
  questionOrderIds: ['q1', 'q2'],
  deadlineAt: '2026-10-16T12:00:00.000Z',
  index: 1,
  answers: [{ questionId: 'q1', selected: 0 }],
  selected: null,
  response: '',
  feedback: null
};

test('matching attempt progress is mergeable', () => {
  assert.equal(getAttemptConflictReason(matchingAttempt, { ...matchingAttempt }), null);
});

test('reconciliation identifies order and deadline mismatches', () => {
  assert.equal(getAttemptConflictReason(matchingAttempt, { ...matchingAttempt, questionOrderIds: ['q2', 'q1'] }), 'question_order_mismatch');
  assert.equal(getAttemptConflictReason(matchingAttempt, { ...matchingAttempt, deadlineAt: '2026-10-16T12:01:00.000Z' }), 'deadline_mismatch');
});

test('reconciliation identifies progress and answer-history mismatches', () => {
  assert.equal(getAttemptConflictReason({ ...matchingAttempt, index: 0, answers: [] }, matchingAttempt), 'local_progress_behind');
  assert.equal(getAttemptConflictReason(matchingAttempt, { ...matchingAttempt, answers: [...matchingAttempt.answers, { questionId: 'q2' }] }), 'remote_has_more_answers');
  assert.equal(getAttemptConflictReason(matchingAttempt, { ...matchingAttempt, answers: [{ questionId: 'q1', selected: 1 }] }), 'answer_history_mismatch');
  assert.equal(getAttemptConflictReason({ ...matchingAttempt, index: 2 }, matchingAttempt), 'progress_gap');
});

test('answer history ignores object key order but preserves values and array order', () => {
  const localAnswer = { questionId: 'q1', selected: 0, correct: true, partial: false, marksAwarded: 2 };
  const reorderedAnswer = { marksAwarded: 2, partial: false, correct: true, selected: 0, questionId: 'q1' };
  assert.equal(getAttemptConflictReason({ ...matchingAttempt, answers: [localAnswer] }, { ...matchingAttempt, answers: [reorderedAnswer] }), null);
  assert.equal(getAttemptConflictReason({ ...matchingAttempt, answers: [localAnswer] }, { ...matchingAttempt, answers: [{ ...reorderedAnswer, selected: 1 }] }), 'answer_history_mismatch');

  const secondAnswer = { questionId: 'q2', selected: 1, correct: false };
  assert.equal(getAttemptConflictReason(
    { ...matchingAttempt, index: 2, answers: [localAnswer, secondAnswer] },
    { ...matchingAttempt, index: 2, answers: [secondAnswer, localAnswer] }
  ), 'answer_history_mismatch');
});

test('reconciliation identifies current answer and feedback mismatches without exposing answer text', () => {
  assert.equal(getAttemptConflictReason({ ...matchingAttempt, selected: 1 }, { ...matchingAttempt, selected: 0 }), 'selection_mismatch');
  assert.equal(getAttemptConflictReason({ ...matchingAttempt, response: 'different text' }, { ...matchingAttempt, response: 'saved text' }), 'response_mismatch');
  assert.equal(getAttemptConflictReason({ ...matchingAttempt, feedback: { correct: false } }, { ...matchingAttempt, feedback: { correct: true } }), 'feedback_mismatch');
});