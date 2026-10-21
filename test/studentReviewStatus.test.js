import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFinalizedStudentHistory, pendingStudentQuizIds } from '../studentReviewStatus.js';

test('selects all distinct pending quiz results belonging to the signed-in student', () => {
  assert.deepEqual(pendingStudentQuizIds([
    { username: 'student-a', quizId: 'quiz-1', reviewStatus: 'provisional' },
    { username: 'student-a', quizId: 'quiz-1', reviewStatus: 'provisional' },
    { username: 'student-a', quizId: 'quiz-2', reviewStatus: 'final' },
    { username: 'student-b', quizId: 'quiz-3', reviewStatus: 'provisional' },
    { username: 'student-a', reviewStatus: 'provisional' }
  ], 'student-a'), ['quiz-1']);
});

test('updates finalized history results and leaves still-pending or other-student results unchanged', () => {
  const history = [
    { username: 'student-a', quizId: 'older-quiz', reviewStatus: 'provisional', score: 5 },
    { username: 'student-a', quizId: 'newer-quiz', reviewStatus: 'provisional', score: 7 },
    { username: 'student-b', quizId: 'other-quiz', reviewStatus: 'provisional', score: 3 }
  ];
  const finalized = {
    username: 'student-a',
    quizId: 'older-quiz',
    reviewStatus: 'final',
    score: 8
  };

  assert.deepEqual(
    mergeFinalizedStudentHistory(history, 'student-a', [finalized]),
    [
      finalized,
      history[1],
      history[2]
    ]
  );
});
