import { supabase } from './supabase.js';

const PRESENCE_TIMEOUT_MS = 30000;

export async function markStudentOnline(username, quizId) {
  if (!username || !quizId) return;
  const { error } = await supabase.from('quiz_presence').upsert({
    username,
    quiz_id: quizId,
    online: true,
    last_seen: new Date().toISOString()
  });
  if (error) console.warn('Could not mark student online.', error);
}

export async function markStudentOffline(username, quizId) {
  if (!username || !quizId) return;
  const { error } = await supabase
    .from('quiz_presence')
    .update({ online: false })
    .eq('username', username)
    .eq('quiz_id', quizId);
  if (error) console.warn('Could not mark student offline.', error);
}

export async function markStudentsOffline(usernames, quizId = null) {
  if (!usernames?.length) return;
  let request = supabase
    .from('quiz_presence')
    .update({ online: false })
    .in('username', usernames);
  if (quizId) request = request.eq('quiz_id', quizId);
  const { error } = await request;
  if (error) console.warn('Could not clear student presence.', error);
}

export async function loadStudentPresence() {
  const { data, error } = await supabase
    .from('quiz_presence')
    .select('username, last_seen, online');

  if (error) {
    console.warn('Could not load live students.', error);
    return null;
  }

  const cutoff = Date.now() - PRESENCE_TIMEOUT_MS;
  const presenceByUsername = new Map();
  for (const row of data || []) {
    const lastSeenTime = Date.parse(row.last_seen || '');
    if (!row.username || !Number.isFinite(lastSeenTime)) continue;
    const existing = presenceByUsername.get(row.username);
    presenceByUsername.set(row.username, {
      online: Boolean(existing?.online || (row.online && lastSeenTime >= cutoff)),
      lastSeen: !existing || lastSeenTime > Date.parse(existing.lastSeen)
        ? row.last_seen
        : existing.lastSeen
    });
  }
  return presenceByUsername;
}
