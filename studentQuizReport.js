export function studentQuizQuestionReportLines(question) {
  if (question.questionType === 'short-answer') {
    return [
      'Question type: Short answer',
      `Your answer: ${question.studentAnswer || 'Not answered'}`,
      `Teacher answer: ${question.teacherAnswer || question.teacherReferenceAnswer || 'Not provided'}`,
      `Teacher expected concepts: ${question.teacherExpectedAnswer || question.teacherExpectedConcept || 'Not available'}`
    ];
  }

  const lines = ['Question type: Multiple choice'];
  const choices = Array.isArray(question.choices) ? question.choices : [];
  choices.forEach((choice, index) => {
    lines.push(`${String.fromCharCode(65 + index)}. ${choice}`);
  });

  const correctChoice = question.teacherCorrectChoice
    ? `${question.teacherCorrectChoice}. ${question.teacherAnswer || ''}`.trim()
    : question.teacherAnswer || 'Not available';
  const studentChoice = question.studentChoice
    ? `${question.studentChoice}. ${question.studentAnswer || ''}`.trim()
    : question.studentAnswer || 'Not answered';
  lines.push(`Correct choice: ${correctChoice}`);
  lines.push(`Your choice: ${studentChoice}`);
  return lines;
}
