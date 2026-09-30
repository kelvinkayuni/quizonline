function courseDisplayValue(value) { const normalized = String(value || '').trim(); return normalized === '34' || normalized.toLowerCase() === 'course' ? '' : normalized; }
function studentCourseDetails() { const courseName = courseDisplayValue(state.config.courseName); const courseCode = courseDisplayValue(state.config.courseCode); return courseName || courseCode ? `<div class="course-banner">${courseName ? `<strong>${esc(courseName)}</strong>` : ''}${courseCode ? `<span class="badge">${esc(courseCode)}</span>` : ''}</div>` : ''; }
import { supabase } from './supabase.js';
import { deleteQuizAttempts, hydrateQuizState, persistActivityClear, persistQuestionToSupabase, persistQuizState } from './supabaseStore.js';
import { loadLiveStudentUsernames, markStudentOffline, markStudentOnline, markStudentsOffline } from './supabasePresence.js';
import { shortAnswerMatchScore } from './shortAnswerMatching.js';

async function refreshStudentQuizState() {
  if (!session || session.role !== 'student') return;
  let configResult;
  let workspaceResult;
  try {
    [configResult, workspaceResult] = await Promise.all([
      supabase.from('quiz_config').select('quiz_id, published, stopped').eq('id', 1).maybeSingle(),
      supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle()
    ]);
  } catch {
    return;
  }
  if (configResult.error || workspaceResult.error) return;
  return refreshStudentQuizStateRaw();
}

async function stopQuizForEveryone() {
  if (!state.questionsPublished || !state.currentQuizId || teacherMutationInFlight) return;
  teacherMutationInFlight = true;
    const stoppedQuizId = state.currentQuizId;
  try {
    const controlResult = await supabase.from('quiz_config').upsert({
      id: 1,
      course_name: state.config.courseName || null,
      course_code: state.config.courseCode || null,
        total_questions: 0,
      duration: 0,
      start_time: null,
      end_time: null,
      quiz_id: null,
      published: false,
      stopped: true
    });
    if (controlResult.error) throw controlResult.error;
    let confirmed = false;
    for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
      const { data, error } = await supabase.from('quiz_config').select('quiz_id, published, stopped').eq('id', 1).maybeSingle();
      if (error) throw error;
      confirmed = Boolean(data && data.stopped && !data.published && !data.quiz_id);
    }
    if (!confirmed) throw new Error('Supabase did not confirm the stopped quiz state after three checks.');

    state.quizStopped = true;
    state.questionsPublished = false;
    state.currentQuizId = null;
    state.configSaved = false;
    state.config = { ...state.config, totalQuestions: 0, duration: 0, start: '', end: '' };
    Object.keys(state.studentSessions).forEach(username => delete state.studentSessions[username]);
    state.activity.unshift({ text: 'Quiz stopped for all students and its records were removed', type: 'results', time: new Date().toISOString() });
    state.activity = state.activity.slice(0, 20);
    saveState();
      let cleanupPending = false;
      try {
        await persistQuizState(state, 'teacher', { waitForSync: true });
      } catch (error) {
        cleanupPending = true;
      }
    showToast(cleanupPending ? 'Quiz stopped. Student results are still synchronizing.' : 'Quiz stopped. Active student attempts will be saved and students can no longer continue.');
  } catch (error) {
    showToast(`Quiz stop could not be confirmed: ${error.message || error}`);
  } finally {
    teacherMutationInFlight = false;
    app();
  }
}

async function expireQuizDueToTime() {
  if (!state.questionsPublished || !state.currentQuizId || teacherMutationInFlight || !quizHasEnded()) return;
  teacherMutationInFlight = true;
  try {
    const activeSessions = Object.values(state.studentSessions || {}).filter(studentSession => studentSession && studentSession.quizId === state.currentQuizId && !studentSession.completed);

    for (const studentSession of activeSessions) {
      const result = finalizeStudentResult(studentSession, true);
      studentSession.completed = true;
      studentSession.result = result;
    }

    state.questionsPublished = false;
    state.quizStopped = true;
    state.currentQuizId = null;
    state.configSaved = false;
    state.studentSessions = {};
    state.config = {
      courseName: state.config.courseName || '',
      courseCode: state.config.courseCode || '',
      totalQuestions: 0,
      duration: 0,
      start: '',
      end: ''
    };
    saveState();
    await persistQuizControlState();
    await persistQuizState(state, 'teacher', { waitForSync: true });
    await confirmSavedConfiguration(false);
    showToast('Quiz ended. All active student attempts were finalized and saved before the quiz was closed.');
  } catch (error) {
    showToast(`Quiz ended, but result finalization could not be confirmed: ${error.message || error}`);
  } finally {
    teacherMutationInFlight = false;
    app();
  }
}

async function saveConfig(event) {
  event.preventDefault();
  if (state.configSaved) return showToast('The time set is already saved.');
  if (teacherMutationInFlight) return;
  const data = new FormData(event.target);
  const duration = Number(data.get('duration'));
  if (!Number.isFinite(duration) || duration < 1) return showToast('Duration must be at least 1 minute.');
  const start = String(data.get('start') || '');
  const end = String(data.get('end') || '');
  if (end && new Date(end).getTime() <= Date.now()) return showToast('End date & time must be in the future.');
  if (start && end && new Date(end).getTime() <= new Date(start).getTime()) return showToast('End date & time must be after the start date & time.');
  const wasEnded = quizHasEnded();
  const expiredPublishedQuiz = wasEnded && state.questionsPublished && !state.quizStopped;
  teacherMutationInFlight = true;
  try {
    state.config = { courseName: state.config.courseName || '', courseCode: state.config.courseCode || '', totalQuestions: state.questions.length, duration, start, end };
    state.configSaved = true;
    if (expiredPublishedQuiz) {
      state.currentQuizId = null;
      state.questionsPublished = false;
      state.quizStopped = false;
      state.studentSessions = {};
      state.healthClearedAt = null;
    } else {
      Object.values(state.studentSessions).forEach(studentSession => { if (!studentSession.started) studentSession.remaining = Math.max(60, state.config.duration * 60); });
    }
    delete state.drafts.config;
    saveState({ localOnly: true });
    await persistQuizState(state, 'teacher', { waitForSync: true });
    await persistQuizControlState();
    await confirmSavedConfiguration({
      ...state.config,
      currentQuizId: state.currentQuizId,
      questionsPublished: state.questionsPublished,
      quizStopped: state.quizStopped
    });
    addActivity(expiredPublishedQuiz ? 'Expired quiz questions are ready as a new draft' : 'Quiz configuration was updated', 'settings');
    showToast(expiredPublishedQuiz ? 'Configuration saved. Submit the saved questions to create the new quiz.' : 'Quiz configuration saved.');
  } catch (error) {
    state.configSaved = false;
    saveState();
    showToast(`Configuration could not be saved: ${error.message || error}`);
  } finally {
    teacherMutationInFlight = false;
    app();
  }
}

const STORAGE_KEY = 'online-quiz-state-v1';
const APP_USERNAME = __APP_USERNAME__;
const APP_PASSWORD = __APP_PASSWORD__;
const TEACHER = { username: APP_USERNAME, password: APP_PASSWORD };
const defaultState = {
  questions: [],
  questionsPublished: false,
  quizStopped: false,
  users: [],
  results: [],
  resultFiles: [],
  studentHistory: [],
  studentSessions: {},
  studentQuestionOrders: {},
  deletedQuizIds: [],
  drafts: {},
  currentQuizId: null,
  healthClearedAt: null,
  importedFile: null,
  studentLoginActive: false,
  configSaved: false,
  config: { courseName: '', courseCode: '', totalQuestions: 0, duration: 0, start: '', end: '' },
  activity: [],
  activityClearedAt: null
};
let session = null;
let state = loadState();
let stateHydrated = false;
let stateHydrationPromise = null;
if (!state.drafts) state.drafts = {};
if (!state.studentSessions) state.studentSessions = {};
if (!state.studentQuestionOrders) state.studentQuestionOrders = {};
if (!Array.isArray(state.deletedQuizIds)) state.deletedQuizIds = [];
if (typeof state.quizStopped !== 'boolean') state.quizStopped = false;
if (typeof state.studentLoginActive !== 'boolean') state.studentLoginActive = false;
if (typeof state.configSaved !== 'boolean') state.configSaved = false;
if (!state.importedFile) { state.users = []; saveState(); }
let teacherView = 'overview';
let timerId = null;
let editingQuestionId = null;
let expandedQuestionIds = new Set();
let selectedResultFileId = null;
let persistenceTimer = null;
let liveRefreshTimer = null;
let teacherDeadlineTimer = null;
let teacherMutationInFlight = false;
let studentHeartbeatTimer = null;
let studentQuizRefreshTimer = null;
let presenceWindowBound = false;
const SESSION_KEY = 'online-quiz-window-session-v1';
function cleanLiveCourseValue(value, legacyValue) { return String(value || '').trim() === legacyValue ? '' : String(value || ''); }

function saveWindowSession() { if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); else sessionStorage.removeItem(SESSION_KEY); }
function restoreWindowSession() { try { const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); return saved && (saved.role === 'teacher' || saved.role === 'student') ? saved : null; } catch { return null; } }
if (!Array.isArray(state.studentHistory)) state.studentHistory = [];
if (state.results.length && !state.studentHistory.length) {
  state.studentHistory = state.results.map(result => ({ ...result, correct: result.correct ?? Math.max(0, result.attempted - result.incorrect), durationMinutes: result.durationMinutes || 0 }));
  saveState();
}

if (!Array.isArray(state.resultFiles)) state.resultFiles = [];
if (state.resultFiles.some(file => Array.isArray(file.questions))) {
  state.resultFiles = state.resultFiles.map(({ questions, ...file }) => file);
  saveState();
}

