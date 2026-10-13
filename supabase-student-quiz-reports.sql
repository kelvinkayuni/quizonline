create table if not exists public.student_quiz_reports (
  username text not null,
  quiz_id text not null,
  question_details jsonb not null,
  score numeric not null,
  total_marks numeric not null,
  percentage numeric not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (username, quiz_id),
  constraint student_quiz_reports_question_details_array
    check (jsonb_typeof(question_details) = 'array')
);

alter table public.student_quiz_reports enable row level security;
revoke all on table public.student_quiz_reports from public, anon, authenticated;

create or replace function public.complete_quiz_active_attempt(
  p_quiz_id text,
  p_username text,
  p_generation bigint,
  p_owner_token uuid,
  p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  attempt public.quiz_active_attempts;
  saved_result public.quiz_attempts;
  inserted_count integer;
  report_inserted_count integer := 0;
  question_details jsonb;
begin
  if coalesce(p_result->>'username', '') <> p_username
    or coalesce(p_result->>'quizId', '') <> p_quiz_id
    or coalesce(p_result->>'completedAt', '') = '' then
    raise exception 'Completed result or detailed report is invalid.'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_result->'questionDetails') is distinct from 'array' then
    raise exception 'Completed result or detailed report is invalid.'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_result->'questionDetails') = 0 then
    raise exception 'Completed result or detailed report is invalid.'
      using errcode = '22023';
  end if;

  question_details := p_result->'questionDetails';
  perform pg_advisory_xact_lock(hashtext(p_quiz_id), hashtext(p_username));

  select * into attempt
  from public.quiz_active_attempts
  where quiz_id = p_quiz_id and username = p_username
  for update;

  if found then
    if attempt.generation <> p_generation or attempt.owner_token <> p_owner_token then
      return jsonb_build_object('saved', false, 'reason', 'claimed');
    end if;
  else
    select * into saved_result
    from public.quiz_attempts
    where username = p_username and quiz_id = p_quiz_id;

    if found then
      return jsonb_build_object(
        'saved', true,
        'already_completed', true,
        'report_saved', exists (
          select 1 from public.student_quiz_reports
          where username = p_username and quiz_id = p_quiz_id
        ),
        'result', to_jsonb(saved_result)
      );
    end if;
    return jsonb_build_object('saved', false, 'reason', 'missing');
  end if;

  insert into public.quiz_attempts (
    username,
    quiz_id,
    answers,
    score,
    total_marks,
    percentage,
    completed_at
  )
  values (
    p_username,
    p_quiz_id,
    coalesce(p_result->'answers', '[]'::jsonb),
    coalesce((p_result->>'score')::numeric, 0),
    coalesce((p_result->>'totalMarks')::numeric, 0),
    coalesce((p_result->>'percentage')::numeric, 0),
    (p_result->>'completedAt')::timestamptz
  )
  on conflict (username, quiz_id) do nothing;

  get diagnostics inserted_count = row_count;

  select * into saved_result
  from public.quiz_attempts
  where username = p_username and quiz_id = p_quiz_id;

  if not found then
    raise exception 'Supabase did not return the completed result after saving.';
  end if;

  if inserted_count = 1 then
    insert into public.student_quiz_reports (
      username,
      quiz_id,
      question_details,
      score,
      total_marks,
      percentage,
      completed_at
    )
    values (
      p_username,
      p_quiz_id,
      question_details,
      saved_result.score,
      saved_result.total_marks,
      saved_result.percentage,
      saved_result.completed_at
    )
    on conflict (username, quiz_id) do nothing;

    get diagnostics report_inserted_count = row_count;
    if report_inserted_count <> 1 then
      raise exception 'Supabase did not save the detailed student quiz report.';
    end if;

    insert into public.student_quiz_report_answers as saved_answer (
      username, quiz_id, question_id, question_number, question_details, updated_at
    )
    select
      p_username,
      p_quiz_id,
      detail->>'questionId',
      (detail->>'questionNumber')::integer,
      detail,
      now()
    from jsonb_array_elements(question_details) as answers(detail)
    where coalesce(detail->>'questionId', '') <> ''
      and detail->>'submitted' = 'true'
    on conflict (username, quiz_id, question_id) do update
    set question_number = excluded.question_number,
      question_details = excluded.question_details,
      updated_at = excluded.updated_at
    where saved_answer.question_number <> excluded.question_number
      or saved_answer.question_details <> excluded.question_details;
  end if;

  delete from public.quiz_active_attempts
  where quiz_id = p_quiz_id
    and username = p_username
    and generation = p_generation
    and owner_token = p_owner_token;

  return jsonb_build_object(
    'saved', true,
    'already_completed', inserted_count = 0,
    'report_saved', inserted_count = 1,
    'result', to_jsonb(saved_result)
  );
end;
$$;

create or replace function public.load_student_quiz_report(
  p_quiz_id text,
  p_username text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  report public.student_quiz_reports;
begin
  if not exists (
    select 1
    from public.quiz_workspace workspace,
      jsonb_array_elements(coalesce(workspace.data->'users', '[]'::jsonb)) as users(user_record)
    where user_record->>'username' = p_username
      and user_record->>'password' = p_password
  ) then
    raise exception 'Student credentials could not be verified.'
      using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.quiz_attempts
    where username = p_username and quiz_id = p_quiz_id
  ) then
    raise exception 'No completed result exists for this student and quiz.'
      using errcode = 'P0002';
  end if;

  select * into report
  from public.student_quiz_reports
  where username = p_username and quiz_id = p_quiz_id;

  if not found then
    raise exception 'A detailed report is not available for this older quiz attempt.'
      using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'username', report.username,
    'quiz_id', report.quiz_id,
    'question_details', report.question_details,
    'score', report.score,
    'total_marks', report.total_marks,
    'percentage', report.percentage,
    'completed_at', report.completed_at
  );
end;
$$;

create or replace function public.delete_student_quiz_report_after_result()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.student_quiz_report_answers
  where username = old.username and quiz_id = old.quiz_id;
  delete from public.student_quiz_reports
  where username = old.username and quiz_id = old.quiz_id;
  return old;
end;
$$;

revoke all on function public.complete_quiz_active_attempt(text, text, bigint, uuid, jsonb) from public;
revoke all on function public.load_student_quiz_report(text, text, text) from public;
revoke all on function public.delete_student_quiz_report_after_result() from public;
grant execute on function public.complete_quiz_active_attempt(text, text, bigint, uuid, jsonb) to anon, authenticated;
grant execute on function public.load_student_quiz_report(text, text, text) to anon, authenticated;

drop trigger if exists delete_student_quiz_report_after_result on public.quiz_attempts;
create trigger delete_student_quiz_report_after_result
after delete on public.quiz_attempts
for each row
execute function public.delete_student_quiz_report_after_result();
