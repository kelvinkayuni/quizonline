export function getAttemptConflictReason(localAttempt, remoteAttempt) {
  if (!remoteAttempt) return 'remote_attempt_missing';
  if (JSON.stringify(localAttempt.questionOrderIds) !== JSON.stringify(remoteAttempt.questionOrderIds)) return 'question_order_mismatch';
  if (localAttempt.deadlineAt !== remoteAttempt.deadlineAt) return 'deadline_mismatch';

  const localIndex = Number(localAttempt.index) || 0;
  const remoteIndex = Number(remoteAttempt.index) || 0;
  if (localIndex < remoteIndex) return 'local_progress_behind';

  const localAnswers = Array.isArray(localAttempt.answers) ? localAttempt.answers : [];
  const remoteAnswers = Array.isArray(remoteAttempt.answers) ? remoteAttempt.answers : [];
  if (remoteAnswers.length > localAnswers.length) return 'remote_has_more_answers';
  if (JSON.stringify(localAnswers.slice(0, remoteAnswers.length)) !== JSON.stringify(remoteAnswers)) return 'answer_history_mismatch';
  if (localIndex - remoteIndex > localAnswers.length - remoteAnswers.length) return 'progress_gap';

  if (localIndex === remoteIndex) {
    if (remoteAttempt.selected != null && localAttempt.selected !== remoteAttempt.selected) return 'selection_mismatch';
    if (remoteAttempt.response && !String(localAttempt.response || '').startsWith(remoteAttempt.response)) return 'response_mismatch';
    if (remoteAttempt.feedback && JSON.stringify(localAttempt.feedback) !== JSON.stringify(remoteAttempt.feedback)) return 'feedback_mismatch';
  }
  return null;
}