function loadState() {
  try {
    const saved = { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    if (saved.config?.courseName === 'Course') saved.config.courseName = '';
    if (saved.config?.courseCode === '34') saved.config.courseCode = '';
    saved.activity = filterActivityBeforeClear(saved.activity, saved.activityClearedAt);
    return saved;
  } catch { return structuredClone(defaultState); }
}
function filterActivityBeforeClear(activity, clearedAt) { const cutoff = Date.parse(clearedAt || ''); const items = Array.isArray(activity) ? activity : []; return Number.isFinite(cutoff) ? items.filter(item => Number.isFinite(Date.parse(item.time || '')) && Date.parse(item.time || '') > cutoff) : items; }
function stateForLocalStorage() { if (session?.role !== 'student') return state; return { ...state, results: [], studentHistory: [], resultFiles: [] }; }
function saveState(options = {}) { localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage())); if (!options.localOnly) persistQuizState(state, session?.role, options); }
function restoreState(snapshot) { state = snapshot; localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function saveTeacherDraft(form) { const values = {}; form.querySelectorAll('input, textarea, select').forEach(field => { if (!field.name) return; if (values[field.name] === undefined) values[field.name] = field.value; else values[field.name] = Array.isArray(values[field.name]) ? [...values[field.name], field.value] : [values[field.name], field.value]; }); state.drafts[teacherView] = values; saveState({ localOnly: form.id === 'question-form' || form.id === 'short-answer-form' }); }
function restoreTeacherDrafts() { const draft = state.drafts[teacherView]; if (!draft) return; document.querySelectorAll('#question-form input, #question-form textarea, #question-form select, #config-form input, #config-form select').forEach(field => { const stored = draft[field.name]; if (stored === undefined) return; const index = [...document.querySelectorAll(`[name="${field.name}"]`)].indexOf(field); field.value = Array.isArray(stored) ? (stored[index] || '') : stored; }); }
function saveStudentSession() { if (session?.role === 'student' && !session.completed) { state.studentSessions[session.username] = { ...session }; saveState(); } }
function clearStudentSession(username) { delete state.studentSessions[username]; saveState(); }
function esc(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char])); }
function formatDate(value) { if (!value) return 'Not scheduled'; return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function toDateTimeLocal(value) { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; const pad = number => String(number).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function normalizeQuestion(row) { return { id: row.id, text: row.text, choices: Array.isArray(row.choices) ? row.choices : [], correct: Number(row.correct) || 0, marks: Number(row.marks) || 1 }; }
function shuffleQuestions(questions, seed = '') { const shuffled = [...questions]; let hash = 2166136261; for (const character of `${seed}:${state.currentQuizId || ''}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); for (let index = shuffled.length - 1; index > 0; index--) { hash = Math.imul(hash ^ (hash >>> 13), 16777619); const swapIndex = (hash >>> 0) % (index + 1); [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]; } return shuffled; }
function quizIsLocked() { return Boolean(state.questionsPublished && !state.quizStopped && !quizHasEnded()); }
function quizHasEnded() { return Boolean(state.config.end && Date.now() >= new Date(state.config.end).getTime()); }
function quizHasNotStarted() { return Boolean(state.config.start && Date.now() < new Date(state.config.start).getTime()); }
function showToast(message, type = 'info') { const toast = document.querySelector('#toast'); const isError = type === 'error' || /failed|could not|unable|error|timed out|not confirmed/i.test(message); toast.textContent = message; toast.classList.toggle('error', isError); toast.classList.add('show'); clearTimeout(showToast.timeout); showToast.timeout = setTimeout(() => toast.classList.remove('show'), isError ? 8000 : 2800); }
window.addEventListener('supabase-sync-error', event => { const operation = event.detail?.operation || 'synchronization'; const message = event.detail?.error?.message || 'Check your Supabase table policies and network connection.'; showToast(`Supabase ${operation} failed: ${message}`, 'error'); });
function icon(name) { return ({ grid: '▦', question: '?', settings: '⚙', users: '♙', results: '↗', logout: '↪', plus: '+', upload: '↑', download: '↓', clock: '◷', check: '✓', pulse: '◉', book: '▤' }[name] || '•'); }
function ensureStudentQuestionOrder() { if (!session || session.role !== 'student' || !state.currentQuizId || !state.questions.length) return; if (session.started && session.questionOrder?.length) { state.questions = session.questionOrder; return; } const storedOrder = state.studentQuestionOrders[session.username]; const storedQuestions = storedOrder?.quizId === state.currentQuizId ? storedOrder.questionIds.map(id => state.questions.find(question => question.id === id)).filter(Boolean) : []; const questionOrder = storedQuestions.length === state.questions.length ? storedQuestions : shuffleQuestions(state.questions, session.username); state.studentQuestionOrders[session.username] = { quizId: state.currentQuizId, questionIds: questionOrder.map(question => question.id) }; state.questions = questionOrder; session.questionOrder = questionOrder; saveStudentSession(); }
function app() { if (session && !stateHydrated) { document.querySelector('#app').innerHTML = '<main class="main"><div class="quiz-shell"><section class="card result-hero"><div class="eyebrow kicker">Connecting</div><h2>Loading the current workspace...</h2></section></div></main>'; return; } ensureStudentQuestionOrder(); document.querySelector('#app').innerHTML = session ? (session.role === 'teacher' ? teacherApp() : (session.completed ? studentApp() : (session.started ? studentApp() : studentQuizLobby()))) : loginApp(); saveWindowSession(); restoreTeacherDrafts(); bindEvents(); }
function reconcileStudentSession() { if (!session || session.role !== 'student') return; const hasActiveQuiz = Boolean(state.questionsPublished && !state.quizStopped && state.currentQuizId && state.questions.length); if (session.quizId === state.currentQuizId && (hasActiveQuiz || session.completed)) return; stopTimer(); session.started = false; session.quizId = state.currentQuizId; session.completed = false; session.result = null; session.selected = null; session.feedback = null; session.index = 0; session.answers = []; session.questionOrder = null; saveStudentSession(); }
function loginApp() {
  return `<main class="login-page"><section class="login-art"><div class="brand"><span class="brand-mark">OQ</span><strong>ONLINE QUIZ</strong></div><div class="art-copy"><div class="eyebrow">Learning assessment</div><h1>Make every answer count.</h1><p>A focused space for thoughtful quizzes, clear feedback, and better learning outcomes.</p></div><div class="art-note">SECURE ASSESSMENT PORTAL · 2026</div></section><section class="login-side"><div class="login-box"><div class="eyebrow kicker">Secure access</div><h2>Sign in to continue</h2><p class="subtle">${stateHydrated ? 'Enter your username and password to unlock your account.' : 'Connecting to the quiz workspace...'}</p><form id="login-form" autocomplete="off"><div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="off" placeholder="Enter your username" required /></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" placeholder="Enter your password" required /></div><button class="btn btn-primary login-submit" ${stateHydrated ? '' : 'disabled'}>Sign in <span>→</span></button></form></div></section></main>`;
}
function teacherApp() {
  const view = teacherView;
  return `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">OQ</span><strong>ONLINE QUIZ</strong></div><div class="eyebrow nav-label">Workspace</div><nav class="nav">${navButton('grid', 'Overview', 'overview', view)}${navButton('question', 'Question bank', 'questions', view)}${navButton('settings', 'Quiz configuration', 'config', view)}${navButton('users', 'Student access', 'users', view)}${navButton('results', 'Results & monitoring', 'results', view)}</nav><div class="sidebar-foot">Teacher workspace<br /><span>All changes save locally</span></div></aside><main class="main"><header class="topbar"><div><div class="eyebrow kicker">Teacher workspace</div><h1>${viewTitle(view)}</h1><p class="subtle">${viewDescription(view)}</p></div><div class="user-chip"><span class="avatar">KK</span><span>Kelvin Kayuni</span><button class="btn btn-small btn-secondary" data-action="logout">Exit</button></div></header>${viewContent(view)}</main></div>`;
}
function navButton(iconName, label, target, active) { return `<button class="${target === active ? 'active' : ''}" data-view="${target}"><span class="nav-icon">${icon(iconName)}</span>${label}</button>`; }
function timeGreeting() { const hour = new Date().getHours(); if (hour >= 5 && hour < 12) return 'Good morning'; if (hour >= 12 && hour < 17) return 'Good afternoon'; if (hour >= 17 && hour < 21) return 'Good evening'; return 'Good night'; }
function viewTitle(view) { return ({ overview: `${timeGreeting()}, Kelvin.`, questions: 'Question bank', config: 'Quiz configuration', users: 'Student access', results: 'Results & monitoring' }[view]); }
function viewDescription(view) { return ({ overview: 'A live view of your assessment workspace.', questions: 'Build reusable questions with flexible scoring.', config: 'Set the rules, timing, and availability window.', users: 'Import and manage student login credentials.', results: 'Track participation and export completed work.' }[view]); }
function viewContent(view) { return ({ overview: overviewView, questions: questionsView, config: configView, users: usersView, results: resultsView }[view])(); }
function overviewView() {
  const online = state.users.filter(user => user.status === 'online').length;
  const average = state.results.length ? Math.round(state.results.reduce((sum, item) => sum + item.percentage, 0) / state.results.length) : 0;
  return `<section class="grid stat-grid"><div class="card stat"><span class="eyebrow">Question bank</span><span class="value">${state.questions.length}</span><span class="label">Reusable questions</span></div><div class="card stat"><span class="eyebrow">Student access</span><span class="value">${state.users.length}</span><span class="label">Registered accounts</span></div><div class="card stat"><span class="eyebrow">Live now</span><span class="value">${online}</span><span class="label"><span class="trend">● Active participants</span></span></div><div class="card stat"><span class="eyebrow">Average score</span><span class="value">${average}%</span><span class="label">Across completed quizzes</span></div></section><section class="grid two-col"><div class="card panel"><div class="panel-head"><div><h2>Quiz pulse</h2><p class="subtle">${state.config.start ? `Scheduled for ${formatDate(state.config.start)}` : 'Your next assessment at a glance'}</p></div><button class="btn btn-secondary btn-small" data-view="config">Edit setup</button></div><div class="grid" style="grid-template-columns: repeat(3, 1fr); margin: 30px 0 18px"><div><div class="eyebrow">Questions</div><strong style="display:block;font-size:25px;margin-top:9px">${state.config.totalQuestions}</strong></div><div><div class="eyebrow">Duration</div><strong style="display:block;font-size:25px;margin-top:9px">${state.config.duration}<small style="font-size:12px;color:var(--muted)"> min</small></strong></div><div><div class="eyebrow">Deadline</div><strong style="display:block;font-size:13px;margin-top:13px">${state.config.end ? new Date(state.config.end).toLocaleDateString() : 'Open'}</strong></div></div><div class="progress"><span style="width:${state.questions.length ? Math.min(100, (state.config.totalQuestions / state.questions.length) * 100) : 0}%"></span></div><p class="subtle" style="margin:9px 0 0">${state.questions.length} questions available in the bank</p></div><div class="card panel"><div class="panel-head"><div><h2>Live students</h2><p class="subtle">Presence updates as students enter the quiz.</p></div><span class="badge">${online} online</span></div>${liveStudents()}</div></section><section class="card panel" style="margin-top:17px"><div class="panel-head"><div><h2>Recent activity</h2><p class="subtle">The latest changes in your quiz workspace.</p></div><button class="btn btn-secondary btn-small" data-action="clear-activity" ${state.activity.length ? '' : 'disabled'}>Clear activity</button></div>${activityList()}</section>`;
}
function revokeStudentAccess() {
  if (!session || session.role !== 'student') return;
  stopTimer();
  void markStudentOffline(session.username, session.quizId);
  if (session.originalQuestions) state.questions = session.originalQuestions;
  session = null;
  saveWindowSession();
  showToast('Your student access has been deactivated by the teacher.');
  app();
}
function liveStudents() { const online = state.users.filter(user => user.status === 'online'); if (!online.length) return '<div class="empty">No students are currently taking the quiz.</div>'; return `<div class="activity">${online.map(user => `<div class="activity-item"><span class="activity-icon">${icon('pulse')}</span><div><strong>${esc(user.username)}</strong><br><span class="subtle">Currently answering</span></div><span class="status">Online</span></div>`).join('')}</div>`; }
async function refreshLiveStudents() { if (!session || session.role !== 'teacher') return; if (!state.currentQuizId) { state.users = state.users.map(user => ({ ...user, status: 'offline' })); if (teacherView === 'overview' || teacherView === 'results') app(); return; } const liveUsernames = await loadLiveStudentUsernames(state.currentQuizId); if (!liveUsernames) return; const now = new Date().toISOString(); state.users = state.users.map(user => ({ ...user, status: liveUsernames.has(user.username) ? 'online' : 'offline', lastSeen: liveUsernames.has(user.username) ? user.lastSeen || now : user.lastSeen })); if (teacherView === 'overview' || teacherView === 'results') app(); }
async function refreshTeacherQuizState() { if (!session || session.role !== 'teacher' || teacherMutationInFlight) return; const { data, error } = await supabase.from('quiz_config').select('quiz_id, published, stopped, total_questions, duration, start_time, end_time, course_name, course_code').eq('id', 1).maybeSingle(); if (error || !data) return; const nextQuizId = data.quiz_id || null; const nextStopped = Boolean(data.stopped); const nextPublished = Boolean(data.published) && !nextStopped; const nextConfig = { ...state.config, courseName: data.course_name || '', courseCode: data.course_code || '', totalQuestions: Number(data.total_questions) || 0, duration: Number(data.duration) || 0, start: toDateTimeLocal(data.start_time), end: toDateTimeLocal(data.end_time) }; const changed = state.currentQuizId !== nextQuizId || state.quizStopped !== nextStopped || state.questionsPublished !== nextPublished || state.config.totalQuestions !== nextConfig.totalQuestions || state.config.duration !== nextConfig.duration || state.config.start !== nextConfig.start || state.config.end !== nextConfig.end; if (!changed) return; state.currentQuizId = nextQuizId; state.quizStopped = nextStopped; state.questionsPublished = nextPublished; state.config = nextConfig; if (teacherView === 'questions' || teacherView === 'overview') app(); }
async function refreshStudentQuizStateRaw() { if (!session || session.role !== 'student') return; const [configResult, questionsResult, workspaceResult] = await Promise.all([supabase.from('quiz_config').select('quiz_id, published, stopped, total_questions, duration, start_time, end_time, course_name, course_code').eq('id', 1).maybeSingle(), supabase.from('questions').select('*').order('created_at'), supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle()]); if (questionsResult.error) return; const config = configResult.data; const workspace = workspaceResult.data?.data || {}; const previousQuizId = state.currentQuizId; const previousStopped = state.quizStopped; const previousPublished = state.questionsPublished; const previousQuestionCount = state.questions.length; state.questions = questionsResult.data.map(normalizeQuestion); state.currentQuizId = config?.quiz_id || null; state.quizStopped = Boolean(config?.stopped); state.questionsPublished = Boolean(config?.published) && !state.quizStopped && state.questions.length > 0; state.config = { ...state.config, courseName: config?.course_name || workspace.courseName || state.config.courseName || '', courseCode: config?.course_code || workspace.courseCode || state.config.courseCode || '', totalQuestions: Number(config?.total_questions) || 0, duration: Number(config?.duration) || 0, start: toDateTimeLocal(config?.start_time), end: toDateTimeLocal(config?.end_time) }; const quizChanged = Boolean(state.currentQuizId && state.currentQuizId !== previousQuizId); const quizRemoved = Boolean(previousQuizId) && (!state.questionsPublished || state.quizStopped || !state.currentQuizId); const quizStateChanged = quizChanged || quizRemoved || state.quizStopped !== previousStopped || state.questionsPublished !== previousPublished || state.questions.length !== previousQuestionCount; if (quizStateChanged) { if (quizRemoved && previousQuizId) { state.results = state.results.filter(result => result.quizId !== previousQuizId); state.studentHistory = state.studentHistory.filter(result => result.quizId !== previousQuizId); state.resultFiles = state.resultFiles.filter(file => !file.id.includes(previousQuizId)); } stopTimer(); session.started = false; session.quizId = state.currentQuizId; session.completed = false; session.result = null; session.selected = null; session.feedback = null; session.index = 0; session.answers = []; session.questionOrder = null; saveStudentSession(); app(); if (state.questionsPublished && quizChanged) showToast('New quiz available. You can start now.'); } }
function activityList() { if (!state.activity.length) return '<div class="empty">No activity recorded yet. Your workspace will appear here as students participate.</div>'; return `<div class="activity">${state.activity.slice(0, 6).map(item => `<div class="activity-item"><span class="activity-icon">${icon(item.type || 'book')}</span><div>${esc(item.text)}<br><span class="subtle">${formatDate(item.time)}</span></div><span class="activity-time">${new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>`).join('')}</div>`; }
function questionsView() { const locked = quizIsLocked(); const ended = Boolean(state.questionsPublished && !state.quizStopped && quizHasEnded());
  return `<section class="grid two-col"><div class="card panel"><div class="panel-head"><div><h2>${editingQuestionId ? 'Edit question' : 'Create a question'}</h2><p class="subtle">Add a reusable multiple-choice question.</p></div><span class="badge">${state.questions.length} saved</span></div><form id="question-form"><input type="hidden" name="id" value="${editingQuestionId || ''}" /><div class="field"><label>Question prompt</label><textarea name="text" placeholder="Write the question students will see..." required>${editingQuestionId ? esc(state.questions.find(question => question.id === editingQuestionId)?.text || '') : ''}</textarea></div><div class="field" style="margin-top:15px"><label>Choices <span id="choice-count">(${editingQuestionId ? state.questions.find(question => question.id === editingQuestionId).choices.length : 4})</span></label><div id="choices">${choiceInputsForEditing()}</div><button type="button" class="btn btn-secondary btn-small" data-action="add-choice">+ Add choice</button></div><div class="form-grid" style="margin-top:15px"><div class="field"><label>Correct answer</label><select id="correct-answer" name="correct">${correctOptionsForEditing()}</select></div><div class="field"><label>Marks</label><input name="marks" type="number" min="1" value="${editingQuestionId ? state.questions.find(question => question.id === editingQuestionId).marks : ''}" placeholder="Enter marks" required /></div></div><div style="display:flex;gap:9px;margin-top:18px"><button class="btn btn-primary">${editingQuestionId ? 'Update question' : 'Save question'}</button>${editingQuestionId ? '<button type="button" class="btn btn-secondary" data-action="cancel-edit">Cancel</button>' : ''}</div></form></div><div class="card panel"><div class="panel-head"><div><h2>Saved questions</h2><p class="subtle">${ended ? 'This quiz ended. You can edit and submit an updated quiz.' : state.questionsPublished && !state.quizStopped ? 'Published questions are available to students.' : 'Questions stay private until you submit them.'}</p></div><div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end"><button class="btn btn-secondary btn-small" data-action="clear-questions" ${state.questions.length ? '' : 'disabled'}>Clear all</button><button class="btn btn-primary btn-small" data-action="publish-questions" ${state.questions.length ? '' : 'disabled'}>${state.questionsPublished && !state.quizStopped && !ended ? 'Questions submitted' : 'Submit questions'}</button></div></div><div id="question-list">${questionList()}</div></div></section>`;
}
function choiceInput(index) { return `<div class="choice-row"><input name="choice" data-choice="${index}" placeholder="Choice ${String.fromCharCode(65 + index)}" required /><button type="button" data-action="remove-choice" title="Remove choice">×</button></div>`; }
function choiceInputsForEditing() { const question = editingQuestionId && state.questions.find(item => item.id === editingQuestionId); return (question ? question.choices : ['', '', '', '']).map((choice, index) => `<div class="choice-row"><input name="choice" data-choice="${index}" value="${esc(choice)}" placeholder="Choice ${String.fromCharCode(65 + index)}" required /><button type="button" data-action="remove-choice" title="Remove choice">×</button></div>`).join(''); }
function correctOptionsForEditing() { const question = editingQuestionId && state.questions.find(item => item.id === editingQuestionId); const count = question ? question.choices.length : 4; return Array.from({ length: count }, (_, index) => `<option value="${index}" ${question?.correct === index ? 'selected' : ''}>Choice ${String.fromCharCode(65 + index)}</option>`).join(''); }
function questionList() { if (!state.questions.length) return '<div class="empty">Your question bank is empty. Add a question to begin.</div>'; return state.questions.map((question, index) => `<article class="question-item"><div class="question-meta"><span class="badge">Q${String(index + 1).padStart(2, '0')}</span><span>${question.marks} marks</span></div><h3 style="margin-top:12px">${esc(question.text)}</h3><div class="question-details" id="details-${question.id}"><p class="subtle" style="margin-bottom:0">${question.choices.length} choices · Correct answer: ${String.fromCharCode(65 + question.correct)}</p>${question.choices.map((choice, choiceIndex) => `<div class="subtle">${String.fromCharCode(65 + choiceIndex)}. ${esc(choice)}</div>`).join('')}</div><div class="question-actions"><button class="btn btn-secondary btn-small" data-action="expand-question" data-id="${question.id}">Expand</button><button class="btn btn-secondary btn-small" data-action="edit-question" data-id="${question.id}">Edit</button><button class="btn btn-coral btn-small" data-action="delete-question" data-id="${question.id}">Delete</button></div></article>`).join(''); }
function configView() { const config = state.config; return `<section class="card panel" style="max-width:760px"><div class="panel-head"><div><h2>Set the assessment rules</h2><p class="subtle">Students will see these limits when they sign in.</p></div><span class="badge">${config.totalQuestions ? `${config.totalQuestions} questions` : 'Empty rules'}</span></div><form id="config-form"><div class="form-grid"><div class="field"><label>Total questions</label><input type="number" name="totalQuestions" min="1" max="${Math.max(1, state.questions.length)}" value="${config.totalQuestions || ''}" placeholder="e.g. 10" /></div><div class="field"><label>Duration (minutes)</label><input type="number" name="duration" min="1" value="${config.duration || ''}" placeholder="e.g. 30" /></div><div class="field"><label>Start date & time</label><input type="datetime-local" name="start" value="${config.start}" /></div><div class="field"><label>End date & time</label><input type="datetime-local" name="end" value="${config.end}" /></div></div><div style="display:flex;justify-content:flex-end;gap:9px;margin-top:20px"><button type="button" class="btn btn-secondary" data-action="reset-config">Reset rules</button><button class="btn btn-primary" ${state.configSaved ? 'disabled' : ''}>Save configuration</button></div></form></section>`; }
function usersView() { const file = state.importedFile; const active = Boolean(file && state.studentLoginActive); return `<section class="grid two-col"><div class="card panel"><div class="panel-head"><div><h2>Import student accounts</h2><p class="subtle">Upload an .xlsx file with username/password pairs across columns.</p></div></div><label class="upload"><span class="upload-icon">${icon('upload')}</span><strong>${file ? 'Replace Excel file' : 'Choose Excel file'}</strong><span class="subtle">Columns alternate: username, password</span><input id="user-upload" type="file" accept=".xlsx,.xls,.csv" ${active ? 'disabled' : ''} /></label>${file ? `<div class="file-row"><span><strong>${esc(file.name)}</strong><br><span class="subtle">${file.count} accounts · ${formatDate(file.uploadedAt)}</span></span><button class="btn btn-coral btn-small" data-action="delete-upload" ${active ? 'disabled' : ''}>Delete file</button></div><div class="login-activation"><span><strong>Student login</strong><br><span class="subtle">${active ? 'Workbook credentials are in use.' : 'Activate this workbook to allow student login.'}</span></span><button class="btn ${active ? 'btn-primary' : 'btn-secondary'} btn-small" data-action="toggle-student-login">${active ? 'Active' : 'Inactive'}</button></div>` : ''}<div class="hint" style="margin-top:17px">${active ? 'Delete and replace are disabled while this workbook is active.' : file ? 'Activate the workbook when you are ready to allow its credentials.' : 'The first row can be a header. Upload a workbook to configure student access.'}</div></div><div class="card panel"><div class="panel-head"><div><h2>Student directory</h2><p class="subtle">${state.users.length} account${state.users.length === 1 ? '' : 's'} available</p></div></div><div class="table-wrap"><table><thead><tr><th>Username</th><th>Status</th><th>Last seen</th></tr></thead><tbody>${state.users.map(user => `<tr><td><strong>${esc(user.username)}</strong></td><td><span class="status ${user.status === 'online' ? '' : 'offline'}">${user.status === 'online' ? 'Online' : 'Offline'}</span></td><td class="subtle">${user.lastSeen ? formatDate(user.lastSeen) : '—'}</td></tr>`).join('')}</tbody></table></div></div></section>`; }
function resultsView() { const file = state.resultFiles.find(item => item.id === selectedResultFileId) || state.resultFiles[0]; if (file) selectedResultFileId = file.id; const selectedRows = file?.rows || state.results; const health = healthResults(); return `<section class="card panel"><div class="panel-head"><div><h2>Quiz result files</h2><p class="subtle">Open a stored quiz workbook here or download it for sharing.</p></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end"><button class="btn btn-secondary btn-small" data-action="clear-result-files" ${state.resultFiles.length ? '' : 'disabled'}>Clear history</button>${file ? `<button class="btn btn-coral btn-small" data-action="delete-result-file">Delete selected</button><button class="btn btn-secondary btn-small" data-action="open-result">Open in system</button><button class="btn btn-primary btn-small" data-action="download-results">${icon('download')} Download</button>` : ''}</div></div>${state.resultFiles.length ? `<div class="file-selector"><label class="eyebrow">Select quiz file</label><select id="result-file-select">${state.resultFiles.map(item => `<option value="${item.id}" ${item.id === file.id ? 'selected' : ''}>${esc(item.name)} · ${formatDate(item.createdAt)}</option>`).join('')}</select></div><div class="table-wrap"><table><thead><tr><th>Student username</th><th>Attempted</th><th>Incorrect</th><th>Total marks</th><th>Percentage</th><th>Status</th></tr></thead><tbody>${selectedRows.map(result => `<tr><td><strong>${esc(result.username)}</strong></td><td>${result.attempted}</td><td>${result.incorrect}</td><td>${result.score}/${result.totalMarks}</td><td><strong>${result.percentage}%</strong></td><td><span class="badge">Completed</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No quiz result files yet. Completed quizzes will be stored here automatically.</div>'}</section><section class="grid two-col" style="margin-top:17px"><div class="card panel"><div class="panel-head"><div><h2>Live monitoring</h2><p class="subtle">Active quiz sessions</p></div><span class="badge">${state.users.filter(user => user.status === 'online').length} online</span></div>${liveStudents()}</div><div class="card panel"><div class="panel-head"><div><h2>Assessment health</h2><p class="subtle">Completion overview</p></div><button class="btn btn-secondary btn-small" data-action="clear-health" ${health.length ? '' : 'disabled'}>Clear health</button></div><div style="display:flex;align-items:baseline;gap:8px;margin:16px 0 10px"><strong style="font-size:33px;letter-spacing:-.07em">${health.length}</strong><span class="subtle">completed</span></div><div class="progress"><span style="width:${state.users.length ? Math.min(100, health.length / state.users.length * 100) : 0}%"></span></div></div></section>`; }
function studentApp() { if (session.completed) return studentResult(); const availableQuestions = state.questionsPublished ? state.questions : []; const question = availableQuestions[session.index]; if (!question) return studentAccountWithoutQuiz(); const progress = ((session.index) / Math.min(state.config.totalQuestions, availableQuestions.length)) * 100; return `<main class="main"><div class="quiz-shell"><div class="quiz-top"><div><div class="brand"><span class="brand-mark">OQ</span><strong>ONLINE QUIZ</strong></div><p class="subtle" style="margin:14px 0 0">${esc(session.username)} · Assessment in progress</p></div><div class="student-actions"><button class="btn btn-secondary btn-small" data-action="view-student-history">View quiz history</button><button class="btn btn-secondary btn-small" data-action="download-student-history" ${state.studentHistory.some(item => item.username === session.username) ? '' : 'disabled'}>Download history</button><button class="btn btn-secondary btn-small" data-action="logout">Sign out</button><div class="timer" id="timer">${formatTime(session.remaining)}</div></div></div><div class="quiz-progress"><span style="width:${progress}%"></span></div><div class="quiz-card card"><div class="eyebrow quiz-number">Question ${session.index + 1} of ${Math.min(state.config.totalQuestions, availableQuestions.length)} · ${question.marks} marks</div><h1 class="quiz-question">${esc(question.text)}</h1><div class="answers">${question.choices.map((choice, index) => `<button class="answer ${session.selected === index ? 'selected' : ''}" data-answer="${index}"><span class="answer-letter">${String.fromCharCode(65 + index)}</span>${esc(choice)}</button>`).join('')}</div>${session.feedback ? `<div class="feedback ${session.feedback.correct ? 'correct' : 'incorrect'}">${session.feedback.correct ? `Correct. +${question.marks} marks awarded.` : 'Not quite. This question scores zero marks.'}</div>` : ''}<div class="quiz-actions"><button class="btn btn-primary" data-action="submit-answer" ${session.selected === null || session.feedback ? 'disabled' : ''}>${session.index === Math.min(state.config.totalQuestions, availableQuestions.length) - 1 ? 'Finish quiz' : 'Submit answer'} →</button>${session.feedback ? `<button class="btn btn-secondary" style="margin-left:9px" data-action="next-question">${session.index === Math.min(state.config.totalQuestions, availableQuestions.length) - 1 ? 'View result' : 'Next question'} →</button>` : ''}</div></div></div></main>`; }
function studentQuizLobby() { const ended = quizHasEnded(); const notStarted = quizHasNotStarted(); const hasPublishedQuiz = state.questionsPublished && !state.quizStopped && state.currentQuizId && state.questions.length > 0; const canStart = hasPublishedQuiz && !ended && !notStarted; const title = ended ? 'This quiz has ended.' : notStarted && hasPublishedQuiz ? 'Your quiz is scheduled.' : canStart ? 'Your quiz is ready to begin.' : 'Your account is ready.'; const kicker = ended ? 'Quiz ended' : notStarted && hasPublishedQuiz ? 'Assessment scheduled' : canStart ? 'Assessment ready' : 'No active assessment'; const message = ended ? 'The quiz end time has passed. The teacher must submit a new quiz with a future end time.' : notStarted && hasPublishedQuiz ? `The quiz opens on ${formatDate(state.config.start)}.` : canStart ? 'When you click Start Quiz, your individual timer and question order will begin.' : 'The teacher has not made an active quiz available yet. You can return later without losing your account access.'; return `<main class="main"><div class="quiz-shell"><div class="quiz-top"><div><div class="brand"><span class="brand-mark">OQ</span><strong>ONLINE QUIZ</strong></div><p class="subtle" style="margin:14px 0 0">${esc(session.username)} · Student account</p></div><div class="student-actions"><button class="btn btn-secondary btn-small" data-action="logout">Sign out</button></div></div><section class="card result-hero"><div class="eyebrow kicker">${kicker}</div><h2>${title}</h2><p class="subtle">${message}</p>${studentSchedule()}<button class="btn btn-primary" data-action="start-quiz" ${canStart ? '' : 'disabled'}>Start Quiz</button></section></div></main>`; }
function studentActivityPanel() { return '<section class="card panel student-history-panel"><div class="panel-head"><div><h2>Recent activity</h2><p class="subtle">Your recent student activity will appear here.</p></div></div><div class="empty">No recent activity recorded.</div></section>'; }
async function startStudentQuiz() {
  if (!session || session.role !== 'student') return showToast('Student session not found.');
  if (!state.currentQuizId || session.quizId !== state.currentQuizId || !state.questionsPublished) {
    const { data, error } = await supabase.from('quiz_config').select('quiz_id, published, stopped, total_questions, duration, start_time, end_time').eq('id', 1).maybeSingle();
    if (!error && data) {
      state.currentQuizId = data.quiz_id || null;
      state.questionsPublished = Boolean(data.published) && !Boolean(data.stopped);
      state.quizStopped = Boolean(data.stopped);
      state.config.totalQuestions = Number(data.total_questions) || 0;
      state.config.duration = Number(data.duration) || 0;
      state.config.start = data.start_time ? toDateTimeLocal(data.start_time) : '';
      state.config.end = data.end_time ? toDateTimeLocal(data.end_time) : '';
      session.quizId = state.currentQuizId;
    }
  }
  if (state.quizStopped) return showToast('This quiz has been stopped by the teacher.');
  if (quizHasNotStarted()) return showToast(`This quiz starts on ${formatDate(state.config.start)}.`);
  if (quizHasEnded()) return showToast('This quiz has ended.');
  if (!state.questionsPublished) return showToast('The teacher has not submitted a quiz yet.');
  if (!state.currentQuizId || session.quizId !== state.currentQuizId) return showToast('This quiz is not available in your current session.');
  if (!session.started) session.remaining = Math.max(60, Number(state.config.duration) * 60);
  session.started = true;
  void markStudentOnline(session.username, session.quizId);
  saveStudentSession();
  app();
}
function studentAccountWithoutQuiz() { const history = state.studentHistory.filter(item => item.username === session.username); return `<main class="main"><div class="quiz-shell"><div class="quiz-top"><div><div class="brand"><span class="brand-mark">OQ</span><strong>ONLINE QUIZ</strong></div><p class="subtle" style="margin:14px 0 0">${esc(session.username)} · Student account</p></div><div class="student-actions"><button class="btn btn-secondary btn-small" data-action="logout">Sign out</button><button class="btn btn-secondary btn-small" data-action="view-student-history">View quiz history</button><button class="btn btn-secondary btn-small" data-action="download-student-history" ${history.length ? '' : 'disabled'}>Download history</button></div></div><section class="card result-hero"><div class="eyebrow kicker">No active assessment</div><h2>Your student account is ready.</h2><p class="subtle">There is no quiz available right now. You can still review your previous quiz history below.</p>${studentSchedule()}</section><section class="card panel student-history-panel" id="student-history-panel"><div class="panel-head"><div><h2>Quiz history</h2><p class="subtle">Your records can be viewed or downloaded, but not deleted.</p></div></div>${studentHistoryTable(history)}</section></div></main>`; }
function studentSchedule() { const config = state.config; const courseName = courseDisplayValue(config.courseName); const courseCode = courseDisplayValue(config.courseCode); return `${courseName || courseCode ? `<div style="margin:24px 0 0;text-align:left">${courseName ? `<h3 style="margin:7px 0 0">${esc(courseName)}</h3>` : ''}${courseCode ? `<span class="badge">${esc(courseCode)}</span>` : ''}</div>` : ''}<div class="grid" style="grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0 0;text-align:left"><div><div class="eyebrow">Starts</div><strong style="display:block;margin-top:7px">${config.start ? esc(formatDate(config.start)) : 'Not scheduled'}</strong></div><div><div class="eyebrow">Ends</div><strong style="display:block;margin-top:7px">${config.end ? esc(formatDate(config.end)) : 'No deadline'}</strong></div><div><div class="eyebrow">Time limit</div><strong style="display:block;margin-top:7px">${config.duration ? `${config.duration} minutes` : 'Not set'}</strong></div></div>`; }
function studentResult() { const result = session.result || state.results.find(item => item.username === session.username); const history = state.studentHistory.filter(item => item.username === session.username); const percentage = result?.percentage ?? 0; const passed = percentage >= 50; return `<main class="main"><div class="quiz-shell"><div class="quiz-top"><div class="brand"><span class="brand-mark">OQ</span><strong>ONLINE QUIZ</strong></div><div class="student-actions"><button class="btn btn-secondary btn-small" data-action="view-student-history">View quiz history</button><button class="btn btn-secondary btn-small" data-action="download-student-history" ${history.length ? '' : 'disabled'}>Download history</button><button class="btn btn-secondary btn-small" data-action="logout">Sign out</button></div></div><section class="card result-hero"><div class="eyebrow kicker">Assessment complete</div><div class="score-big">${percentage}%</div><h2>${passed ? 'WELL DONE' : 'NOT GOOD'}, ${esc(session.username)}.</h2><p class="subtle">Your answers have been recorded. This attempt is final and cannot be retaken.</p><div class="grid" style="grid-template-columns:repeat(3,1fr);margin:30px 0;text-align:left"><div><div class="eyebrow">Score</div><strong>${result ? result.score : 0}/${result ? result.totalMarks : 0}</strong></div><div><div class="eyebrow">Attempted</div><strong>${result ? result.attempted : 0}</strong></div><div><div class="eyebrow">Incorrect</div><strong>${result ? result.incorrect : 0}</strong></div></div></section><section class="card panel student-history-panel" id="student-history-panel"><div class="panel-head"><div><h2>Quiz history</h2><p class="subtle">Your records can be viewed or downloaded, but not deleted.</p></div></div>${studentHistoryTable(history)}</section></div></main>`; }
function studentHistoryTable(history) { if (!history.length) return '<div class="empty">No completed quiz history yet.</div>'; return `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Duration</th><th>Attempted</th><th>Right</th><th>Wrong</th><th>Marks scored</th></tr></thead><tbody>${history.map(item => `<tr><td>${formatDate(item.completedAt)}</td><td>${item.durationMinutes || 0} min</td><td>${item.attempted}</td><td>${item.correct ?? Math.max(0, item.attempted - item.incorrect)}</td><td>${item.incorrect}</td><td><strong>${item.score}/${item.totalMarks}</strong></td></tr>`).join('')}</tbody></table></div>`; }
function formatTime(totalSeconds) { const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0'); const seconds = Math.max(0, totalSeconds % 60).toString().padStart(2, '0'); return `${minutes}:${seconds}`; }
function addActivity(text, type = 'book') { state.activity.unshift({ text, type, time: new Date().toISOString() }); state.activity = state.activity.slice(0, 20); saveState(); }
async function persistQuizControlState() { if (state.questionsPublished && state.currentQuizId) return; const result = await supabase.from('quiz_config').upsert({ id: 1, course_name: state.config.courseName || null, course_code: state.config.courseCode || null, total_questions: state.config.totalQuestions, duration: state.config.duration, start_time: state.config.start ? new Date(state.config.start).toISOString() : null, end_time: state.config.end ? new Date(state.config.end).toISOString() : null, quiz_id: state.currentQuizId, published: state.questionsPublished, stopped: state.quizStopped }); if (result.error) throw result.error; }
const CONFIG_CONFIRM_ATTEMPTS = 5;
const CONFIG_CONFIRM_INTERVAL = 7500;
async function confirmSavedConfiguration(expected, expectedQuestionCount = null) {
  for (let attempt = 0; attempt < CONFIG_CONFIRM_ATTEMPTS; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, CONFIG_CONFIRM_INTERVAL));
    const { data, error } = await supabase.from('quiz_config').select('course_name, course_code, quiz_id, published, stopped, total_questions, duration, start_time, end_time').eq('id', 1).maybeSingle();
    if (error) continue;
    const hasTimingRules = Boolean(Number(data?.duration) || data?.start_time || data?.end_time);
    const questionCountMatches = expectedQuestionCount === null || Number(data?.total_questions) === expectedQuestionCount;
    const confirmed = typeof expected === 'object'
      ? Boolean(data)
        && cleanLiveCourseValue(data.course_name, 'Course') === expected.courseName
        && cleanLiveCourseValue(data.course_code, '34') === expected.courseCode
        && Number(data.total_questions) === Number(expected.totalQuestions)
        && Number(data.duration) === Number(expected.duration)
        && (data.start_time ? Date.parse(data.start_time) : null) === (expected.start ? new Date(expected.start).getTime() : null)
        && (data.end_time ? Date.parse(data.end_time) : null) === (expected.end ? new Date(expected.end).getTime() : null)
        && (data.quiz_id || null) === expected.currentQuizId
        && Boolean(data.published) === expected.questionsPublished
        && Boolean(data.stopped) === expected.quizStopped
      : expected ? hasTimingRules && questionCountMatches : !hasTimingRules && !data?.published && !data?.quiz_id && questionCountMatches;
    if (confirmed) return;
  }
  throw new Error(`Supabase did not confirm that the configuration was ${expected ? 'saved' : 'reset'} after ${CONFIG_CONFIRM_ATTEMPTS} checks over 30 seconds.`);
}
async function confirmPublishedQuiz(quizId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
    const [configResult, workspaceResult] = await Promise.all([
      supabase.from('quiz_config').select('quiz_id, published, stopped').eq('id', 1).maybeSingle(),
      supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle()
    ]);
    if (configResult.error || workspaceResult.error) continue;

    const snapshot = workspaceResult.data?.data?.currentQuizQuestions;
    const questionsMatch = snapshot?.quizId === quizId
      && Array.isArray(snapshot.questions)
      && snapshot.questions.length === state.questions.length
      && state.questions.every(question => {
        const saved = snapshot.questions.find(item => item.id === question.id);
        return saved
          && saved.text === question.text
          && saved.type === question.type
          && saved.answer === question.answer
          && Number(saved.correct) === Number(question.correct)
          && Number(saved.marks) === Number(question.marks)
          && JSON.stringify(saved.choices || []) === JSON.stringify(question.choices || []);
      });
    const config = configResult.data;
    if (config?.quiz_id === quizId && Boolean(config.published) && !config.stopped && questionsMatch) return true;
  }
  return false;
}
async function expireQuizDueToTimeLegacy() { if (!state.questionsPublished || !state.currentQuizId || teacherMutationInFlight || !quizHasEnded()) return; teacherMutationInFlight = true; try { state.questionsPublished = false; state.quizStopped = false; state.currentQuizId = null; state.configSaved = false; Object.keys(state.studentSessions).forEach(username => delete state.studentSessions[username]); saveState(); await persistQuizControlState(); await persistQuizState(state, 'teacher', { waitForSync: true }); await confirmSavedConfiguration(false); showToast('Quiz ended. The time set is available for a new configuration.'); } catch (error) { showToast(`Quiz end could not be confirmed: ${error.message || error}`); } finally { teacherMutationInFlight = false; app(); } }
function healthResults() { return state.results.filter(result => result.quizId === state.currentQuizId && (!state.healthClearedAt || result.completedAt > state.healthClearedAt)); }
function applyBranding() { document.title = 'Assessment Gateway | Learning assessment'; document.querySelectorAll('.brand strong').forEach(element => { element.textContent = 'Assessment Gateway'; }); document.querySelectorAll('.brand-mark').forEach(element => { element.textContent = 'AG'; }); const artNote = document.querySelector('.art-note'); if (artNote) artNote.textContent = String(new Date().getFullYear()); document.querySelector('[data-action="open-result"]')?.remove(); }
function bindEvents() { applyBranding(); const totalQuestionsField = document.querySelector('#config-form [name="totalQuestions"]'); if (totalQuestionsField) { const questionCountChanged = state.config.totalQuestions !== state.questions.length; totalQuestionsField.value = String(state.questions.length); totalQuestionsField.readOnly = true; if (questionCountChanged) { state.configSaved = false; totalQuestionsField.form.querySelector('button[type="submit"]')?.removeAttribute('disabled'); } }
  if (session?.role === 'student' && quizHasNotStarted()) document.querySelector('[data-action="start-quiz"]')?.setAttribute('disabled', 'true');
  if (session?.role === 'student' && session.started && !document.querySelector('.course-banner')) {
    document.querySelector('.quiz-progress')?.insertAdjacentHTML('beforebegin', studentCourseDetails());
  }
  const courseForm = document.querySelector('#question-form');
  if (courseForm && !courseForm.querySelector('[name="courseName"]')) {
    courseForm.insertAdjacentHTML('afterbegin', `<div class="form-grid"><div class="field"><label>Course name</label><input name="courseName" value="${esc(courseDisplayValue(state.config.courseName))}" placeholder="e.g. Mathematics" /></div><div class="field"><label>Course code</label><input name="courseCode" value="${esc(courseDisplayValue(state.config.courseCode))}" placeholder="e.g. MAT 101" /></div></div>`);
    courseForm.addEventListener('input', () => { state.config.courseName = courseForm.elements.courseName.value.trim(); state.config.courseCode = courseForm.elements.courseCode.value.trim(); saveState({ localOnly: true }); }, true);
    courseForm.addEventListener('submit', () => { state.config.courseName = courseForm.elements.courseName.value.trim(); state.config.courseCode = courseForm.elements.courseCode.value.trim(); saveState({ localOnly: true }); }, true);
  }
  if (session?.role === 'teacher' && teacherView === 'questions' && !document.querySelector('#question-list .course-banner') && (state.config.courseName || state.config.courseCode)) {
    document.querySelector('#question-list')?.insertAdjacentHTML('beforebegin', studentCourseDetails());
  }
  clearInterval(liveRefreshTimer);
  clearInterval(teacherDeadlineTimer);
  clearInterval(studentHeartbeatTimer);
  clearInterval(studentQuizRefreshTimer);
  if (session?.role === 'teacher') {
    liveRefreshTimer = setInterval(async () => { if (teacherMutationInFlight || (teacherView === 'questions' && document.querySelector('#question-form'))) return; await refreshTeacherQuizState(); await hydrateQuizState(state, 'teacher', false); cacheHydratedState(); await refreshLiveStudents(); if (!teacherMutationInFlight && !document.activeElement?.closest('form')) app(); }, 5000);
    if (state.questionsPublished && !state.quizStopped && state.config.end) {
      teacherDeadlineTimer = setInterval(() => { if (quizHasEnded()) void expireQuizDueToTime(); }, 1000);
    }
  }
  if (session?.role === 'student' && !session.completed && session.started) {
    studentHeartbeatTimer = setInterval(() => markStudentOnline(session.username, session.quizId), 5000);
    if (!presenceWindowBound) {
      document.addEventListener('visibilitychange', () => { if (!document.hidden && session?.role === 'student' && session.started) void markStudentOnline(session.username, session.quizId); });
      window.addEventListener('focus', () => { if (session?.role === 'student' && session.started) void markStudentOnline(session.username, session.quizId); });
      presenceWindowBound = true;
    }
  }
  if (session?.role === 'student') {
    studentQuizRefreshTimer = setInterval(async () => {
      const accessResult = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
      const accessData = accessResult.data?.data;
      const hasStudentAccess = !accessResult.error && Boolean(accessData?.studentLoginActive && accessData.importedFile?.usernames?.includes(session?.username));
      if (!hasStudentAccess) return revokeStudentAccess();
      const activeAttempt = session?.role === 'student' && session.started && !session.completed ? structuredClone(session) : null;
      const previousStart = state.config.start;
      const previousEnd = state.config.end;
      const previousQuizId = state.currentQuizId;
      const previousPublished = state.questionsPublished;
      const previousStopped = state.quizStopped;
      const previousNotStarted = quizHasNotStarted();
      await refreshStudentQuizStateRaw();
      if (activeAttempt && state.quizStopped && session?.role === 'student' && !session.completed) {
        session = activeAttempt;
        await finishQuiz(true);
        return;
      }
      state.config.courseName = cleanLiveCourseValue(state.config.courseName, 'Course');
      state.config.courseCode = cleanLiveCourseValue(state.config.courseCode, '34');
      saveState();
      const availabilityChanged = previousNotStarted !== quizHasNotStarted();
      const quizStateChanged = previousQuizId !== state.currentQuizId
        || previousPublished !== state.questionsPublished
        || previousStopped !== state.quizStopped;
      const scheduleChanged = previousStart !== state.config.start || previousEnd !== state.config.end;
      if (session?.role === 'student' && !session.completed && (availabilityChanged || quizStateChanged || scheduleChanged)) app();
    }, 2000);
  }
  if (session?.role === 'teacher' && teacherView === 'questions' && (!state.config.totalQuestions || !state.config.duration)) {
    const publishButton = document.querySelector('[data-action="publish-questions"]');
    if (publishButton) publishButton.disabled = true;
  }
  if (session?.role === 'teacher' && teacherView === 'questions' && quizIsLocked()) {
    document.querySelectorAll('#question-form input, #question-form textarea, #question-form select, #question-form button, [data-action="clear-questions"], [data-action="publish-questions"], [data-action="edit-question"], [data-action="delete-question"]').forEach(control => { control.disabled = true; });
  }
  if (session?.role === 'teacher' && teacherView === 'questions' && (!state.questionsPublished || state.quizStopped)) document.querySelector('[data-action="stop-quiz"]')?.remove();
  if (session?.role === 'teacher' && teacherView === 'questions' && state.questionsPublished && !state.quizStopped && !quizHasEnded()) document.querySelector('[data-action="publish-questions"]')?.insertAdjacentHTML('afterend', '<button class="btn btn-coral btn-small" data-action="stop-quiz">Stop Quiz</button>');
  if (!session) document.querySelector('.hint')?.remove();
  if (session?.role === 'teacher' && teacherView === 'users' && !state.importedFile) document.querySelector('.upload')?.insertAdjacentHTML('afterend', '<div class="login-activation"><span><strong>Student login</strong><br><span class="subtle">Upload a workbook before activating student access.</span></span><button class="btn btn-secondary btn-small" disabled>Inactive</button></div>');
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { teacherView = button.dataset.view; app(); }));
  document.querySelectorAll('[data-action="logout"]').forEach(button => button.addEventListener('click', logout));
  const login = document.querySelector('#login-form'); if (login) login.addEventListener('submit', handleLogin);
  const questionForm = document.querySelector('#question-form'); if (questionForm) questionForm.addEventListener('submit', saveQuestion);
  document.querySelectorAll('#question-form input, #question-form textarea, #question-form select, #config-form input, #config-form select').forEach(field => field.addEventListener('input', () => saveTeacherDraft(field.form)));
  const cancelEdit = document.querySelector('[data-action="cancel-edit"]'); if (cancelEdit) cancelEdit.addEventListener('click', () => { editingQuestionId = null; app(); });
  document.querySelectorAll('[data-action="edit-question"]').forEach(button => button.addEventListener('click', () => { editingQuestionId = button.dataset.id; app(); }));
  document.querySelectorAll('[data-action="delete-question"]').forEach(button => button.addEventListener('click', () => deleteQuestion(button.dataset.id)));
  document.querySelectorAll('[data-action="expand-question"]').forEach(button => button.addEventListener('click', () => { const id = button.dataset.id; if (expandedQuestionIds.has(id)) expandedQuestionIds.delete(id); else expandedQuestionIds.add(id); const details = document.querySelector(`#details-${id}`); details.classList.toggle('expanded'); button.textContent = details.classList.contains('expanded') ? 'Collapse' : 'Expand'; }));
  const clearQuestions = document.querySelector('[data-action="clear-questions"]'); if (clearQuestions) clearQuestions.addEventListener('click', clearAllQuestions);
  const publishQuestions = document.querySelector('[data-action="publish-questions"]'); if (publishQuestions) publishQuestions.addEventListener('click', () => { if (teacherMutationInFlight) return; teacherMutationInFlight = true; void publishQuestionsForStudents().finally(() => { teacherMutationInFlight = false; }); });
  const stopQuiz = document.querySelector('[data-action="stop-quiz"]'); if (stopQuiz) stopQuiz.addEventListener('click', stopQuizForEveryone);
  const configForm = document.querySelector('#config-form'); if (configForm) configForm.addEventListener('submit', saveConfig);
  const resetConfig = document.querySelector('[data-action="reset-config"]'); if (resetConfig) resetConfig.addEventListener('click', resetQuizConfig);
  const upload = document.querySelector('#user-upload'); if (upload) upload.addEventListener('change', importUsers);
  const deleteUpload = document.querySelector('[data-action="delete-upload"]'); if (deleteUpload) deleteUpload.addEventListener('click', deleteUploadedFile);
  const toggleStudentLogin = document.querySelector('[data-action="toggle-student-login"]'); if (toggleStudentLogin) toggleStudentLogin.addEventListener('click', toggleStudentLoginActivation);
  const download = document.querySelector('[data-action="download-results"]'); if (download) download.addEventListener('click', downloadResults);
  const openResult = document.querySelector('[data-action="open-result"]'); if (openResult) openResult.addEventListener('click', downloadResults);
  const viewHistory = document.querySelector('[data-action="view-student-history"]'); if (viewHistory) viewHistory.addEventListener('click', () => document.querySelector('#student-history-panel')?.scrollIntoView({ behavior: 'smooth' }));
  const downloadHistory = document.querySelector('[data-action="download-student-history"]'); if (downloadHistory) downloadHistory.addEventListener('click', downloadStudentHistory);
  const deleteResultFile = document.querySelector('[data-action="delete-result-file"]'); if (deleteResultFile) deleteResultFile.addEventListener('click', deleteSelectedResultFile);
  const clearResultFiles = document.querySelector('[data-action="clear-result-files"]'); if (clearResultFiles) clearResultFiles.addEventListener('click', clearResultFileHistory);
  const clearHealth = document.querySelector('[data-action="clear-health"]'); if (clearHealth) clearHealth.addEventListener('click', clearAssessmentHealth);
  const clearActivity = document.querySelector('[data-action="clear-activity"]'); if (clearActivity) clearActivity.addEventListener('click', clearRecentActivity);
  const startQuiz = document.querySelector('[data-action="start-quiz"]'); if (startQuiz) startQuiz.addEventListener('click', startStudentQuiz);
  const resultSelect = document.querySelector('#result-file-select'); if (resultSelect) resultSelect.addEventListener('change', () => { selectedResultFileId = resultSelect.value; app(); });
  const addChoice = document.querySelector('[data-action="add-choice"]'); if (addChoice) addChoice.addEventListener('click', () => { const choices = document.querySelectorAll('[data-choice]'); const index = choices.length; if (index >= 8) return showToast('A question can have up to 8 choices.'); document.querySelector('#choices').insertAdjacentHTML('beforeend', choiceInput(index)); const row = document.querySelectorAll('.choice-row')[index]; row.querySelector('[data-action="remove-choice"]').addEventListener('click', () => { row.remove(); renumberChoices(); }); syncCorrectOptions(); updateChoiceCount(); });
  document.querySelectorAll('[data-action="remove-choice"]').forEach(button => button.addEventListener('click', () => { const choices = document.querySelectorAll('[data-choice]'); if (choices.length <= 2) return showToast('Keep at least two choices.'); button.closest('.choice-row').remove(); renumberChoices(); }));
  document.querySelectorAll('[data-answer]').forEach(button => button.addEventListener('click', () => { if (!session || session.completed || state.quizStopped) return; if (!session.feedback) { session.selected = Number(button.dataset.answer); saveStudentSession(); app(); } }));
  const submit = document.querySelector('[data-action="submit-answer"]'); if (submit) submit.addEventListener('click', submitAnswer);
  const next = document.querySelector('[data-action="next-question"]'); if (next) next.addEventListener('click', nextQuestion);
  if (session?.role === 'student' && !session.completed && session.started && document.querySelector('#timer')) startTimer();
}
async function handleLogin(event) { event.preventDefault(); if (stateHydrationPromise) await stateHydrationPromise; const form = new FormData(event.target); const username = String(form.get('username')).trim(); const password = String(form.get('password')); if (username.toLowerCase() === TEACHER.username) { if (password !== TEACHER.password) return showToast('Incorrect Username or Password'); session = { role: 'teacher', username: TEACHER.username }; teacherView = 'overview'; app(); return; } const importedUsername = state.importedFile?.usernames?.find(item => item === username); const student = state.studentLoginActive && state.importedFile && importedUsername ? state.users.find(user => user.username === importedUsername && user.password === password) : null; if (!student) return showToast('Incorrect Username or Password'); const previous = state.results.find(result => result.username === username && state.questionsPublished && state.currentQuizId && result.quizId === state.currentQuizId); if (previous) { session = { role: 'student', username: student.username, quizId: state.currentQuizId, completed: true, result: previous }; app(); return; } const savedSession = state.studentSessions[student.username]; const originalQuestions = state.questions; const questionOrder = savedSession?.questionOrder?.length ? savedSession.questionOrder : shuffleQuestions(originalQuestions, username); state.questions = questionOrder; state.users = state.users.map(user => user.username === student.username ? { ...user, status: 'online', lastSeen: new Date().toISOString() } : user); session = savedSession && savedSession.quizId === state.currentQuizId ? { ...savedSession, role: 'student', originalQuestions, questionOrder } : { role: 'student', username: student.username, quizId: state.currentQuizId, originalQuestions, questionOrder, index: 0, selected: null, feedback: null, remaining: Math.max(60, state.config.duration * 60), answers: [] }; if (!session.started) session.remaining = Math.max(60, Number(state.config.duration) * 60); void markStudentOnline(student.username, session.quizId); saveStudentSession(); app(); }
function logout() { stopTimer(); if (session?.role === 'student') { void markStudentOffline(session.username, session.quizId); state.users = state.users.map(user => user.username === session.username ? { ...user, status: 'offline', lastSeen: new Date().toISOString() } : user); if (session.originalQuestions) state.questions = session.originalQuestions; saveState(); } session = null; saveWindowSession(); app(); }
async function confirmMultipleChoiceQuestionSaved(question) {
  const { data, error } = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;

  const snapshot = data?.data?.currentQuizQuestions;
  const savedQuestion = snapshot?.quizId === state.currentQuizId && Array.isArray(snapshot.questions)
    ? snapshot.questions.find(item => item.id === question.id)
    : null;
  if (!savedQuestion
    || savedQuestion.text !== question.text
    || Number(savedQuestion.correct) !== Number(question.correct)
    || Number(savedQuestion.marks) !== Number(question.marks)
    || JSON.stringify(savedQuestion.choices || []) !== JSON.stringify(question.choices)) {
    throw new Error('Supabase did not confirm this multiple-choice question in the question bank.');
  }
}

async function saveQuestion(event) {
  event.preventDefault();
  if (quizIsLocked()) return showToast('Stop the quiz before changing questions.');

  const data = new FormData(event.target);
  const choices = [...event.target.querySelectorAll('input[name="choice"]')]
    .map(input => input.value.trim())
    .filter(Boolean);
  const correct = Math.min(Number(data.get('correct')), choices.length - 1);
  const id = data.get('id') || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const question = {
    id,
    text: String(data.get('text') || '').trim(),
    choices,
    correct,
    marks: Number(data.get('marks')) || 1
  };
  state.config.courseName = String(data.get('courseName') ?? '').trim();
  state.config.courseCode = String(data.get('courseCode') ?? '').trim();
  saveQuestionLocally(question);
}

function saveQuestionLocally(question) {
  const existingIndex = state.questions.findIndex(item => item.id === question.id);
  const existing = existingIndex >= 0 ? state.questions[existingIndex] : null;
  const localId = existing?.localId || existing?.id || question.id;
  const version = (existing?.syncVersion || 0) + 1;
  const savedLocally = { ...question, localId, syncVersion: version, syncStatus: 'pending', syncError: '' };
  if (existingIndex >= 0) state.questions[existingIndex] = savedLocally;
  else state.questions.push(savedLocally);

  const questionNumber = String((existingIndex >= 0 ? existingIndex : state.questions.length - 1) + 1).padStart(2, '0');
  state.questionsPublished = false;
  state.studentSessions = {};
  delete state.drafts.questions;
  editingQuestionId = null;
  state.activity.unshift({
    text: `${existing ? 'A saved question was updated' : 'A new question was added'} (${questionNumber})`,
    type: 'question',
    time: new Date().toISOString()
  });
  state.activity = state.activity.slice(0, 20);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));
  app();
  void syncQuestionInBackground(localId, version, questionNumber);
}

