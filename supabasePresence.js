import { supabase } from './supabase.js';

const PRESENCE_TIMEOUT_MS = 30000;

export async function markStudentOnline(username, quizId) {
  const { error } = await supabase.from('quiz_presence').upsert({
    username,
    quiz_id: quizId,
    online: true,
    last_seen: new Date().toISOString()
  });
  if (error) console.warn('Could not mark student online.', error);
}

export async function markStudentOffline(username, quizId) {
  const { error } = await supabase
    .from('quiz_presence')
    .update({ online: false, last_seen: new Date().toISOString() })
    .eq('username', username)
    .eq('quiz_id', quizId);
  if (error) console.warn('Could not mark student offline.', error);
}

export async function markStudentsOffline(usernames, quizId) {
  if (!usernames?.length || !quizId) return;
  const { error } = await supabase
    .from('quiz_presence')
    .update({ online: false, last_seen: new Date().toISOString() })
    .in('username', usernames)
    .eq('quiz_id', quizId);
  if (error) console.warn('Could not clear student presence.', error);
}

export async function loadLiveStudentUsernames(quizId) {
  const { data, error } = await supabase
    .from('quiz_presence')
    .select('username, last_seen, online')
    .eq('quiz_id', quizId)
    .eq('online', true);

  if (error) {
    console.warn('Could not load live students.', error);
    return null;
  }

  const cutoff = Date.now() - PRESENCE_TIMEOUT_MS;
  return new Set(data.filter(row => new Date(row.last_seen).getTime() >= cutoff).map(row => row.username));
}
