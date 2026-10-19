import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShortAnswerReviewMarks, hasSubmittedShortAnswer, prepareShortAnswerReviewMarks } from '../shortAnswerReview.js';

const questionDetails = [
  { questionId: 'mc-1', questionType: 'multiple-choice', submitted: true, marksPossible: 2, marksAwarded: 2 },
  { questionId: 'sa-1', questionType: 'short-answer', submitted: true, marksPossible: 5, marksAwarded: 3.2 },
  { questionId: 'sa-2', questionType: 'short-answer', submitted: true, marksPossible: 4, marksAwarded: 0 },
  { questionId: 'sa-3', questionType: 'short-answer', submitted: false, marksPossible: 4, marksAwarded: 0 }
];

test('only results with submitted short answers require teacher review', () => {
  assert.equal(hasSubmittedShortAnswer(questionDetails), true);
  assert.equal(hasSubmittedShortAnswer([questionDetails[0]]), false);
  assert.equal(hasSubmittedShortAnswer([questionDetails[3]]), false);
});

test('teacher review requires one bounded mark for each submitted short answer', () => {
  assert.deepEqual(prepareShortAnswerReviewMarks(questionDetails, [
    { questionId: 'sa-1', marksAwarded: 4.26 },
    { questionId: 'sa-2', marksAwarded: 2 }
  ]), [
    { questionId: 'sa-1', marksAwarded: 4.3 },
    { questionId: 'sa-2', marksAwarded: 2 }
  ]);
  assert.throws(() => prepareShortAnswerReviewMarks(questionDetails, []), /every submitted short-answer/);
  assert.throws(() => prepareShortAnswerReviewMarks(questionDetails, [
    { questionId: 'sa-1', marksAwarded: 3 },
    { questionId: 'sa-1', marksAwarded: 3 }
  ]), /missing or repeated/);
  assert.throws(() => prepareShortAnswerReviewMarks(questionDetails, [
    { questionId: 'sa-1', marksAwarded: 6 },
    { questionId: 'sa-2', marksAwarded: 1 }
  ]), /between zero and the question maximum/);
});

test('teacher corrections preserve the original suggestion and leave other answers unchanged', () => {
  const reviewed = applyShortAnswerReviewMarks(questionDetails, [
    { questionId: 'sa-1', marksAwarded: 5 },
    { questionId: 'sa-2', marksAwarded: 0 }
  ]);
  assert.equal(reviewed[0], questionDetails[0]);
  assert.equal(reviewed[1].suggestedMarksAwarded, 3.2);
  assert.equal(reviewed[1].teacherMarksAwarded, 5);
  assert.equal(reviewed[1].marksAwarded, 5);
  assert.equal(reviewed[1].teacherReviewed, true);
  assert.equal(reviewed[2].marksAwarded, 0);
  assert.equal(reviewed[3], questionDetails[3]);
});