async function syncQuestionInBackground(localId, version, questionNumber) {
  try {
    const savedId = await persistQuestionToSupabase(state, localId);
    const question = state.questions.find(item => item.localId === localId || item.id === localId);
    if (!question) return;
    question.id = savedId;
    if (question.syncVersion !== version) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));
      return;
    }
    question.syncStatus = 'saved';
    question.syncError = '';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));
    showToast(`Q${questionNumber} successfully saved to question bank.`);
  } catch (error) {
    const question = state.questions.find(item => item.localId === localId || item.id === localId);
    if (!question || question.syncVersion !== version) return;
    question.syncStatus = 'failed';
    question.syncError = error.message || String(error);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));
    showToast(`Q${questionNumber} failed to save to Supabase. It remains saved locally; edit and retry.`, 'error');
  }
  app();
}
async function confirmQuestionRemovedFromBank(questionId) {
  const [questionsResult, configResult, workspaceResult] = await Promise.all([
    supabase.from('questions').select('id'),
    supabase.from('quiz_config').select('quiz_id, published').eq('id', 1).maybeSingle(),
    supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle()
  ]);
  if (questionsResult.error) throw questionsResult.error;
  if (configResult.error) throw configResult.error;
  if (workspaceResult.error) throw workspaceResult.error;

  const savedQuestions = workspaceResult.data?.data?.currentQuizQuestions;
  const persistedIds = new Set(questionsResult.data.map(question => question.id));
  const persistedQuizId = configResult.data?.quiz_id ?? null;
  if (persistedIds.has(questionId)
    || persistedIds.size !== state.questions.length
    || state.questions.some(question => !persistedIds.has(question.id))
    || persistedQuizId !== state.currentQuizId
    || Boolean(configResult.data?.published)
    || savedQuestions?.quizId !== persistedQuizId
    || !Array.isArray(savedQuestions.questions)
    || savedQuestions.questions.length !== state.questions.length
    || savedQuestions.questions.some(question => question.id === questionId)
    || state.questions.some(question => !savedQuestions.questions.some(saved => saved.id === question.id))) {
    throw new Error('Supabase did not confirm that the question was removed from the question bank.');
  }
}

