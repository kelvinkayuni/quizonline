import { supabase } from './supabase.js';

let persistenceEnabled = false;
let syncQueue = Promise.resolve();
let pendingState = null;
let pendingOptions = {};
let syncTimer = null;
let syncResolvers = [];

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
}

function reportError(operation, error) {
  const detail = error?.message || String(error);
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

function normalizeQuestion(row) {
  return {
    id: row.id,
    text: row.text,
    choices: Array.isArray(row.choices) ? row.choices : [],
    correct: Number(row.correct) || 0,
    marks: Number(row.marks) || 1
  };
}

function normalizeAttempt(row) {
  const answers = Array.isArray(row.answers) ? row.answers : [];
  const attempted = row.attempted ?? answers.length;
  const incorrect = row.incorrect ?? answers.filter(answer => !answer.correct).length;
  return {
    username: row.username,
    quizId: row.quiz_id || null,
    answers,
    attempted: Number(attempted) || 0,
    correct: Number(row.correct) || Math.max(0, attempted - incorrect),
    incorrect: Number(incorrect) || 0,
    score: Number(row.score) || 0,
    totalMarks: Number(row.total_marks) || 0,
    percentage: Number(row.percentage) || 0,
    durationMinutes: Number(row.duration_minutes) || 0,
    completedAt: row.completed_at
  };
}

export async function hydrateQuizState(state, role = 'teacher', persist = true) {
  const [questionsResult, configResult, attemptsResult, workspaceResult] = await Promise.all([
    supabase.from('questions').select('*').order('created_at'),
    supabase.from('quiz_config').select('*').eq('id', 1).maybeSingle(),
    supabase.from('quiz_attempts').select('*').order('completed_at', { ascending: false }),
    supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle()
  ]);

  if (!questionsResult.error) state.questions = questionsResult.data.map(normalizeQuestion);
  else reportError('question loading', questionsResult.error);

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
    const storedResultFiles = Array.isArray(workspace.resultFiles) ? workspace.resultFiles : [];
    const cleanedResultFiles = storedResultFiles.map(({ questions, ...file }) => file);
    state.users = Array.isArray(workspace.users) ? workspace.users : state.users;
    if (!configResult.data) {
      state.config.courseName = cleanCourseValue(workspace.courseName || state.config.courseName || '', 'Course');
      state.config.courseCode = cleanCourseValue(workspace.courseCode || state.config.courseCode || '', '34');
    }
    state.importedFile = workspace.importedFile || null;
    state.studentLoginActive = Boolean(workspace.studentLoginActive);
    state.configSaved = typeof workspace.configSaved === 'boolean'
      ? workspace.configSaved
      : Boolean(configResult.data && (Number(configResult.data.total_questions) || Number(configResult.data.duration) || configResult.data.start_time || configResult.data.end_time));
    state.deletedQuizIds = Array.isArray(workspace.deletedQuizIds) ? workspace.deletedQuizIds : state.deletedQuizIds;
    state.resultFiles = Array.isArray(workspace.resultFiles) ? cleanedResultFiles : state.resultFiles;
    state.activity = Array.isArray(workspace.activity) ? workspace.activity : state.activity;
    state.healthClearedAt = workspace.healthClearedAt || null;
    if (role === 'student' && workspace.currentQuizQuestions?.quizId === state.currentQuizId && Array.isArray(workspace.currentQuizQuestions.questions)) {
      state.questions = workspace.currentQuizQuestions.questions.map(normalizeQuestion);
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
  syncResolvers.push({ resolve: resolveSync, reject: rejectSync, waitForSync: Boolean(options.waitForSync) });
  syncTimer = setTimeout(() => {
    const stateToPersist = pendingState;
    const optionsToPersist = pendingOptions;
    pendingOptions = {};
    syncQueue = syncQueue.then(async () => {
      if (!stateToPersist) return;
      if (role === 'student') {
        for (const result of stateToPersist.results) {
          const attemptResult = await supabase.from('quiz_attempts').upsert({
            username: result.username,
            quiz_id: result.quizId || null,
            answers: result.answers || [],
            score: result.score,
            total_marks: result.totalMarks,
            percentage: result.percentage,
            completed_at: result.completedAt
          }, { onConflict: 'username,quiz_id' });
          if (attemptResult.error) reportError('result synchronization', attemptResult.error);
        }
        const workspaceResult = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
        if (workspaceResult.error) return reportError('result file loading', workspaceResult.error);
        const workspace = workspaceResult.data?.data || {};
        const deletedQuizIds = Array.isArray(workspace.deletedQuizIds) ? workspace.deletedQuizIds : [];
        const existingFiles = Array.isArray(workspace.resultFiles) ? workspace.resultFiles : [];
        const filesById = new Map(existingFiles.map(file => [file.id, file]));
        for (const file of stateToPersist.resultFiles || []) {
          if (file.id?.startsWith('quiz-') && deletedQuizIds.includes(file.id.slice(5))) continue;
          filesById.set(file.id, { ...file, rows: Array.isArray(file.rows) ? file.rows : [] });
        }
        const resultFileUpdate = await supabase.from('quiz_workspace').update({
          data: { ...workspace, resultFiles: [...filesById.values()] },
          updated_at: new Date().toISOString()
        }).eq('id', 1);
        if (resultFileUpdate.error) reportError('result file synchronization', resultFileUpdate.error);
        return;
      }
    for (const quizId of stateToPersist.deletedQuizIds || []) {
      const deletedAttempts = await supabase.from('quiz_attempts').delete().eq('quiz_id', quizId);
      if (deletedAttempts.error) {
        reportError('quiz record deletion', deletedAttempts.error);
        if (optionsToPersist.waitForSync) throw deletedAttempts.error;
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
      const payload = { text: question.text, choices: question.choices, correct: question.correct, marks: question.marks };
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
      if (result.error) reportError('question deletion', result.error);
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
      questions: stateToPersist.questions.map(question => ({ ...question }))
    };
    const snapshotResult = await supabase.from('quiz_workspace').upsert({
      id: 1,
      data: { ...latestWorkspace, currentQuizQuestions: questionSnapshot },
      updated_at: new Date().toISOString()
    });
    if (snapshotResult.error) {
      reportError('question snapshot synchronization', snapshotResult.error);
      if (optionsToPersist.waitForSync) throw snapshotResult.error;
    }
    const workspaceResult = await supabase.from('quiz_workspace').upsert({
      id: 1,
      data: {
        ...latestWorkspace,
        courseName: stateToPersist.config.courseName || '',
        courseCode: stateToPersist.config.courseCode || '',
        currentQuizQuestions: questionSnapshot,
        users: stateToPersist.users,
        importedFile: stateToPersist.importedFile,
        studentLoginActive: stateToPersist.studentLoginActive,
        configSaved: Boolean(stateToPersist.configSaved),
        resultFiles: [...resultFilesById.values()],
        deletedQuizIds: [...deletedQuizIds],
        activity: stateToPersist.activity,
        healthClearedAt: stateToPersist.healthClearedAt
      },
      updated_at: new Date().toISOString()
    });
    if (workspaceResult.error) {
      reportError('workspace synchronization', workspaceResult.error);
      if (optionsToPersist.waitForSync) throw workspaceResult.error;
    }

    for (const result of state.results) {
      const attemptResult = await supabase.from('quiz_attempts').upsert({
        username: result.username,
        quiz_id: result.quizId || state.currentQuizId,
        answers: result.answers || [],
        score: result.score,
        total_marks: result.totalMarks,
        percentage: result.percentage,
        completed_at: result.completedAt
      }, { onConflict: 'username,quiz_id' });
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
  }, optionsToPersist.waitForSync ? 0 : 250);

  return syncComplete;
}
