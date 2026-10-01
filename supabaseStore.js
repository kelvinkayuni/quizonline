import { supabase } from './supabase.js';

let persistenceEnabled = false;
let syncQueue = Promise.resolve();
let pendingState = null;
let pendingOptions = {};
let syncTimer = null;
let syncResolvers = [];
const questionIdAliases = new Map();
const SUPABASE_REQUEST_TIMEOUT = 30000;
const QUIZ_ATTEMPT_DELETE_BATCH_SIZE = 100;
const deletedQuizAttemptIds = new Set();
const questionRowSaveQueues = new Map();

function withTimeout(request, operation) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${operation} timed out after ${SUPABASE_REQUEST_TIMEOUT / 1000} seconds.`)), SUPABASE_REQUEST_TIMEOUT);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timeoutId));
}

function attemptDataFromSession(studentSession) {
  return {
    questionOrderIds: (studentSession.questionOrder || []).map(question => question.id),
    index: Number(studentSession.index) || 0,
    selected: studentSession.selected ?? null,
    response: studentSession.response || '',
    feedback: studentSession.feedback || null,
    remaining: Number(studentSession.remaining) || 0,
    deadlineAt: studentSession.deadlineAt || null,
    started: Boolean(studentSession.started),
    answers: Array.isArray(studentSession.answers) ? studentSession.answers : [],
    updatedAt: studentSession.updatedAt || new Date().toISOString()
  };
}

export async function claimStudentAttempt(quizId, username, password, initialSession) {
  const { data, error } = await withTimeout(
    supabase.rpc('claim_quiz_active_attempt', {
      p_quiz_id: String(quizId),
      p_username: username,
      p_password: password,
      p_initial_data: initialSession ? attemptDataFromSession(initialSession) : null
    }),
    'Student attempt loading'
  );
  if (error) throw error;
  if (data?.completed && data.result) {
    return { completed: true, result: normalizeAttempt(data.result) };
  }
  if (!data || typeof data !== 'object' || typeof data.owner_token !== 'string'
    || !Number.isFinite(Number(data.generation))
    || !Number.isFinite(Number(data.revision))) {
    throw new Error('Supabase returned an invalid active-attempt record.');
  }
  return {
    generation: Number(data.generation),
    revision: Number(data.revision),
    ownerToken: data.owner_token,
    data: data.attempt_data || null
  };
}

export async function persistStudentAttempt(studentSession) {
  const attemptData = attemptDataFromSession(studentSession);
  const saveId = crypto.randomUUID();
  let expectedRevision = Number(studentSession.attemptRevision);
  let networkRetryUsed = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    let data;
    try {
      const result = await withTimeout(
        supabase.rpc('save_quiz_active_attempt', {
          p_quiz_id: String(studentSession.quizId),
          p_username: studentSession.username,
          p_generation: Number(studentSession.attemptGeneration),
          p_owner_token: studentSession.attemptOwnerToken,
          p_expected_revision: expectedRevision,
          p_save_id: saveId,
          p_attempt_data: attemptData
        }),
        'Student attempt save'
      );
      if (result.error) throw result.error;
      data = result.data;
    } catch (error) {
      if (networkRetryUsed) throw error;
      networkRetryUsed = true;
      attempt--;
      continue;
    }

    if (data?.saved) return Number(data.revision);
    if (data?.reason === 'claimed') {
      const saveError = new Error('This attempt was opened on another device. Sign in again here to load the latest saved progress.');
      saveError.code = 'claimed';
      throw saveError;
    }
    if (data?.reason !== 'revision' || !isSafeAttemptExtension(attemptData, data.attempt_data)) {
      const saveError = new Error('A newer progress version exists and cannot safely be merged. Keep this page open and sign in again to load the latest saved progress.');
      saveError.code = data?.reason || 'attempt_conflict';
      if (data?.reason === 'revision' && data.attempt_data) {
        saveError.remoteAttempt = data.attempt_data;
        saveError.remoteRevision = Number(data.revision);
      }
      throw saveError;
    }
    expectedRevision = Number(data.revision);
  }
  const saveError = new Error('Quiz progress changed repeatedly while saving. Keep this page open and retry.');
  saveError.code = 'attempt_conflict';
  throw saveError;
}

function isSafeAttemptExtension(localAttempt, remoteAttempt) {
  if (!remoteAttempt
    || JSON.stringify(localAttempt.questionOrderIds) !== JSON.stringify(remoteAttempt.questionOrderIds)
    || localAttempt.deadlineAt !== remoteAttempt.deadlineAt
    || Number(localAttempt.index) < Number(remoteAttempt.index)) return false;

  const localAnswers = Array.isArray(localAttempt.answers) ? localAttempt.answers : [];
  const remoteAnswers = Array.isArray(remoteAttempt.answers) ? remoteAttempt.answers : [];
  if (remoteAnswers.length > localAnswers.length
    || JSON.stringify(localAnswers.slice(0, remoteAnswers.length)) !== JSON.stringify(remoteAnswers)
    || Number(localAttempt.index) - Number(remoteAttempt.index) > localAnswers.length - remoteAnswers.length) return false;

  if (Number(localAttempt.index) === Number(remoteAttempt.index)) {
    if (remoteAttempt.selected != null && localAttempt.selected !== remoteAttempt.selected) return false;
    if (remoteAttempt.response && !String(localAttempt.response || '').startsWith(remoteAttempt.response)) return false;
    if (remoteAttempt.feedback
      && JSON.stringify(localAttempt.feedback) !== JSON.stringify(remoteAttempt.feedback)) return false;
  }
  return true;
}

export function reconcileStudentAttempt(localSession, remoteAttempt) {
  const localAttempt = attemptDataFromSession(localSession);
  if (!remoteAttempt?.started || !localAttempt.started) {
    return { attempt: remoteAttempt?.started ? remoteAttempt : localAttempt, conflict: false };
  }
  if (!localSession.attemptRequiresRemoteRestore && isSafeAttemptExtension(localAttempt, remoteAttempt)) {
    return { attempt: localAttempt, conflict: false };
  }
  if (isSafeAttemptExtension(remoteAttempt, localAttempt)) {
    return { attempt: remoteAttempt, conflict: false };
  }
  return { attempt: remoteAttempt, conflict: true };
}

export async function deleteStudentAttempt(studentSession) {
  const { data, error } = await withTimeout(
    supabase.rpc('delete_quiz_active_attempt', {
      p_quiz_id: String(studentSession.quizId),
      p_username: studentSession.username,
      p_generation: Number(studentSession.attemptGeneration),
      p_owner_token: studentSession.attemptOwnerToken
    }),
    'Completed student attempt cleanup'
  );
  if (error) throw error;
  if (!data?.deleted && !data?.missing) {
    throw new Error('A newer device has taken over this attempt, so its saved progress was kept.');
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
}

function reportError(operation, error) {
  const detail = [error?.message, error?.code, error?.details, error?.hint].filter(Boolean).join(' | ') || (error ? String(error) : 'No error details were provided.');
  console.warn(`Supabase ${operation} failed: ${detail}. Local data remains available.`, error);
  window.dispatchEvent(new CustomEvent('supabase-sync-error', { detail: { operation, error: { ...error, message: detail } } }));
}

function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toSupabaseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanCourseValue(value, legacyValue) {
  return String(value || '').trim() === legacyValue ? '' : String(value || '');
}

function latestActivityClearMarker(...markers) {
  return markers
    .filter(marker => marker && Number.isFinite(Date.parse(marker)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function filterActivityBeforeClear(activity, clearedAt) {
  const cutoff = Date.parse(clearedAt || '');
  const items = Array.isArray(activity) ? activity : [];
  return Number.isFinite(cutoff)
    ? items.filter(item => Number.isFinite(Date.parse(item.time || '')) && Date.parse(item.time || '') > cutoff)
    : items;
}

function normalizeQuestion(row) {
  return {
    id: row.id,
    text: row.text,
    type: row.type === 'short-answer' ? 'short-answer' : 'multiple-choice',
    choices: Array.isArray(row.choices) ? row.choices : [],
    correct: Number(row.correct) || 0,
    answer: String(row.answer || ''),
    referenceAnswer: String(row.reference_answer || ''),
    marks: Number(row.marks) || 1,
    metadataUpdatedAt: row.metadata_updated_at || ''
  };
}

function normalizeAttempt(row) {
  const answers = Array.isArray(row.answers) ? row.answers : [];
  const attempted = row.attempted ?? answers.length;
  const incorrect = row.incorrect ?? answers.filter(answer => !answer.correct && !answer.partial).length;
  const correct = row.correct ?? answers.filter(answer => answer.correct).length;
  const partial = answers.filter(answer => answer.partial).length;
  return {
    username: row.username,
    quizId: row.quiz_id || null,
    answers,
    attempted: Number(attempted) || 0,
    correct: Number(correct) || 0,
    incorrect: Number(incorrect) || 0,
    partial,
    score: Number(row.score) || 0,
    totalMarks: Number(row.total_marks) || 0,
    percentage: Number(row.percentage) || 0,
    durationMinutes: Number(row.duration_minutes) || 0,
    completedAt: row.completed_at
  };
}

export async function loadStudentQuizResult(username, quizId) {
  const { data, error } = await withTimeout(
    supabase.from('quiz_attempts')
      .select('*')
      .eq('username', username)
      .eq('quiz_id', quizId)
      .maybeSingle(),
    'Student completion check'
  );
  if (error) throw error;
  return data ? normalizeAttempt(data) : null;
}

export async function persistStudentQuizResult(result, studentSession) {
  if (!result?.username || !result.quizId
    || result.username !== studentSession?.username
    || result.quizId !== studentSession?.quizId
    || studentSession?.attemptGeneration == null
    || !studentSession.attemptOwnerToken) {
    throw new Error("The completed result does not match this device's claimed student attempt.");
  }
  const { data, error } = await withTimeout(
    supabase.rpc('complete_quiz_active_attempt', {
      p_quiz_id: String(result.quizId),
      p_username: result.username,
      p_generation: Number(studentSession.attemptGeneration),
      p_owner_token: studentSession.attemptOwnerToken,
      p_result: {
        username: result.username,
        quizId: result.quizId,
        answers: result.answers || [],
        score: result.score,
        totalMarks: result.totalMarks,
        percentage: result.percentage,
        completedAt: result.completedAt
      }
    }),
    'Completed quiz result save'
  );
  if (error) throw error;
  if (data?.reason === 'claimed') {
    const saveError = new Error('This attempt is active on another device. Its owner must finish and save the result.');
    saveError.code = 'claimed';
    throw saveError;
  }
  if (!data?.saved || !data.result) {
    throw new Error(data?.reason === 'missing'
      ? 'Supabase no longer has this active attempt, and no completed result exists.'
      : 'Supabase did not confirm the completed result for this student and quiz.');
  }
  return normalizeAttempt({
    ...data.result,
    total_marks: data.result.total_marks ?? data.result.totalMarks,
    completed_at: data.result.completed_at ?? data.result.completedAt
  });
}

export async function publishQuizAtomically(state, quizId) {
  const { data, error } = await withTimeout(
    supabase.rpc('publish_quiz_atomically', {
      p_quiz_id: quizId,
      p_quiz_config: {
        course_name: state.config.courseName || null,
        course_code: state.config.courseCode || null,
        total_questions: state.config.totalQuestions,
        duration: state.config.duration,
        start_time: toSupabaseTimestamp(state.config.start),
        end_time: toSupabaseTimestamp(state.config.end),
        quiz_id: quizId,
        published: true,
        stopped: false
      },
      p_question_snapshot: {
        quizId,
        questions: state.questions.map(questionForWorkspace)
      }
    }),
    'Atomic quiz publication'
  );
  if (error) throw error;
  if (data?.published !== true || data.quiz_id !== quizId) {
    throw new Error('Supabase did not confirm the atomic quiz publication.');
  }
}

function sameQuestionRow(left, right) {
  return left.text === right.text
    && Number(left.correct) === Number(right.correct)
    && Number(left.marks) === Number(right.marks)
    && JSON.stringify(left.choices || []) === JSON.stringify(right.choices || []);
}

function mergeUnconfirmedLocalQuestions(savedQuestions, localQuestions, confirmedLocalIds = new Set()) {
  const merged = savedQuestions.map(question => ({ ...question }));
  const claimedIndexes = new Set();

  localQuestions.forEach(localQuestion => {
    const index = merged.findIndex((savedQuestion, savedIndex) =>
      !claimedIndexes.has(savedIndex)
      && (savedQuestion.id === localQuestion.id
        || savedQuestion.id === localQuestion.localId
        || sameQuestionRow(savedQuestion, localQuestion))
    );

    if (index < 0) {
      merged.push({ ...localQuestion });
      return;
    }

    const savedQuestion = merged[index];
    claimedIndexes.add(index);
    localQuestion.id = savedQuestion.id;
    const isConfirmed = confirmedLocalIds.has(localQuestion.localId)
      || confirmedLocalIds.has(localQuestion.id)
      || confirmedLocalIds.has(savedQuestion.id);
    merged[index] = {
      ...savedQuestion,
      ...localQuestion,
      id: savedQuestion.id,
      ...(isConfirmed ? { syncStatus: 'saved', syncError: '' } : {})
    };
  });

  return merged;
}

function confirmedLocalQuestionIds(localQuestions, questionRows, snapshot, expectedQuizId) {
  const confirmedIds = new Set();
  if (snapshot?.quizId !== expectedQuizId || !Array.isArray(snapshot.questions)) return confirmedIds;
  const claimedRemoteIds = new Set();

  localQuestions.forEach(localQuestion => {
    const savedRow = questionRows.find(row =>
      !claimedRemoteIds.has(row.id)
      && (row.id === localQuestion.id || row.id === localQuestion.localId || sameQuestionRow(row, localQuestion))
      && sameQuestionRow(row, localQuestion)
    );
    if (!savedRow) return;

    const snapshotQuestion = snapshot.questions.find(question => question.id === savedRow.id);
    if (!snapshotQuestion || !sameQuestionRow(snapshotQuestion, localQuestion)) return;
    if (localQuestion.type === 'short-answer') {
      if (snapshotQuestion.type !== 'short-answer' || String(snapshotQuestion.answer || '') !== String(localQuestion.answer || '')) return;
    } else if (snapshotQuestion.type === 'short-answer') {
      return;
    }

    claimedRemoteIds.add(savedRow.id);
    confirmedIds.add(localQuestion.localId || localQuestion.id);
    confirmedIds.add(localQuestion.id);
    confirmedIds.add(savedRow.id);
  });

  return confirmedIds;
}

function questionForWorkspace(question) {
  const { localId, syncVersion, syncStatus, syncError, ...savedQuestion } = question;
  return savedQuestion;
}

function mergeQuestionBank(localQuestions, remoteQuestions) {
  const remoteById = new Map(remoteQuestions.map(question => [question.id, question]));
  return localQuestions.map(question => {
    const remoteQuestion = remoteById.get(question.id);
    if (!remoteQuestion) return questionForWorkspace(question);
    const localVersion = Date.parse(question.metadataUpdatedAt || '') || 0;
    const remoteVersion = Date.parse(remoteQuestion.metadataUpdatedAt || '') || 0;
    return questionForWorkspace(remoteVersion > localVersion
      ? { ...question, ...remoteQuestion, id: question.id }
      : question);
  });
}

function restoreQuestionMetadata(questions, ...metadataSources) {
  const savedById = new Map(metadataSources.flat().map(question => [question.id, question]));
  return questions.map(question => {
    const savedQuestion = savedById.get(question.id);
    if (!savedQuestion) return question;
    const rowVersion = Date.parse(question.metadataUpdatedAt || '') || 0;
    const metadataVersion = Date.parse(savedQuestion.metadataUpdatedAt || '') || 0;
    const metadataIsNewer = metadataVersion > rowVersion
      || (!rowVersion && !metadataVersion && savedQuestion.type === 'short-answer');
    return metadataIsNewer
      ? { ...question, ...savedQuestion, id: question.id }
      : { ...savedQuestion, ...question, id: question.id };
  });
}

export async function hydrateQuizState(state, role = 'teacher', persist = true, username = '') {
  const unconfirmedLocalQuestions = role === 'teacher'
    ? state.questions.filter(question => question.syncStatus === 'pending' || question.syncStatus === 'failed')
    : [];
  let questionsResult;
  let configResult;
  let attemptsResult;
  let workspaceResult;
  if (role === 'student') {
    state.results = [];
    state.studentHistory = [];
    state.resultFiles = [];
  }
  try {
    const attemptsRequest = supabase.from('quiz_attempts').select('*').order('completed_at', { ascending: false });
    if (role === 'student') attemptsRequest.eq('username', username);
    [questionsResult, configResult, attemptsResult, workspaceResult] = await Promise.all([
      withTimeout(supabase.from('questions').select('*').order('created_at'), 'Question loading'),
      withTimeout(supabase.from('quiz_config').select('*').eq('id', 1).maybeSingle(), 'Configuration loading'),
      withTimeout(attemptsRequest, 'Result loading'),
      withTimeout(supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle(), 'Workspace loading')
    ]);
  } catch (error) {
    persistenceEnabled = true;
    reportError('initial synchronization', error);
    return;
  }

  if (!questionsResult.error) {
    state.questions = mergeUnconfirmedLocalQuestions(
      questionsResult.data.map(normalizeQuestion),
      unconfirmedLocalQuestions
    );
  } else {
    reportError('question loading', questionsResult.error);
  }

  if (!configResult.error && configResult.data) {
    const config = configResult.data;
    state.config = {
      courseName: cleanCourseValue(config.course_name, 'Course'),
      courseCode: cleanCourseValue(config.course_code, '34'),
      totalQuestions: Number(config.total_questions) || 0,
      duration: Number(config.duration) || 0,
      start: toDateTimeLocal(config.start_time),
      end: toDateTimeLocal(config.end_time)
    };
    state.currentQuizId = config.quiz_id ?? null;
    state.quizStopped = Boolean(config.stopped);
    state.questionsPublished = Boolean(config.published) && !state.quizStopped;
  } else if (configResult.error) reportError('configuration loading', configResult.error);

  if (!attemptsResult.error) {
    state.results = attemptsResult.data.map(normalizeAttempt);
    state.studentHistory = [...state.results];
  } else reportError('result loading', attemptsResult.error);

  if (!workspaceResult.error && workspaceResult.data?.data) {
    const workspace = workspaceResult.data.data;
    const remoteQuestionRows = !questionsResult.error ? questionsResult.data : [];
    const workspaceQuestionSnapshot = workspace.currentQuizQuestions;
    const expectedSnapshotQuizId = configResult.data?.quiz_id ?? null;
    const confirmedLocalIds = confirmedLocalQuestionIds(
      unconfirmedLocalQuestions,
      remoteQuestionRows,
      workspaceQuestionSnapshot,
      expectedSnapshotQuizId
    );
    const previousConfigResetAt = state.configResetAt || '';
    const storedResultFiles = Array.isArray(workspace.resultFiles) ? workspace.resultFiles : [];
    const cleanedResultFiles = storedResultFiles.map(({ questions, ...file }) => file);
    state.users = Array.isArray(workspace.users) ? workspace.users : state.users;
    if (!configResult.data) {
      state.config.courseName = cleanCourseValue(workspace.courseName || state.config.courseName || '', 'Course');
      state.config.courseCode = cleanCourseValue(workspace.courseCode || state.config.courseCode || '', '34');
    }
    state.importedFile = workspace.importedFile || null;
    state.studentLoginActive = Boolean(workspace.studentLoginActive);
    state.studentQuestionOrders = workspace.studentQuestionOrders && typeof workspace.studentQuestionOrders === 'object' ? workspace.studentQuestionOrders : state.studentQuestionOrders;
    state.configSaved = configResult.data
      ? Boolean(Number(configResult.data.duration) || configResult.data.start_time || configResult.data.end_time)
      : Boolean(workspace.configSaved);
    state.deletedQuizIds = Array.isArray(workspace.deletedQuizIds) ? workspace.deletedQuizIds : state.deletedQuizIds;
    state.resultFiles = Array.isArray(workspace.resultFiles) ? cleanedResultFiles : state.resultFiles;
    state.activityClearedAt = latestActivityClearMarker(state.activityClearedAt, workspace.activityClearedAt);
    state.activity = filterActivityBeforeClear(
      Array.isArray(workspace.activity) ? workspace.activity : state.activity,
      state.activityClearedAt
    );
    state.healthClearedAt = workspace.healthClearedAt || null;
    state.configResetAt = workspace.configResetAt || state.configResetAt || '';
    if (state.configResetAt && state.configResetAt !== previousConfigResetAt) delete state.drafts.config;
    const snapshotQuestions = workspace.currentQuizQuestions?.questions;
    state.questions = restoreQuestionMetadata(
      state.questions,
      Array.isArray(snapshotQuestions) ? snapshotQuestions : [],
      Array.isArray(workspace.questionBank) ? workspace.questionBank : []
    );
    if (workspace.currentQuizQuestions?.quizId === state.currentQuizId && Array.isArray(snapshotQuestions)) {
      state.questions = mergeUnconfirmedLocalQuestions(
        restoreQuestionMetadata(
          snapshotQuestions.map(normalizeQuestion),
          snapshotQuestions,
          Array.isArray(workspace.questionBank) ? workspace.questionBank : []
        ),
        unconfirmedLocalQuestions,
        confirmedLocalIds
      );
    }
    if (storedResultFiles.some(file => Array.isArray(file.questions))) {
      const cleanupResult = await supabase.from('quiz_workspace').update({ data: { ...workspace, resultFiles: cleanedResultFiles }, updated_at: new Date().toISOString() }).eq('id', 1);
      if (cleanupResult.error) reportError('result file cleanup', cleanupResult.error);
    }
  } else if (workspaceResult.error) reportError('workspace loading', workspaceResult.error);

  const deletedQuizIds = new Set(state.deletedQuizIds);
  state.results = state.results.filter(result => !result.quizId || !deletedQuizIds.has(result.quizId));
  state.studentHistory = state.studentHistory.filter(result => !result.quizId || !deletedQuizIds.has(result.quizId));
  const attemptsByQuiz = new Map();
  state.results.forEach(result => {
    if (!result.quizId) return;
    const rows = attemptsByQuiz.get(result.quizId) || [];
    rows.push(result);
    attemptsByQuiz.set(result.quizId, rows);
  });
  attemptsByQuiz.forEach((rows, quizId) => {
    if (state.deletedQuizIds.includes(quizId)) return;
    const fileId = `quiz-${quizId}`;
    const existingFile = state.resultFiles.find(file => file.id === fileId);
    if (existingFile) {
      existingFile.rows = rows;
      return;
    }
    state.resultFiles.push({
      id: fileId,
      name: `online-quiz-results-${new Date(rows[0].completedAt || Date.now()).toISOString().slice(0, 10)}`,
      createdAt: rows[0].completedAt || new Date().toISOString(),
      rows
    });
  });

  persistenceEnabled = true;
  if (persist) await persistQuizState(state, role);
}

export function persistMultipleChoiceQuestionToSupabase(question, localId) {
  const saveKey = localId || question?.id;
  if (!saveKey) return Promise.reject(new Error('The multiple-choice question has no save identifier.'));

  const previousSave = questionRowSaveQueues.get(saveKey) || Promise.resolve();
  const operation = previousSave.then(async () => {
    if (!question || question.type === 'short-answer') {
      throw new Error('A multiple-choice question is required for this save operation.');
    }

    const remoteId = questionIdAliases.get(saveKey) || (isUuid(question.id) ? question.id : null);
    const payload = {
      text: question.text,
      choices: question.choices || [],
      correct: question.correct,
      marks: question.marks,
      type: 'multiple-choice',
      answer: '',
      reference_answer: '',
      metadata_updated_at: question.metadataUpdatedAt || new Date().toISOString()
    };
    let result = remoteId
      ? await withTimeout(
        supabase.from('questions').update(payload).eq('id', remoteId).select('id').maybeSingle(),
        'Multiple-choice question save'
      )
      : await withTimeout(
        supabase.from('questions').insert(payload).select('id').maybeSingle(),
        'Multiple-choice question save'
      );
    if (result.error) throw result.error;
    if (!result.data?.id && remoteId) {
      result = await withTimeout(
        supabase.from('questions').insert(payload).select('id').maybeSingle(),
        'Multiple-choice question recovery'
      );
      if (result.error) throw result.error;
    }

    if (!result.data?.id) {
      throw new Error('Supabase did not confirm the multiple-choice question row.');
    }
    questionIdAliases.set(saveKey, result.data.id);
    return result.data.id;
  });
  const settledOperation = operation.then(() => undefined, () => undefined);
  questionRowSaveQueues.set(saveKey, settledOperation);
  void settledOperation.then(() => {
    if (questionRowSaveQueues.get(saveKey) === settledOperation) {
      questionRowSaveQueues.delete(saveKey);
    }
  });
  return operation;
}

export function persistShortAnswerQuestionToSupabase(question, localId) {
  const saveKey = localId || question?.id;
  if (!saveKey) return Promise.reject(new Error('The short-answer question has no save identifier.'));
  if (!question || question.type !== 'short-answer') {
    return Promise.reject(new Error('A short-answer question is required for this save operation.'));
  }

  const previousSave = questionRowSaveQueues.get(saveKey) || Promise.resolve();
  const operation = previousSave.then(async () => {
    const remoteId = questionIdAliases.get(saveKey) || (isUuid(question.id) ? question.id : null);
    const payload = {
      text: question.text,
      choices: [],
      correct: 0,
      marks: question.marks,
      type: 'short-answer',
      answer: question.answer || '',
      reference_answer: question.referenceAnswer || '',
      metadata_updated_at: question.metadataUpdatedAt || new Date().toISOString()
    };
    let result = remoteId
      ? await withTimeout(
        supabase.from('questions').update(payload).eq('id', remoteId).select('id').maybeSingle(),
        'Short-answer question save'
      )
      : await withTimeout(
        supabase.from('questions').insert(payload).select('id').maybeSingle(),
        'Short-answer question save'
      );
    if (result.error) throw result.error;
    if (!result.data?.id && remoteId) {
      result = await withTimeout(
        supabase.from('questions').insert(payload).select('id').maybeSingle(),
        'Short-answer question recovery'
      );
      if (result.error) throw result.error;
    }
    if (!result.data?.id) {
      throw new Error('Supabase did not confirm the short-answer question row.');
    }
    questionIdAliases.set(saveKey, result.data.id);
    return result.data.id;
  });
  const settledOperation = operation.then(() => undefined, () => undefined);
  questionRowSaveQueues.set(saveKey, settledOperation);
  void settledOperation.then(() => {
    if (questionRowSaveQueues.get(saveKey) === settledOperation) {
      questionRowSaveQueues.delete(saveKey);
    }
  });
  return operation;
}

export function deleteQuestionFromSupabase(questionId, saveKey, totalQuestions, activityItem) {
  if (!questionId) return Promise.reject(new Error('The question has no deletion identifier.'));
  const pendingSave = questionRowSaveQueues.get(saveKey) || Promise.resolve();
  const operation = syncQueue.then(async () => {
    await pendingSave;
    const remoteId = questionIdAliases.get(saveKey) || questionId;
    const { data, error } = await withTimeout(
      supabase.rpc('delete_question_atomically', {
        p_question_id: remoteId,
        p_total_questions: totalQuestions,
        p_activity_item: activityItem
      }),
      'Question deletion'
    );
    if (error) throw error;
    if (data?.deleted !== true
      || data.question_id !== remoteId
      || Number(data.remaining_question_count) < 0
      || data.quiz_id !== null
      || data.published !== false
      || data.stopped !== false) {
      throw new Error('Supabase did not confirm the atomic question deletion.');
    }
    questionIdAliases.delete(saveKey);
    return data;
  });
  syncQueue = operation.catch(() => {});
  return operation;
}

export function persistActivityClear(state, clearedAt) {
  const operation = syncQueue.then(async () => {
    const workspaceResult = await withTimeout(
      supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle(),
      'Activity clear workspace loading'
    );
    if (workspaceResult.error) throw workspaceResult.error;

    const workspace = workspaceResult.data?.data || {};
    const activityClearedAt = latestActivityClearMarker(
      clearedAt,
      state.activityClearedAt,
      workspace.activityClearedAt
    );
    const activity = filterActivityBeforeClear(state.activity, activityClearedAt);
    const savedResult = await withTimeout(
      supabase.from('quiz_workspace').upsert({
        id: 1,
        data: { ...workspace, activity, activityClearedAt },
        updated_at: new Date().toISOString()
      }).select('data').single(),
      'Activity clear synchronization'
    );
    if (savedResult.error) throw savedResult.error;
    if (savedResult.data?.data?.activityClearedAt !== activityClearedAt
      || !Array.isArray(savedResult.data?.data?.activity)
      || savedResult.data.data.activity.some(item => {
        const itemTime = Date.parse(item.time || '');
        return !Number.isFinite(itemTime) || itemTime <= Date.parse(activityClearedAt);
      })) {
      throw new Error('Supabase did not confirm the cleared activity state.');
    }
    return activityClearedAt;
  });
  syncQueue = operation.catch(() => {});
  return operation;
}

export function persistQuizState(state, role = 'teacher', options = {}) {
  pendingState = state;
  pendingOptions = { ...options };
  if (!persistenceEnabled) return syncQueue;
  clearTimeout(syncTimer);
  let resolveSync;
  let rejectSync;
  const syncComplete = new Promise((resolve, reject) => {
    resolveSync = resolve;
    rejectSync = reject;
  });
  if (options.waitForSync) {
    setTimeout(() => rejectSync(new Error(`Supabase synchronization timed out after ${SUPABASE_REQUEST_TIMEOUT / 1000} seconds.`)), SUPABASE_REQUEST_TIMEOUT);
  }
  syncResolvers.push({ resolve: resolveSync, reject: rejectSync, waitForSync: Boolean(options.waitForSync) });
  syncTimer = setTimeout(() => {
    const stateToPersist = pendingState;
    const optionsToPersist = pendingOptions;
    pendingOptions = {};
    syncQueue = syncQueue.then(async () => {
      if (!stateToPersist) return;
      if (role === 'student') {
        const workspaceResult = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
        if (workspaceResult.error) {
          reportError('student workspace loading', workspaceResult.error);
          if (optionsToPersist.waitForSync) throw workspaceResult.error;
          return;
        }
        const workspace = workspaceResult.data?.data || {};
        const deletedQuizIds = Array.isArray(workspace.deletedQuizIds) ? workspace.deletedQuizIds : [];
        const existingFiles = Array.isArray(workspace.resultFiles) ? workspace.resultFiles : [];
        const filesById = new Map(existingFiles.map(file => [file.id, file]));
        for (const file of stateToPersist.resultFiles || []) {
          if (file.id?.startsWith('quiz-') && deletedQuizIds.includes(file.id.slice(5))) continue;
          filesById.set(file.id, { ...file, rows: Array.isArray(file.rows) ? file.rows : [] });
        }
        const resultFileUpdate = await supabase.from('quiz_workspace').upsert({
          id: 1,
          data: { ...workspace, resultFiles: [...filesById.values()], studentQuestionOrders: { ...(workspace.studentQuestionOrders || {}), ...(stateToPersist.studentQuestionOrders || {}) } },
          updated_at: new Date().toISOString()
        }).select('data').single();
        if (resultFileUpdate.error) {
          reportError('student workspace synchronization', resultFileUpdate.error);
          if (optionsToPersist.waitForSync) throw resultFileUpdate.error;
        }
        return;
      }
    if (optionsToPersist.workspaceOnly) {
      const latestWorkspaceResult = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
      if (latestWorkspaceResult.error) {
        reportError('workspace loading before synchronization', latestWorkspaceResult.error);
        if (optionsToPersist.waitForSync) throw latestWorkspaceResult.error;
        return;
      }
      const latestWorkspace = latestWorkspaceResult.data?.data || {};
      const questionBank = mergeQuestionBank(
        stateToPersist.questions,
        Array.isArray(latestWorkspace.questionBank) ? latestWorkspace.questionBank : []
      );
      const workspaceResult = await supabase.from('quiz_workspace').upsert({
        id: 1,
        data: {
          ...latestWorkspace,
          questionBank,
          courseName: stateToPersist.config.courseName || '',
          courseCode: stateToPersist.config.courseCode || '',
          users: stateToPersist.users,
          importedFile: stateToPersist.importedFile,
          studentLoginActive: stateToPersist.studentLoginActive,
          studentQuestionOrders: stateToPersist.studentQuestionOrders,
          configSaved: Boolean(stateToPersist.configSaved),
          resultFiles: stateToPersist.resultFiles,
          deletedQuizIds: stateToPersist.deletedQuizIds,
          activity: stateToPersist.activity,
          healthClearedAt: stateToPersist.healthClearedAt,
          configResetAt: stateToPersist.configResetAt
        },
        updated_at: new Date().toISOString()
      });
      if (workspaceResult.error) {
        reportError('workspace synchronization', workspaceResult.error);
        if (optionsToPersist.waitForSync) throw workspaceResult.error;
      }
      return;
    }
    const pendingQuizAttemptDeletes = [...new Set(stateToPersist.deletedQuizIds || [])]
      .filter(quizId => quizId && !deletedQuizAttemptIds.has(quizId));
    for (let offset = 0; offset < pendingQuizAttemptDeletes.length; offset += QUIZ_ATTEMPT_DELETE_BATCH_SIZE) {
      const quizIds = pendingQuizAttemptDeletes.slice(offset, offset + QUIZ_ATTEMPT_DELETE_BATCH_SIZE);
      const deletedAttempts = await supabase.from('quiz_attempts').delete().in('quiz_id', quizIds);
      if (deletedAttempts.error) {
        reportError('quiz record deletion', deletedAttempts.error);
        if (optionsToPersist.waitForSync) throw deletedAttempts.error;
      } else {
        quizIds.forEach(quizId => deletedQuizAttemptIds.add(quizId));
      }
    }
    const existingQuestions = await supabase.from('questions').select('id');
    if (existingQuestions.error) {
      reportError('question synchronization', existingQuestions.error);
      if (optionsToPersist.waitForSync) throw existingQuestions.error;
      return;
    }

    const savedIds = new Set();
    let questionSyncFailed = false;
    for (const question of state.questions) {
      const payload = {
        text: question.text,
        choices: question.choices || [],
        correct: question.correct,
        marks: question.marks,
        type: question.type === 'short-answer' ? 'short-answer' : 'multiple-choice',
        answer: question.type === 'short-answer' ? question.answer || '' : '',
        reference_answer: question.type === 'short-answer' ? question.referenceAnswer || '' : '',
        metadata_updated_at: question.metadataUpdatedAt || new Date().toISOString()
      };
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        result = isUuid(question.id)
          ? await supabase.from('questions').update(payload).eq('id', question.id).select('id')
          : await supabase.from('questions').insert(payload).select('id');
        if (!result.error && (result.data?.length || !isUuid(question.id))) break;
      }

      if (result.error) {
        questionSyncFailed = true;
        reportError('question synchronization', result.error);
        if (optionsToPersist.waitForSync) throw result.error;
        continue;
      }
      if (!result.data?.length && isUuid(question.id)) {
        result = await supabase.from('questions').insert(payload).select('id');
        if (result.error) {
          questionSyncFailed = true;
          reportError('question recovery', result.error);
          if (optionsToPersist.waitForSync) throw result.error;
          continue;
        }
      }
      const savedQuestion = result.data?.[0];
      if (!savedQuestion?.id) {
        questionSyncFailed = true;
        const error = new Error('Supabase did not return a saved question ID.');
        reportError('question synchronization', error);
        if (optionsToPersist.waitForSync) throw error;
        continue;
      }
      question.id = savedQuestion.id;
      savedIds.add(savedQuestion.id);
    }

    const staleIds = existingQuestions.data.map(row => row.id).filter(id => !savedIds.has(id));
    if (staleIds.length && !questionSyncFailed) {
      const result = await supabase.from('questions').delete().in('id', staleIds);
      if (result.error) {
        reportError('question deletion', result.error);
        if (optionsToPersist.waitForSync) throw result.error;
      }
    }

    const configResult = optionsToPersist.skipConfig ? null : await supabase.from('quiz_config').upsert({
      id: 1,
      course_name: state.config.courseName || null,
      course_code: state.config.courseCode || null,
      total_questions: state.config.totalQuestions,
      duration: state.config.duration,
      start_time: toSupabaseTimestamp(state.config.start),
      end_time: toSupabaseTimestamp(state.config.end),
      quiz_id: state.currentQuizId,
      published: state.questionsPublished,
      stopped: state.quizStopped
    });
    if (configResult?.error) {
      reportError('configuration synchronization', configResult.error);
      if (optionsToPersist.waitForSync) throw configResult.error;
    }

    const latestWorkspaceResult = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
    if (latestWorkspaceResult.error) {
      reportError('workspace loading before synchronization', latestWorkspaceResult.error);
      if (optionsToPersist.waitForSync) throw latestWorkspaceResult.error;
    }
    const latestWorkspace = latestWorkspaceResult.data?.data || {};
    const questionBank = mergeQuestionBank(
      stateToPersist.questions,
      Array.isArray(latestWorkspace.questionBank)
        ? latestWorkspace.questionBank
        : Array.isArray(latestWorkspace.currentQuizQuestions?.questions)
          ? latestWorkspace.currentQuizQuestions.questions
          : []
    );
    const deletedQuizIds = new Set([...(latestWorkspace.deletedQuizIds || []), ...(stateToPersist.deletedQuizIds || [])]);
    const resultFilesById = new Map();
    for (const file of latestWorkspace.resultFiles || []) {
      if (!file.id?.startsWith('quiz-') || !deletedQuizIds.has(file.id.slice(5))) resultFilesById.set(file.id, file);
    }
    for (const file of stateToPersist.resultFiles || []) {
      if (!file.id?.startsWith('quiz-') || !deletedQuizIds.has(file.id.slice(5))) resultFilesById.set(file.id, file);
    }
    const questionSnapshot = {
      quizId: stateToPersist.currentQuizId,
      questions: questionBank
    };
    const workspaceResult = await supabase.from('quiz_workspace').upsert({
      id: 1,
      data: {
        ...latestWorkspace,
        courseName: stateToPersist.config.courseName || '',
        courseCode: stateToPersist.config.courseCode || '',
        questionBank,
        currentQuizQuestions: questionSnapshot,
        users: stateToPersist.users,
        importedFile: stateToPersist.importedFile,
        studentLoginActive: stateToPersist.studentLoginActive,
        studentQuestionOrders: stateToPersist.studentQuestionOrders,
        configSaved: Boolean(stateToPersist.configSaved),
        resultFiles: [...resultFilesById.values()],
        deletedQuizIds: [...deletedQuizIds],
        activity: stateToPersist.activity,
        healthClearedAt: stateToPersist.healthClearedAt,
        configResetAt: stateToPersist.configResetAt
      },
      updated_at: new Date().toISOString()
    });
    if (workspaceResult.error) {
      reportError('workspace synchronization', workspaceResult.error);
      if (optionsToPersist.waitForSync) throw workspaceResult.error;
    }

    for (const result of state.results) {
      if (!result.quizId) continue;
      const attemptResult = await supabase.from('quiz_attempts').upsert({
        username: result.username,
        quiz_id: result.quizId || state.currentQuizId,
        answers: result.answers || [],
        score: result.score,
        total_marks: result.totalMarks,
        percentage: result.percentage,
        completed_at: result.completedAt
      }, { onConflict: 'username,quiz_id', ignoreDuplicates: true });
      if (attemptResult.error) reportError('result synchronization', attemptResult.error);
    }
    }).catch(error => {
      const requests = syncResolvers;
      syncResolvers = [];
      requests.forEach(request => {
        if (request.waitForSync) request.reject(error);
        else reportError('synchronization', error);
      });
    }).finally(() => {
      const resolvers = syncResolvers;
      syncResolvers = [];
      resolvers.forEach(request => request.resolve());
    });
  }, options.waitForSync ? 0 : 250);

  return syncComplete;
}

export async function deleteQuizAttempts(quizIds) {
  const ids = [...new Set((quizIds || []).filter(Boolean))];
  if (!ids.length) return;

  const deleteResult = await withTimeout(
    supabase.from('quiz_attempts').delete().in('quiz_id', ids),
    'Result deletion'
  );
  if (deleteResult.error) throw deleteResult.error;

  const verifyResult = await withTimeout(
    supabase.from('quiz_attempts').select('quiz_id').in('quiz_id', ids),
    'Result deletion verification'
  );
  if (verifyResult.error) throw verifyResult.error;
  if (verifyResult.data?.length) throw new Error('Supabase still contains result records for the cleared quizzes.');
  ids.forEach(quizId => deletedQuizAttemptIds.add(quizId));
}