async function deleteQuestion(id) {
  if (quizIsLocked()) return showToast('Stop the quiz before changing questions.');
  if (teacherMutationInFlight) return;
  if (!state.questions.some(question => question.id === id)) return showToast('This question is no longer in the question bank.');

  const previousState = {
    questions: structuredClone(state.questions),
    questionsPublished: state.questionsPublished,
    quizStopped: state.quizStopped,
    currentQuizId: state.currentQuizId,
    studentSessions: structuredClone(state.studentSessions),
    config: structuredClone(state.config),
    activity: structuredClone(state.activity)
  };
  teacherMutationInFlight = true;

  try {
    state.questions = state.questions.filter(question => question.id !== id);
    state.questionsPublished = false;
    state.quizStopped = false;
    state.currentQuizId = null;
    state.studentSessions = {};
    state.config.totalQuestions = Math.min(state.config.totalQuestions || state.questions.length, state.questions.length);
    state.activity.unshift({ text: 'A saved question was deleted', type: 'question', time: new Date().toISOString() });
    state.activity = state.activity.slice(0, 20);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));

    await persistQuizState(state, 'teacher', { waitForSync: true });
    await confirmQuestionRemovedFromBank(id);
    showToast('Question deleted and current quiz cleared.');
  } catch (error) {
    state.questions = previousState.questions;
    state.questionsPublished = previousState.questionsPublished;
    state.quizStopped = previousState.quizStopped;
    state.currentQuizId = previousState.currentQuizId;
    state.studentSessions = previousState.studentSessions;
    state.config = previousState.config;
    state.activity = previousState.activity;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));
    void persistQuizState(state, 'teacher');
    showToast(`Question was not confirmed deleted: ${error.message || error}`, 'error');
  } finally {
    teacherMutationInFlight = false;
    app();
  }
}
async function clearAllQuestions() {
  if (quizIsLocked() || teacherMutationInFlight) return showToast('Stop the quiz before changing questions.');
  const previousState = structuredClone(state);
  teacherMutationInFlight = true;
  try {
    state.questions = [];
    state.questionsPublished = false;
    state.quizStopped = false;
    state.currentQuizId = null;
    state.configSaved = false;
    state.studentSessions = {};
    state.config = { courseName: state.config.courseName || '', courseCode: state.config.courseCode || '', totalQuestions: 0, duration: 0, start: '', end: '' };
    saveState();
    addActivity('All saved questions were cleared', 'question');

    let syncError = null;
    try {
      await persistQuizControlState();
      await persistQuizState(state, 'teacher', { waitForSync: true });
    } catch (error) {
      syncError = error;
    }

    if (!(await confirmQuestionBankCleared())) {
      throw syncError || new Error('Supabase did not confirm that the question bank was cleared.');
    }
    await confirmSavedConfiguration(false);
    showToast('Question bank and quiz configuration cleared.');
  } catch (error) {
    restoreState(previousState);
    void persistQuizState(state, 'teacher');
    showToast(`Question bank could not be cleared: ${error.message || error}`, 'error');
  } finally {
    teacherMutationInFlight = false;
    app();
  }
}
async function publishQuestionsForStudents() { if (quizIsLocked()) return showToast('Stop the quiz before submitting new questions.'); if (!state.questions.length) return showToast('Add at least one saved question first.'); if (!state.config.totalQuestions || !state.config.duration) return showToast('Save quiz configuration before submitting questions.'); if (quizHasEnded()) return showToast('The quiz end time has passed. Update Quiz configuration, then submit again.'); state.questionsPublished = true; state.quizStopped = false; state.currentQuizId = `quiz-${Date.now()}`; const submittedQuizId = state.currentQuizId; state.studentSessions = {}; state.healthClearedAt = null; state.config.totalQuestions = Math.min(state.config.totalQuestions || state.questions.length, state.questions.length); saveState(); let syncError = null; try { await persistQuizControlState(); await persistQuizState(state, 'teacher', { waitForSync: true }); } catch (error) { syncError = error; } let confirmed = false; try { confirmed = await confirmPublishedQuiz(submittedQuizId); } catch (error) { syncError = syncError || error; } if (!confirmed) { state.questionsPublished = false; state.currentQuizId = null; localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage())); showToast(`Quiz submission could not be confirmed in Supabase${syncError ? `: ${syncError.message || syncError}` : '.'}`, 'error'); app(); return; } addActivity('Saved questions were submitted to students', 'check'); showToast('New quiz submitted. Students can start it now.'); app(); }
async function stopQuizForEveryoneLegacy() { if (!state.questionsPublished || !state.currentQuizId || teacherMutationInFlight) return; teacherMutationInFlight = true; try { const stoppedQuizId = state.currentQuizId; state.deletedQuizIds = [...new Set([...state.deletedQuizIds, stoppedQuizId])]; state.results = state.results.filter(result => result.quizId !== stoppedQuizId); state.studentHistory = state.studentHistory.filter(result => result.quizId !== stoppedQuizId); state.resultFiles = state.resultFiles.filter(file => !file.id.includes(stoppedQuizId)); state.healthClearedAt = null; state.quizStopped = true; state.questionsPublished = false; state.currentQuizId = null; state.configSaved = false; Object.keys(state.studentSessions).forEach(username => delete state.studentSessions[username]); state.activity.unshift({ text: 'Quiz stopped for all students and its records were removed', type: 'results', time: new Date().toISOString() }); state.activity = state.activity.slice(0, 20); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); await persistQuizControlState(); await persistQuizState(state, 'teacher', { waitForSync: true }); await confirmSavedConfiguration(false); const { data, error } = await supabase.from('quiz_config').select('quiz_id, published, stopped').eq('id', 1).maybeSingle(); if (error || !data || !data.stopped || data.published || data.quiz_id) throw error || new Error('Supabase did not confirm the stopped quiz state.'); showToast('Quiz stopped. You can edit the questions and submit an updated quiz.'); app(); } catch (error) { showToast(`Quiz stop could not be confirmed: ${error.message || error}`); } finally { teacherMutationInFlight = false; } }
async function saveConfigLegacy(event) { event.preventDefault(); if (state.configSaved) return showToast('The time set is already saved.'); if (teacherMutationInFlight) return; const data = new FormData(event.target); const start = String(data.get('start') || ''); const end = String(data.get('end') || ''); if (end && new Date(end).getTime() <= Date.now()) return showToast('End date & time must be in the future.'); if (start && end && new Date(end).getTime() <= new Date(start).getTime()) return showToast('End date & time must be after the start date & time.'); const wasEnded = quizHasEnded(); const expiredPublishedQuiz = wasEnded && state.questionsPublished && !state.quizStopped; teacherMutationInFlight = true; try { state.config = { courseName: state.config.courseName || '', courseCode: state.config.courseCode || '', totalQuestions: Math.min(Number(data.get('totalQuestions')) || 0, state.questions.length), duration: Number(data.get('duration')) || 0, start, end }; state.configSaved = true; if (expiredPublishedQuiz) { state.currentQuizId = null; state.questionsPublished = false; state.quizStopped = false; state.studentSessions = {}; state.healthClearedAt = null; } else { Object.values(state.studentSessions).forEach(studentSession => { if (!studentSession.started) studentSession.remaining = Math.max(60, state.config.duration * 60); }); } delete state.drafts.config; saveState(); await persistQuizControlState(); await persistQuizState(state, 'teacher', { waitForSync: true }); await confirmSavedConfiguration(true); addActivity(expiredPublishedQuiz ? 'Expired quiz questions are ready as a new draft' : 'Quiz configuration was updated', 'settings'); showToast(expiredPublishedQuiz ? 'Configuration saved. Submit the saved questions to create the new quiz.' : 'Quiz configuration saved.'); } catch (error) { state.configSaved = false; saveState(); showToast(`Configuration could not be saved: ${error.message || error}`); } finally { teacherMutationInFlight = false; app(); } }
async function resetQuizConfig() { if (teacherMutationInFlight) return; teacherMutationInFlight = true; const questionCount = state.questions.length; try { state.config = { courseName: state.config.courseName || '', courseCode: state.config.courseCode || '', totalQuestions: questionCount, duration: 0, start: '', end: '' }; state.configSaved = false; state.configResetAt = new Date().toISOString(); delete state.drafts.config; state.activity.unshift({ text: 'Quiz configuration was reset', type: 'settings', time: new Date().toISOString() }); state.activity = state.activity.slice(0, 20); localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage())); await persistQuizControlState(); await persistQuizState(state, 'teacher', { workspaceOnly: true, waitForSync: true }); await confirmSavedConfiguration(false, questionCount); showToast('Assessment rules reset.'); } catch (error) { showToast(`Assessment rules could not be reset: ${error.message || error}`); } finally { teacherMutationInFlight = false; app(); } }
function updateChoiceCount() { const count = document.querySelectorAll('[data-choice]').length; const label = document.querySelector('#choice-count'); if (label) label.textContent = `(${count})`; }
function syncCorrectOptions() { const select = document.querySelector('#correct-answer'); if (!select) return; const selected = Number(select.value); select.innerHTML = [...document.querySelectorAll('[data-choice]')].map((input, index) => `<option value="${index}">Choice ${String.fromCharCode(65 + index)}</option>`).join(''); select.value = String(Math.min(selected, select.options.length - 1)); }
function renumberChoices() { document.querySelectorAll('[data-choice]').forEach((input, index) => { input.dataset.choice = index; input.placeholder = `Choice ${String.fromCharCode(65 + index)}`; }); document.querySelectorAll('#choices .choice-row').forEach((row, index) => row.querySelector('button').setAttribute('data-index', index)); syncCorrectOptions(); updateChoiceCount(); }
function validateCredentialRows(rows) { const credentials = []; const usernames = new Set(); const passwords = new Set(); const usernamePattern = /^(?=.*\d)[0-9A-Z./-]+$/; const passwordPattern = /^[A-Z]+$/; for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) { const row = rows[rowIndex].map(value => String(value ?? '').trim()); if (!row.some(Boolean)) continue; for (let column = 0; column < row.length; column += 2) { const username = row[column] || ''; const password = row[column + 1] || ''; const usernameColumn = column + 1; const passwordColumn = column + 2; if (!username && !password) continue; if (!username) return { error: `Row ${rowIndex + 1}, column ${usernameColumn}: missing username for password in row ${rowIndex + 1}, column ${passwordColumn}.` }; if (!password) return { error: `Row ${rowIndex + 1}, column ${passwordColumn}: missing password for username in row ${rowIndex + 1}, column ${usernameColumn}.` }; if (username.toLowerCase() === 'username' && password.toLowerCase() === 'password') continue; if (!usernamePattern.test(username)) return { error: `Row ${rowIndex + 1}, column ${usernameColumn}: invalid username "${username}". Use digits with optional capital letters, -, /, or .` }; if (!passwordPattern.test(password)) return { error: `Row ${rowIndex + 1}, column ${passwordColumn}: invalid password. Passwords must contain capital letters only.` }; if (usernames.has(username)) return { error: `Row ${rowIndex + 1}, column ${usernameColumn}: duplicate username "${username}".` }; if (passwords.has(password)) return { error: `Row ${rowIndex + 1}, column ${passwordColumn}: duplicate password.` }; usernames.add(username); passwords.add(password); credentials.push({ username, password }); } } return { credentials }; }
async function confirmImportedFile(file) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
    const { data, error } = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
    if (error) return false;
    const importedFile = data?.data?.importedFile;
    if (importedFile?.name === file.name && importedFile.count === file.count && importedFile.usernames?.length === file.usernames.length) return true;
  }
  return false;
}
async function confirmQuestionBankCleared() {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
    const [questionsResult, configResult, workspaceResult] = await Promise.all([
      supabase.from('questions').select('id'),
      supabase.from('quiz_config').select('quiz_id, published, total_questions, duration, start_time, end_time').eq('id', 1).maybeSingle(),
      supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle()
    ]);
    if (questionsResult.error || configResult.error || workspaceResult.error) continue;
    const config = configResult.data;
    const snapshot = workspaceResult.data?.data?.currentQuizQuestions;
    const rulesCleared = !config || (!config.quiz_id && !config.published && !Number(config.total_questions) && !Number(config.duration) && !config.start_time && !config.end_time);
    const snapshotCleared = snapshot?.quizId === null && Array.isArray(snapshot.questions) && snapshot.questions.length === 0;
    if (!questionsResult.data.length && rulesCleared && snapshotCleared) return true;
  }
  return false;
}
async function confirmImportedFileDeleted() {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
    const { data, error } = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
    if (error) continue;
    if (!data?.data?.importedFile && !data?.data?.studentLoginActive) return true;
  }
  return false;
}
async function confirmStudentLoginState(expected) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
    const { data, error } = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
    if (error) return false;
    if (Boolean(data?.data?.studentLoginActive) === expected) return true;
  }
  return false;
}
async function persistWorkspaceChange(confirmChange) {
  try {
    await persistQuizState(state, 'teacher', { waitForSync: true, workspaceOnly: true });
  } catch (error) {
    if (!(await confirmChange())) throw error;
    return;
  }
  if (!(await confirmChange())) throw new Error('Supabase did not confirm the workspace change.');
}
async function importUsers(event) { const file = event.target.files[0]; if (!file || !window.XLSX || state.studentLoginActive) return; const previousState = structuredClone(state); teacherMutationInFlight = true; try { const buffer = await file.arrayBuffer(); const workbook = XLSX.read(buffer, { type: 'array' }); const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 }); const validation = validateCredentialRows(rows); if (validation.error || !validation.credentials.length) { event.target.value = ''; showToast(validation.error || 'The workbook contains no student credentials.'); return; } removeImportedUsers(); const importedUsernames = []; validation.credentials.forEach(({ username, password }) => { state.users.push({ username, password, status: 'offline', lastSeen: null }); importedUsernames.push(username); }); state.importedFile = { name: file.name, count: validation.credentials.length, uploadedAt: new Date().toISOString(), usernames: importedUsernames }; state.studentLoginActive = false; saveState({ workspaceOnly: true }); addActivity(`${validation.credentials.length} student account${validation.credentials.length === 1 ? '' : 's'} imported`, 'users'); await persistWorkspaceChange(() => confirmImportedFile(state.importedFile)); showToast(`${validation.credentials.length} student account${validation.credentials.length === 1 ? '' : 's'} imported.`); app(); } catch (error) { restoreState(previousState); showToast(`Workbook import could not be saved: ${error.message || error}`); } finally { teacherMutationInFlight = false; } }
function removeImportedUsers() { const usernames = new Set(state.importedFile?.usernames || []); if (usernames.size) state.users = state.users.filter(user => !usernames.has(user.username)); state.importedFile = null; state.studentLoginActive = false; }
async function deleteUploadedFile() { if (state.studentLoginActive || teacherMutationInFlight) return; const previousState = structuredClone(state); teacherMutationInFlight = true; try { const usernames = state.importedFile?.usernames || []; await markStudentsOffline(usernames, state.currentQuizId); removeImportedUsers(); saveState({ workspaceOnly: true }); addActivity('The uploaded student workbook was deleted', 'users'); await persistWorkspaceChange(confirmImportedFileDeleted); showToast('Uploaded file removed.'); app(); } catch (error) { restoreState(previousState); showToast(`Uploaded file could not be deleted: ${error.message || error}`); } finally { teacherMutationInFlight = false; } }
async function toggleStudentLoginActivation() { if (!state.importedFile || teacherMutationInFlight) return; const previousState = structuredClone(state); teacherMutationInFlight = true; try { state.studentLoginActive = !state.studentLoginActive; const expectedState = state.studentLoginActive; if (!expectedState) await markStudentsOffline(state.importedFile.usernames || [], state.currentQuizId); saveState({ workspaceOnly: true }); addActivity(`Uploaded student login ${expectedState ? 'activated' : 'deactivated'}`, 'users'); await persistWorkspaceChange(() => confirmStudentLoginState(expectedState)); showToast(expectedState ? 'Uploaded credentials are now active.' : 'Uploaded credentials are inactive. All imported students were signed out.'); app(); } catch (error) { restoreState(previousState); showToast(`Student login status could not be saved: ${error.message || error}`); } finally { teacherMutationInFlight = false; } }
function resultFileQuizIds(file) { const quizIds = new Set(); if (file?.id?.startsWith('quiz-')) quizIds.add(file.id.slice(5)); (file?.rows || []).forEach(row => { if (row.quizId) quizIds.add(row.quizId); }); return [...quizIds]; }
async function confirmDeletedResultFile(fileId, quizIds) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
    const { data, error } = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
    if (error) return false;
    const workspace = data?.data || {};
    const deletedQuizIds = new Set(workspace.deletedQuizIds || []);
    const fileStillExists = (workspace.resultFiles || []).some(file => file.id === fileId);
    if (!fileStillExists && quizIds.every(quizId => deletedQuizIds.has(quizId))) return true;
  }
  return false;
}
async function confirmDeletedQuizAttempts(quizIds) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
    const { data, error } = await supabase.from('quiz_attempts').select('quiz_id').in('quiz_id', quizIds);
    if (!error && (!data || data.length === 0)) return true;
    if (error && attempt === 3) return false;
  }
  return false;
}
async function deleteSelectedResultFile() { const file = state.resultFiles.find(item => item.id === selectedResultFileId) || state.resultFiles[0]; if (!file || teacherMutationInFlight) return; const quizIds = resultFileQuizIds(file); teacherMutationInFlight = true; try { state.deletedQuizIds = [...new Set([...state.deletedQuizIds, ...quizIds])]; state.results = state.results.filter(result => !quizIds.includes(result.quizId)); state.studentHistory = state.studentHistory.filter(result => !quizIds.includes(result.quizId)); state.resultFiles = state.resultFiles.filter(item => item.id !== file.id); selectedResultFileId = state.resultFiles[0]?.id || null; saveState(); try { await persistQuizState(state, 'teacher', { waitForSync: true }); } catch (error) { if (!(await confirmDeletedResultFile(file.id, quizIds))) throw error; } addActivity(`Result file ${file.name} was deleted`, 'results'); showToast('Selected quiz results deleted permanently.'); } catch (error) { showToast(`Selected results could not be deleted: ${error.message || error}`); } finally { teacherMutationInFlight = false; app(); } }
async function clearResultFileHistory() {
  if ((!state.resultFiles.length && !state.results.length) || teacherMutationInFlight) return;
  const quizIds = new Set([...state.resultFiles.flatMap(resultFileQuizIds), ...state.results.map(result => result.quizId)].filter(Boolean));
  if (!quizIds.size) return showToast('Results could not be cleared because no quiz IDs were found.', 'error');
  const previousState = structuredClone(state);
  const previousSelectedResultFileId = selectedResultFileId;
  teacherMutationInFlight = true;
  try {
    state.deletedQuizIds = [...new Set([...state.deletedQuizIds, ...quizIds])];
    state.resultFiles = [];
    state.results = [];
    state.studentHistory = [];
    selectedResultFileId = null;
    state.activity.unshift({ text: 'All quiz result file history was cleared', type: 'results', time: new Date().toISOString() });
    state.activity = state.activity.slice(0, 20);
    await persistQuizState(state, 'teacher', { waitForSync: true, workspaceOnly: true });
    await deleteQuizAttempts([...quizIds]);
    showToast('Quiz result history cleared.');
  } catch (error) {
    restoreState(previousState);
    selectedResultFileId = previousSelectedResultFileId;
    showToast(`Quiz result history could not be cleared: ${error.message || error}`);
  } finally {
    teacherMutationInFlight = false;
    app();
  }
}
function clearAssessmentHealth() { if (!healthResults().length) return; state.healthClearedAt = new Date().toISOString(); saveState(); addActivity('Assessment health metrics were cleared', 'results'); showToast('Assessment health cleared. Result files are still available.'); app(); }
let activityClearInFlight = false;
async function clearRecentActivity() {
  if (!state.activity.length || activityClearInFlight) return;
  const previousActivity = state.activity;
  const previousClearedAt = state.activityClearedAt;
  const clearedAt = new Date().toISOString();
  state.activityClearedAt = clearedAt;
  state.activity = filterActivityBeforeClear(state.activity, clearedAt);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));
  app();
  activityClearInFlight = true;
  try {
    state.activityClearedAt = await persistActivityClear(state, clearedAt);
    state.activity = filterActivityBeforeClear(state.activity, state.activityClearedAt);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));
    showToast('Recent activity cleared.');
  } catch (error) {
    state.activityClearedAt = previousClearedAt;
    state.activity = [...state.activity, ...previousActivity]
      .filter((item, index, items) => items.findIndex(candidate => candidate.text === item.text && candidate.time === item.time) === index)
      .sort((left, right) => Date.parse(right.time || '') - Date.parse(left.time || ''))
      .slice(0, 20);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage()));
    showToast(`Recent activity could not be cleared: ${error.message || error}`, 'error');
  } finally {
    activityClearInFlight = false;
    app();
  }
}
function downloadResults() { if (!window.XLSX) return; const file = state.resultFiles.find(item => item.id === selectedResultFileId) || state.resultFiles[0]; const results = file?.rows || state.results; if (!results.length) return; const rows = [['Student username', 'Number of questions attempted', 'Number answered incorrectly', 'Total marks obtained', 'Percentage score'], ...results.map(result => [result.username, result.attempted, result.incorrect, result.score, `${result.percentage}%`])]; const sheet = XLSX.utils.aoa_to_sheet(rows); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Results'); XLSX.writeFile(book, `${file?.name || 'online-quiz-results'}.xlsx`); showToast('Results workbook downloaded.'); }
function downloadStudentHistory() { if (!window.XLSX || !session) return; const history = state.studentHistory.filter(item => item.username === session.username); if (!history.length) return; const rows = [['Date', 'Duration (minutes)', 'Questions attempted', 'Questions right', 'Questions wrong', 'Marks scored', 'Total marks'], ...history.map(item => [formatDate(item.completedAt), item.durationMinutes, item.attempted, item.correct, item.incorrect, item.score, item.totalMarks])]; const sheet = XLSX.utils.aoa_to_sheet(rows); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Quiz history'); XLSX.writeFile(book, `${session.username}-quiz-history.xlsx`); showToast('Your quiz history was downloaded.'); }
function startTimer() { stopTimer(); timerId = setInterval(() => { if (!session || session.role !== 'student' || session.completed) return stopTimer(); if (state.quizStopped) { showToast('The quiz was stopped. Your current attempt is being submitted.'); void finishQuiz(true); return; } if (session.quizId !== state.currentQuizId) { stopTimer(); app(); return; } if (quizHasEnded()) { showToast('The deadline is reached. Your quiz is being submitted.'); void finishQuiz(true); return; } session.remaining -= 1; saveStudentSession(); const timer = document.querySelector('#timer'); if (timer) timer.textContent = formatTime(session.remaining); if (session.remaining <= 0) { showToast('Time is up. Your quiz is being submitted.'); void finishQuiz(true); } }, 1000); }
function stopTimer() { if (timerId) clearInterval(timerId); timerId = null; }
function submitAnswer() { if (state.quizStopped || quizHasEnded() || session.quizId !== state.currentQuizId) return showToast('This quiz is no longer active.'); const orderedQuestions = session.questionOrder || state.questions; const question = orderedQuestions[session.index]; session.feedback = { correct: session.selected === question.correct }; session.answers.push({ questionId: question.id, selected: session.selected, correct: session.feedback.correct }); saveStudentSession(); app(); }
function nextQuestion() { if (state.quizStopped || quizHasEnded() || session.quizId !== state.currentQuizId) return showToast('This quiz is no longer active.'); const orderedQuestions = session.questionOrder || state.questions; if (session.index >= Math.min(state.config.totalQuestions, orderedQuestions.length) - 1) return finishQuiz(false); session.index += 1; session.selected = null; session.feedback = null; saveStudentSession(); app(); }
function finalizeStudentResult(studentSession, autoSubmitted) {
  const orderedQuestions = studentSession.questionOrder || state.questions;
  const count = Math.min(state.config.totalQuestions || orderedQuestions.length, orderedQuestions.length);
  const quizQuestions = orderedQuestions.slice(0, count);
  const answersById = Object.fromEntries((studentSession.answers || []).map(answer => [answer.questionId, answer]));
  let score = 0;
  let totalMarks = 0;
  let incorrect = 0;
  let correct = 0;
  let partial = 0;

  quizQuestions.forEach(question => {
    const questionMarks = Math.round(Number(question.marks) || 0);
    totalMarks += questionMarks;
    const answer = answersById[question.id];
    const savedMarks = Number(answer?.marksAwarded);
    const marksAwarded = answer && Number.isFinite(savedMarks)
      ? Math.round(Math.min(questionMarks, Math.max(0, savedMarks)))
      : answer?.correct ? questionMarks : 0;
    score += marksAwarded;
    if (answer?.correct) correct++;
    else if (answer?.partial || marksAwarded > 0) partial++;
    else if (answer) incorrect++;
  });

  const result = {
    username: studentSession.username,
    quizId: studentSession.quizId || state.currentQuizId,
    answers: studentSession.answers || [],
    attempted: (studentSession.answers || []).length,
    correct,
    incorrect,
    partial,
    score,
    totalMarks,
    percentage: totalMarks ? Math.round(score / totalMarks * 100) : 0,
    durationMinutes: Math.max(1, Math.ceil(((Number(state.config.duration) || 0) * 60 - (studentSession.remaining ?? 0)) / 60)),
    completedAt: new Date().toISOString()
  };

  state.results = [...state.results.filter(item => !(item.username === result.username && item.quizId === result.quizId)), result];
  state.studentHistory = [...state.studentHistory.filter(item => !(item.username === result.username && item.quizId === result.quizId)), result];
  const fileId = `quiz-${result.quizId || new Date().toISOString().slice(0, 10)}`;
  const existingFile = state.resultFiles.find(file => file.id === fileId);
  if (existingFile) existingFile.rows = [...existingFile.rows.filter(item => item.username !== result.username), result];
  else state.resultFiles.unshift({ id: fileId, name: `online-quiz-results-${new Date().toISOString().slice(0, 10)}`, createdAt: new Date().toISOString(), rows: [result] });

  state.users = state.users.map(user => user.username === result.username ? { ...user, status: 'offline', lastSeen: new Date().toISOString() } : user);
  studentSession.completed = true;
  studentSession.result = result;

  return result;
}

async function finishQuiz(autoSubmitted) {
  stopTimer();
  if (!session || session.completed) return;
  const result = finalizeStudentResult(session, autoSubmitted);
  session.completed = true;
  session.result = result;
  state.activity.unshift({ text: `${session.username} ${autoSubmitted ? 'was auto-submitted' : 'completed the quiz'}`, type: 'check', time: new Date().toISOString() });
  state.activity = state.activity.slice(0, 20);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  try {
    await persistQuizState(state, 'student', { waitForSync: true });
    showToast('Your answers were saved successfully.');
  } catch (error) {
    showToast(`Your result was saved locally, but Supabase synchronization failed: ${error.message || error}`, 'error');
  }
  app();
}
function cacheHydratedState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForLocalStorage())); }

