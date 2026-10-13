do $$
begin
  if not exists (
    select 1 from auth.users where lower(email) = 'kelvinkayuni13@gmail.com'
  ) then
    raise exception 'Create the Supabase Auth teacher user kelvinkayuni13@gmail.com before applying this migration.';
  end if;
end;
$$;

create table if not exists public.quiz_question_history (
  quiz_id text primary key,
  published_at timestamptz not null default now(),
  course_name text,
  course_code text,
  question_snapshot jsonb not null,
  constraint quiz_question_history_snapshot_object
    check (jsonb_typeof(question_snapshot) = 'object'),
  constraint quiz_question_history_questions_array
    check (jsonb_typeof(question_snapshot->'questions') = 'array')
);

alter table public.quiz_question_history enable row level security;
revoke all on table public.quiz_question_history from public, anon, authenticated;

update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('role', 'teacher')
where lower(email) = 'kelvinkayuni13@gmail.com';

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
  if auth.uid() is null
    or coalesce(auth.jwt()->'app_metadata'->>'role', '') <> 'teacher' then
    raise exception 'Teacher authentication is required.'
      using errcode = '42501';
  end if;

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

  insert into public.quiz_question_history (
    quiz_id, course_name, course_code, question_snapshot
  )
  values (
    p_quiz_id,
    nullif(p_quiz_config->>'course_name', ''),
    nullif(p_quiz_config->>'course_code', ''),
    p_question_snapshot
  )
  on conflict (quiz_id) do nothing;

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

create or replace function public.list_teacher_quiz_question_history()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or coalesce(auth.jwt()->'app_metadata'->>'role', '') <> 'teacher' then
    raise exception 'Teacher authentication is required.'
      using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'quiz_id', history.quiz_id,
        'published_at', history.published_at,
        'course_name', history.course_name,
        'course_code', history.course_code,
        'question_count', jsonb_array_length(history.question_snapshot->'questions')
      )
      order by history.published_at desc
    )
    from public.quiz_question_history history
  ), '[]'::jsonb);
end;
$$;

create or replace function public.load_teacher_quiz_question_history(p_quiz_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  history public.quiz_question_history;
begin
  if auth.uid() is null
    or coalesce(auth.jwt()->'app_metadata'->>'role', '') <> 'teacher' then
    raise exception 'Teacher authentication is required.'
      using errcode = '42501';
  end if;

  select * into history
  from public.quiz_question_history
  where quiz_id = p_quiz_id;

  if not found then
    raise exception 'No archived question set exists for this quiz.'
      using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'quiz_id', history.quiz_id,
    'published_at', history.published_at,
    'course_name', history.course_name,
    'course_code', history.course_code,
    'question_snapshot', history.question_snapshot
  );
end;
$$;

create or replace function public.delete_teacher_quiz_question_history(p_quiz_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_question_sets integer;
begin
  if auth.uid() is null
    or coalesce(auth.jwt()->'app_metadata'->>'role', '') <> 'teacher' then
    raise exception 'Teacher authentication is required.'
      using errcode = '42501';
  end if;

  if nullif(p_quiz_id, '') is null then
    raise exception 'A quiz ID is required.'
      using errcode = '22023';
  end if;

  delete from public.quiz_question_history
  where quiz_id = p_quiz_id;
  get diagnostics deleted_question_sets = row_count;

  if deleted_question_sets <> 1 then
    raise exception 'No archived question set exists for this quiz.'
      using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'deleted', true,
    'quiz_id', p_quiz_id
  );
end;
$$;

create or replace function public.delete_quiz_results_and_question_history(p_quiz_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_results integer;
  deleted_question_sets integer;
  quiz_ids text[];
begin
  if auth.uid() is null
    or coalesce(auth.jwt()->'app_metadata'->>'role', '') <> 'teacher' then
    raise exception 'Teacher authentication is required.'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct quiz_id), '{}'::text[])
  into quiz_ids
  from unnest(coalesce(p_quiz_ids, '{}'::text[])) as ids(quiz_id)
  where quiz_id is not null and quiz_id <> '';

  if cardinality(quiz_ids) = 0 then
    raise exception 'At least one quiz ID is required.'
      using errcode = '22023';
  end if;

  delete from public.quiz_attempts
  where quiz_id = any(quiz_ids);
  get diagnostics deleted_results = row_count;

  delete from public.quiz_question_history
  where quiz_id = any(quiz_ids);
  get diagnostics deleted_question_sets = row_count;

  return jsonb_build_object(
    'deleted', true,
    'deleted_results', deleted_results,
    'deleted_question_sets', deleted_question_sets
  );
end;
$$;

create or replace function public.delete_quiz_question_history_after_last_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.quiz_attempts where quiz_id = old.quiz_id
  ) then
    delete from public.quiz_question_history where quiz_id = old.quiz_id;
  end if;
  return old;
end;
$$;

revoke all on function public.publish_quiz_atomically(text, jsonb, jsonb) from public, anon;
revoke all on function public.list_teacher_quiz_question_history() from public, anon;
revoke all on function public.load_teacher_quiz_question_history(text) from public, anon;
revoke all on function public.delete_teacher_quiz_question_history(text) from public, anon;
revoke all on function public.delete_quiz_results_and_question_history(text[]) from public, anon;
revoke all on function public.delete_quiz_question_history_after_last_result() from public, anon, authenticated;
grant execute on function public.publish_quiz_atomically(text, jsonb, jsonb) to authenticated;
grant execute on function public.list_teacher_quiz_question_history() to authenticated;
grant execute on function public.load_teacher_quiz_question_history(text) to authenticated;
grant execute on function public.delete_teacher_quiz_question_history(text) to authenticated;
grant execute on function public.delete_quiz_results_and_question_history(text[]) to authenticated;

drop trigger if exists delete_quiz_question_history_after_last_result on public.quiz_attempts;
create trigger delete_quiz_question_history_after_last_result
after delete on public.quiz_attempts
for each row
execute function public.delete_quiz_question_history_after_last_result();
