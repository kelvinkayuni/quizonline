import assert from 'node:assert/strict';
import test from 'node:test';
import { studentQuizQuestionReportLines } from '../studentQuizReport.js';

test('multiple-choice report includes choices, correct choice, student choice, and fallback for unanswered', () => {
  assert.deepEqual(studentQuizQuestionReportLines({
    questionType: 'multiple-choice',
    choices: ['First option', 'Second option', 'Third option'],
    teacherCorrectChoice: 'B',
    teacherAnswer: 'Second option',
    studentChoice: 'C',
    studentAnswer: 'Third option'
  }), [
    'Question type: Multiple choice',
    'A. First option',
    'B. Second option',
    'C. Third option',
    'Correct choice: B. Second option',
    'Your choice: C. Third option'
  ]);
  assert.deepEqual(studentQuizQuestionReportLines({
    questionType: 'multiple-choice',
    choices: [],
    teacherAnswer: 'Correct option',
    studentAnswer: 'Not answered'
  }), [
    'Question type: Multiple choice',
    'Correct choice: Correct option',
    'Your choice: Not answered'
  ]);
});

test('short-answer report is labeled and keeps teacher answer and expected concepts', () => {
  assert.deepEqual(studentQuizQuestionReportLines({
    questionType: 'short-answer',
    studentAnswer: 'My response',
    teacherAnswer: 'Teacher reference',
    teacherExpectedAnswer: 'Concept one; concept two'
  }), [
    'Question type: Short answer',
    'Your answer: My response',
    'Teacher answer: Teacher reference',
    'Teacher expected concepts: Concept one; concept two'
  ]);
});