questionList = function renderTypedQuestionList() {
  if (!state.questions.length) return '<div class="empty">Your question bank is empty. Add a question to begin.</div>';
  return state.questions.map((question, index) => {
    const shortAnswer = question.type === 'short-answer';
    const questionNumber = `Q${String(index + 1).padStart(2, '0')}`;
    const syncStatus = question.syncStatus === 'pending'
      ? `${questionNumber} saving to Supabase...`
      : question.syncStatus === 'failed'
        ? `${questionNumber} failed to save to Supabase. It remains saved locally; edit and retry.`
        : question.syncStatus === 'saved'
          ? `${questionNumber} successfully saved to question bank`
          : '';
    const details = shortAnswer
      ? `<p class="subtle" style="margin-bottom:0">Expected answer: ${esc(question.answer || '')}</p>`
      : `<p class="subtle" style="margin-bottom:0">${question.choices.length} choices · Correct answer: ${String.fromCharCode(65 + question.correct)}</p>${question.choices.map((choice, choiceIndex) => `<div class="subtle">${String.fromCharCode(65 + choiceIndex)}. ${esc(choice)}</div>`).join('')}`;
    return `<article class="question-item"><div class="question-meta"><span class="badge">${questionNumber}</span><span>${shortAnswer ? 'Short answer' : 'Multiple choice'} · ${question.marks} marks</span></div>${syncStatus ? `<p class="subtle" aria-live="polite">${esc(syncStatus)}</p>` : ''}<h3 style="margin-top:12px">${esc(question.text)}</h3><div class="question-details" id="details-${question.id}">${details}</div><div class="question-actions"><button class="btn btn-secondary btn-small" data-action="expand-question" data-id="${question.id}">Expand</button><button class="btn btn-secondary btn-small" data-action="edit-question" data-id="${question.id}">Edit</button><button class="btn btn-coral btn-small" data-action="delete-question" data-id="${question.id}">Delete</button></div></article>`;
  }).join('');
};

