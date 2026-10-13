create or replace function public.publish_quiz_atomically(
  p_quiz_id text,
  p_quiz_config jsonb,
  p_question_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  config_quiz_id text;
  question_count integer;
begin
  config_quiz_id := p_quiz_config->>'quiz_id';
  if p_quiz_id is null
    or config_quiz_id is distinct from p_quiz_id
    or coalesce((p_quiz_config->>'published')::boolean, false) is not true
    or coalesce((p_quiz_config->>'stopped')::boolean, true) is not false
    or p_question_snapshot->>'quizId' is distinct from p_quiz_id
    or jsonb_typeof(p_question_snapshot->'questions') is distinct from 'array' then
    raise exception 'Invalid quiz publication payload.';
  end if;

  question_count := jsonb_array_length(p_question_snapshot->'questions');
  if question_count = 0 then
    raise exception 'A quiz must contain at least one question.';
  end if;

  insert into public.quiz_config (
    id,
    course_name,
    course_code,
    total_questions,
    duration,
    start_time,
    end_time,
    quiz_id,
    published,
    stopped
  )
  values (
    1,
    nullif(p_quiz_config->>'course_name', ''),
    nullif(p_quiz_config->>'course_code', ''),
    (p_quiz_config->>'total_questions')::integer,
    (p_quiz_config->>'duration')::integer,
    nullif(p_quiz_config->>'start_time', '')::timestamptz,
    nullif(p_quiz_config->>'end_time', '')::timestamptz,
    p_quiz_id,
    true,
    false
  )
  on conflict (id) do update set
    course_name = excluded.course_name,
    course_code = excluded.course_code,
    total_questions = excluded.total_questions,
    duration = excluded.duration,
    start_time = excluded.start_time,
    end_time = excluded.end_time,
    quiz_id = excluded.quiz_id,
    published = excluded.published,
    stopped = excluded.stopped;

  insert into public.quiz_workspace as existing_workspace (id, data, updated_at)
  values (
    1,
    jsonb_build_object('currentQuizQuestions', p_question_snapshot),
    now()
  )
  on conflict (id) do update set
    data = coalesce(existing_workspace.data, '{}'::jsonb)
      || jsonb_build_object('currentQuizQuestions', p_question_snapshot),
    updated_at = now();

  return jsonb_build_object('published', true, 'quiz_id', p_quiz_id);
end;
$$;

revoke all on function public.publish_quiz_atomically(text, jsonb, jsonb) from public;
grant execute on function public.publish_quiz_atomically(text, jsonb, jsonb) to anon, authenticated;
