function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJsonValue(value[key])]));
}

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
  if (JSON.stringify(stableJsonValue(localAnswers.slice(0, remoteAnswers.length))) !== JSON.stringify(stableJsonValue(remoteAnswers))) return 'answer_history_mismatch';
  if (localIndex - remoteIndex > localAnswers.length - remoteAnswers.length) return 'progress_gap';

  if (localIndex === remoteIndex) {
    if (remoteAttempt.selected != null && localAttempt.selected !== remoteAttempt.selected) return 'selection_mismatch';
    if (remoteAttempt.response && !String(localAttempt.response || '').startsWith(remoteAttempt.response)) return 'response_mismatch';
  }
  return null;
}