const multipleChoiceQuestionView = questionsView;
questionsView = function questionBankWithShortAnswers() {
  const questionBeingEdited = state.questions.find(question => question.id === editingQuestionId);
  const editingShortAnswer = questionBeingEdited?.type === 'short-answer';
  const selectedQuestionId = editingQuestionId;
  if (editingShortAnswer) editingQuestionId = null;
  let markup = multipleChoiceQuestionView();
  editingQuestionId = selectedQuestionId;
  if (editingShortAnswer) {
    markup = markup.replace('<h2>Create a question</h2>', '<h2>Edit short answer question</h2>');
    markup = markup.replace('<form id="question-form">', '<form id="question-form" hidden>');
  }
  const disabled = quizIsLocked() ? 'disabled' : '';
  const shortAnswerForm = `<section class="short-answer-section"><div class="short-answer-heading"><h3>${editingShortAnswer ? 'Edit short answer question' : 'Short answer question'}</h3><p class="subtle">Add a reusable question with its expected answer.</p></div><form id="short-answer-form"><input type="hidden" name="shortId" value="${editingShortAnswer ? esc(questionBeingEdited.id) : ''}" /><div class="field"><label>Question prompt</label><textarea name="shortText" placeholder="Write the question students will see..." required ${disabled}>${editingShortAnswer ? esc(questionBeingEdited.text) : ''}</textarea></div><div class="form-grid" style="margin-top:15px"><div class="field"><label>Expected answer</label><input name="expectedAnswer" placeholder="Write the correct answer" value="${editingShortAnswer ? esc(questionBeingEdited.answer || '') : ''}" required ${disabled} /></div><div class="field"><label>Marks</label><input name="shortMarks" type="number" min="1" value="${editingShortAnswer ? Number(questionBeingEdited.marks) || 1 : ''}" placeholder="Enter marks" required ${disabled} /></div></div><div style="display:flex;gap:9px;margin-top:18px"><button class="btn btn-primary" ${disabled}>${editingShortAnswer ? 'Update short answer' : 'Save short answer'}</button>${editingShortAnswer ? '<button type="button" class="btn btn-secondary" data-action="cancel-edit">Cancel</button>' : ''}</div></form></section>`;
  return markup.replace('</form></div><div class="card panel">', `</form>${shortAnswerForm}</div><div class="card panel">`);
};

