import { roundToOneDecimal } from './shortAnswerMatching.js';

export function hasSubmittedShortAnswer(questionDetails = []) {
  return questionDetails.some(detail => detail.questionType === 'short-answer' && detail.submitted);
}

export function prepareShortAnswerReviewMarks(questionDetails, entries) {
  const questions = questionDetails.filter(detail => detail.questionType === 'short-answer' && detail.submitted);
  if (!questions.length) throw new Error('This result has no submitted short answers to review.');
  if (!Array.isArray(entries) || entries.length !== questions.length) {
    throw new Error('Enter a teacher mark for every submitted short-answer response.');
  }

  const marksByQuestionId = new Map();
  for (const entry of entries) {
    const questionId = String(entry?.questionId || '');
    const question = questions.find(detail => detail.questionId === questionId);
    const marks = Number(entry?.marksAwarded);
    if (!question || marksByQuestionId.has(questionId)) {
      throw new Error('The review contains a missing or repeated question.');
    }
    if (!Number.isFinite(marks) || marks < 0 || marks > Number(question.marksPossible)) {
      throw new Error('Teacher marks must be between zero and the question maximum.');
    }
    marksByQuestionId.set(questionId, roundToOneDecimal(marks));
  }

  return questions.map(question => ({
    questionId: question.questionId,
    marksAwarded: marksByQuestionId.get(question.questionId)
  }));
}

export function applyShortAnswerReviewMarks(questionDetails, entries) {
  const reviewMarks = prepareShortAnswerReviewMarks(questionDetails, entries);
  const marksByQuestionId = new Map(reviewMarks.map(entry => [entry.questionId, entry.marksAwarded]));
  return questionDetails.map(detail => {
    const marksAwarded = marksByQuestionId.get(detail.questionId);
    if (marksAwarded === undefined) return detail;
    return {
      ...detail,
      suggestedMarksAwarded: detail.suggestedMarksAwarded ?? detail.marksAwarded,
      teacherMarksAwarded: marksAwarded,
      marksAwarded,
      teacherReviewed: true
    };
  });
}