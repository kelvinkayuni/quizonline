export function pendingStudentQuizIds(history, username) {
  return [...new Set(history
    .filter(result => result.username === username
      && result.reviewStatus === 'provisional'
      && result.quizId)
    .map(result => result.quizId))];
}

export function mergeFinalizedStudentHistory(history, username, finalizedResults) {
  const finalizedByQuizId = new Map(finalizedResults
    .filter(result => result.username === username && result.reviewStatus === 'final')
    .map(result => [result.quizId, result]));
  return history.map(result => (
    result.username === username && finalizedByQuizId.has(result.quizId)
      ? finalizedByQuizId.get(result.quizId)
      : result
  ));
}