async function confirmShortAnswerQuestionSaved(question) {
  const { data, error } = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;

  const snapshot = data?.data?.currentQuizQuestions;
  const savedQuestion = snapshot?.quizId === state.currentQuizId && Array.isArray(snapshot.questions)
    ? snapshot.questions.find(item => item.id === question.id)
    : null;
  if (savedQuestion?.type !== 'short-answer'
    || savedQuestion.text !== question.text
    || savedQuestion.answer !== question.answer
    || Number(savedQuestion.marks) !== Number(question.marks)) {
    throw new Error('Supabase did not confirm this short-answer question in the question bank.');
  }
}

function saveShortAnswerQuestion(event) {
  event.preventDefault();
  if (quizIsLocked()) return showToast('Stop the quiz before changing questions.');
  const data = new FormData(event.target);
  const text = String(data.get('shortText') || '').trim();
  const answer = String(data.get('expectedAnswer') || '').trim();
  const existing = state.questions.find(item => item.id === data.get('shortId'));
  const id = existing?.id || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  saveQuestionLocally({ id, type: 'short-answer', text, answer, choices: [], correct: 0, marks: Number(data.get('shortMarks')) || 1 });
}

document.addEventListener('submit', event => {
  if (event.target?.id === 'short-answer-form') saveShortAnswerQuestion(event);
});
document.addEventListener('input', event => {
  if (event.target?.form?.id === 'short-answer-form') saveTeacherDraft(event.target.form);
});

