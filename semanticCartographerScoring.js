import { roundToOneDecimal } from './shortAnswerMatching.js';

export function semanticCartographerMarksAwarded(similarity, totalMarks) {
  const score = Number(similarity);
  const marks = Math.max(0, roundToOneDecimal(totalMarks));
  if (!Number.isFinite(score) || score < 0 || score > 100 || marks === 0 || score < 30) return 0;
  if (score >= 80) return marks;
  return Math.min(marks, roundToOneDecimal(marks * score / 100));
}