const multipleChoiceStudentView = studentApp;
studentApp = function studentViewWithShortAnswer() {
  let markup = multipleChoiceStudentView();
  if (!session || session.completed) return markup;
  const question = (session.questionOrder || state.questions)[session.index];
  if (question?.type !== 'short-answer') return markup;
  const response = String(session.response || '');
  const responseMarkup = `<div class="answers"><div class="field full"><label for="short-answer-response">Your answer</label><textarea id="short-answer-response" placeholder="Type your answer..." ${session.feedback ? 'disabled' : ''}>${esc(response)}</textarea></div></div>`;
  markup = markup.replace(/<div class="answers">[\s\S]*?<\/div>/, responseMarkup);
  if (session.feedback?.partial) {
    const marksAwarded = Number(session.feedback.marksAwarded).toFixed(2).replace(/\.?0+$/, '');
    markup = markup.replace(/<div class="feedback [^"]*">[\s\S]*?<\/div>/, `<div class="feedback correct">Partially correct. ${marksAwarded} of ${question.marks} marks awarded.</div>`);
  }
  if (response.trim() && !session.feedback) markup = markup.replace('data-action="submit-answer" disabled', 'data-action="submit-answer"');
  return markup;
};

document.addEventListener('input', event => {
  if (event.target?.id !== 'short-answer-response' || !session || session.completed) return;
  session.response = event.target.value;
  saveStudentSession();
  const submitButton = document.querySelector('[data-action="submit-answer"]');
  if (submitButton) submitButton.disabled = !session.response.trim() || Boolean(session.feedback);
});

const submitMultipleChoiceAnswer = submitAnswer;
submitAnswer = function submitTypedOrMultipleChoiceAnswer() {
  const question = (session?.questionOrder || state.questions)[session?.index];
  if (question?.type !== 'short-answer') return submitMultipleChoiceAnswer();
  if (state.quizStopped || quizHasEnded() || session.quizId !== state.currentQuizId) return showToast('This quiz is no longer active.');
  const response = String(session.response || '').trim();
  if (!response) return;
  const credit = shortAnswerMatchScore(question.answer, response);
  const correct = credit === 1;
  const partial = credit === 0.5;
  const marksAwarded = Math.round((Number(question.marks) || 1) * credit);
  session.feedback = { correct, partial, marksAwarded };
  session.answers.push({ questionId: question.id, selected: response, correct, partial, marksAwarded });
  saveStudentSession();
  app();
};

nextQuestion = function nextTypedOrMultipleChoiceQuestion() {
  if (state.quizStopped || quizHasEnded() || session.quizId !== state.currentQuizId) return showToast('This quiz is no longer active.');
  const orderedQuestions = session.questionOrder || state.questions;
  if (session.index >= Math.min(state.config.totalQuestions, orderedQuestions.length) - 1) return finishQuiz(false);
  session.index += 1;
  session.selected = null;
  session.response = '';
  session.feedback = null;
  saveStudentSession();
  app();
};

const refreshStudentQuizQuestions = refreshStudentQuizStateRaw;
refreshStudentQuizStateRaw = async function refreshQuestionTypesForStudent() {
  const previousQuizId = session?.quizId;
  await refreshStudentQuizQuestions();
  if (session && session.quizId !== previousQuizId) session.response = '';
  const { data, error } = await supabase.from('quiz_workspace').select('data').eq('id', 1).maybeSingle();
  const snapshot = data?.data?.currentQuizQuestions;
  if (error || snapshot?.quizId !== state.currentQuizId || !Array.isArray(snapshot.questions)) return;
  state.questions = snapshot.questions;
};

session = restoreWindowSession();
if (!session) app();
stateHydrationPromise = hydrateQuizState(state, session?.role, false, session?.username || '').finally(() => { reconcileStudentSession(); cacheHydratedState(); stateHydrated = true; app(); });
document.addEventListener('submit', async event => {
  if (event.target?.id !== 'login-form') return;
  await stateHydrationPromise;
  if (session?.role !== 'student') return;
  await hydrateQuizState(state, 'student', false, session.username);
  cacheHydratedState();
  app();
});
window.addEventListener('pageshow', event => { if (event.persisted) { stopTimer(); session = null; app(); } });
window.addEventListener('visibilitychange', () => { if (!document.hidden && session?.role === 'student') void refreshStudentQuizStateRaw(); });
