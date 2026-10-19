alter table public.quiz_attempts
  add column if not exists review_status text not null default 'final',
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id);

alter table public.student_quiz_reports
  add column if not exists review_status text not null default 'final',
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id);

create or replace function public.prevent_completed_quiz_result_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.allow_short_answer_review_backfill', true) = 'on'
    and current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if current_setting('app.allow_teacher_result_review', true) = 'on'
    and auth.uid() is not null
    and coalesce(auth.jwt()->'app_metadata'->>'role', '') = 'teacher'
    and old.review_status = 'provisional'
    and new.review_status = 'final'
    and new.reviewed_by = auth.uid()
    and new.username = old.username
    and new.quiz_id = old.quiz_id
    and new.total_marks = old.total_marks
    and new.completed_at = old.completed_at then
    return new;
  end if;

  raise exception 'Completed quiz results are immutable except for teacher short-answer review.'
    using errcode = '23514';
end;
$$;

revoke all on function public.prevent_completed_quiz_result_update() from public;

do $$
begin
  perform set_config('app.allow_short_answer_review_backfill', 'on', true);

  update public.quiz_attempts as attempt
  set review_status = 'provisional'
  where attempt.review_status = 'final'
    and attempt.reviewed_at is null
    and exists (
      select 1
      from jsonb_array_elements(
        case when jsonb_typeof(attempt.answers) = 'array' then attempt.answers else '[]'::jsonb end
      ) as answer(value)
      where answer.value->>'scoringMethod' in ('cartographer', 'concept-matcher-fallback')
    );

  update public.student_quiz_reports as report
  set review_status = 'provisional'
  where report.review_status = 'final'
    and report.reviewed_at is null
    and exists (
      select 1
      from jsonb_array_elements(
        case when jsonb_typeof(report.question_details) = 'array' then report.question_details else '[]'::jsonb end
      ) as detail(value)
      where detail.value->>'questionType' = 'short-answer'
        and detail.value->>'submitted' = 'true'
    );
end;
$$;

create or replace function public.classify_quiz_attempt_review_before_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(new.answers) = 'array' then new.answers else '[]'::jsonb end
    ) as answer(value)
    where answer.value->>'scoringMethod' in ('cartographer', 'concept-matcher-fallback')
  ) then
    new.review_status := 'provisional';
  else
    new.review_status := 'final';
  end if;
  return new;
end;
$$;

create or replace function public.classify_student_quiz_report_review_before_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(new.question_details) = 'array' then new.question_details else '[]'::jsonb end
    ) as detail(value)
    where detail.value->>'questionType' = 'short-answer'
      and detail.value->>'submitted' = 'true'
  ) then
    new.review_status := 'provisional';
  else
    new.review_status := 'final';
  end if;
  return new;
end;
$$;

drop trigger if exists classify_quiz_attempt_review_before_insert on public.quiz_attempts;
create trigger classify_quiz_attempt_review_before_insert
before insert on public.quiz_attempts
for each row
execute function public.classify_quiz_attempt_review_before_insert();

drop trigger if exists classify_student_quiz_report_review_before_insert on public.student_quiz_reports;
create trigger classify_student_quiz_report_review_before_insert
before insert on public.student_quiz_reports
for each row
execute function public.classify_student_quiz_report_review_before_insert();

create or replace function public.load_teacher_short_answer_review(
  p_quiz_id text,
  p_username text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_report public.student_quiz_reports;
  review_details jsonb;
begin
  if auth.uid() is null
    or coalesce(auth.jwt()->'app_metadata'->>'role', '') <> 'teacher' then
    raise exception 'Teacher authentication is required.' using errcode = '42501';
  end if;

  select * into saved_report
  from public.student_quiz_reports
  where quiz_id = p_quiz_id and username = p_username;

  if not found then
    raise exception 'No completed report exists for this student and quiz.' using errcode = 'P0002';
  end if;
  if saved_report.review_status <> 'provisional' then
    raise exception 'This result has already been finalized.' using errcode = '55000';
  end if;

  select coalesce(jsonb_agg(
    case when detail.value->>'questionType' = 'short-answer' then
      detail.value || jsonb_build_object(
        'teacherExpectedAnswer', coalesce((
          select question.value->>'answer'
          from public.quiz_question_history as history
          cross join lateral jsonb_array_elements(
            coalesce(history.question_snapshot->'questions', '[]'::jsonb)
          ) as question(value)
          where history.quiz_id = p_quiz_id
            and question.value->>'id' = detail.value->>'questionId'
          limit 1
        ), ''),
        'teacherReferenceAnswer', coalesce((
          select question.value->>'referenceAnswer'
          from public.quiz_question_history as history
          cross join lateral jsonb_array_elements(
            coalesce(history.question_snapshot->'questions', '[]'::jsonb)
          ) as question(value)
          where history.quiz_id = p_quiz_id
            and question.value->>'id' = detail.value->>'questionId'
          limit 1
        ), '')
      )
    else detail.value end
    order by (detail.value->>'questionNumber')::integer
  ), '[]'::jsonb)
  into review_details
  from jsonb_array_elements(saved_report.question_details) as detail(value);

  return jsonb_build_object(
    'quiz_id', saved_report.quiz_id,
    'username', saved_report.username,
    'review_status', saved_report.review_status,
    'score', saved_report.score,
    'total_marks', saved_report.total_marks,
    'percentage', saved_report.percentage,
    'question_details', review_details
  );
end;
$$;

create or replace function public.review_teacher_short_answer_result(
  p_quiz_id text,
  p_username text,
  p_short_answer_marks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_attempt public.quiz_attempts;
  saved_report public.student_quiz_reports;
  revised_details jsonb;
  revised_answers jsonb;
  revised_score numeric;
  revised_percentage numeric;
  required_marks integer;
begin
  if auth.uid() is null
    or coalesce(auth.jwt()->'app_metadata'->>'role', '') <> 'teacher' then
    raise exception 'Teacher authentication is required.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_short_answer_marks) is distinct from 'array' then
    raise exception 'Teacher marks must be provided for each submitted short answer.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_quiz_id), hashtext(p_username));
  select * into saved_attempt
  from public.quiz_attempts
  where quiz_id = p_quiz_id and username = p_username
  for update;
  if not found then
    raise exception 'No completed result exists for this student and quiz.' using errcode = 'P0002';
  end if;

  select * into saved_report
  from public.student_quiz_reports
  where quiz_id = p_quiz_id and username = p_username
  for update;
  if not found or saved_attempt.review_status <> 'provisional'
    or saved_report.review_status <> 'provisional' then
    raise exception 'This result is not awaiting short-answer review.' using errcode = '55000';
  end if;

  select count(*) into required_marks
  from jsonb_array_elements(saved_report.question_details) as detail(value)
  where detail.value->>'questionType' = 'short-answer'
    and detail.value->>'submitted' = 'true';

  if required_marks = 0 or jsonb_array_length(p_short_answer_marks) <> required_marks then
    raise exception 'Provide exactly one mark for each submitted short-answer response.' using errcode = '22023';
  end if;
  if exists (
    select mark.value->>'questionId'
    from jsonb_array_elements(p_short_answer_marks) as mark(value)
    group by mark.value->>'questionId'
    having count(*) > 1
  ) then
    raise exception 'A short-answer question was included more than once.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_short_answer_marks) as mark(value)
    left join lateral (
      select detail.value
      from jsonb_array_elements(saved_report.question_details) as detail(value)
      where detail.value->>'questionId' = mark.value->>'questionId'
        and detail.value->>'questionType' = 'short-answer'
        and detail.value->>'submitted' = 'true'
      limit 1
    ) as question on true
    where question.value is null
      or jsonb_typeof(mark.value->'marksAwarded') <> 'number'
      or coalesce(case when jsonb_typeof(mark.value->'marksAwarded') = 'number'
        then (mark.value->>'marksAwarded')::numeric end, -1) < 0
      or coalesce(case when jsonb_typeof(mark.value->'marksAwarded') = 'number'
        then (mark.value->>'marksAwarded')::numeric end, -1) > (question.value->>'marksPossible')::numeric
  ) then
    raise exception 'Teacher marks must be between zero and the question maximum.' using errcode = '22023';
  end if;

  select jsonb_agg(
    case when detail.value->>'questionType' = 'short-answer'
      and detail.value->>'submitted' = 'true' then
      detail.value || jsonb_build_object(
        'suggestedMarksAwarded', coalesce(detail.value->'suggestedMarksAwarded', detail.value->'marksAwarded'),
        'teacherMarksAwarded', to_jsonb(round((mark.value->>'marksAwarded')::numeric, 1)),
        'marksAwarded', to_jsonb(round((mark.value->>'marksAwarded')::numeric, 1)),
        'teacherReviewed', true
      )
    else detail.value end
    order by (detail.value->>'questionNumber')::integer
  ) into revised_details
  from jsonb_array_elements(saved_report.question_details) as detail(value)
  left join lateral (
    select mark.value
    from jsonb_array_elements(p_short_answer_marks) as mark(value)
    where mark.value->>'questionId' = detail.value->>'questionId'
    limit 1
  ) as mark on true;

  select coalesce(sum((detail.value->>'marksAwarded')::numeric), 0)
  into revised_score
  from jsonb_array_elements(revised_details) as detail(value);
  revised_percentage := case when saved_report.total_marks > 0
    then round(revised_score / saved_report.total_marks * 100)
    else 0 end;

  select coalesce(jsonb_agg(
    case when detail.value->>'questionType' = 'short-answer'
      and detail.value->>'submitted' = 'true' then
      answer.value || jsonb_build_object(
        'suggestedMarksAwarded', coalesce(answer.value->'suggestedMarksAwarded', answer.value->'marksAwarded'),
        'teacherMarksAwarded', detail.value->'teacherMarksAwarded',
        'marksAwarded', detail.value->'marksAwarded',
        'correct', (detail.value->>'marksAwarded')::numeric >= (detail.value->>'marksPossible')::numeric,
        'partial', (detail.value->>'marksAwarded')::numeric > 0
          and (detail.value->>'marksAwarded')::numeric < (detail.value->>'marksPossible')::numeric,
        'teacherReviewed', true
      )
    else answer.value end
    order by answer.ordinality
  ), '[]'::jsonb)
  into revised_answers
  from jsonb_array_elements(saved_attempt.answers) with ordinality as answer(value, ordinality)
  left join lateral (
    select detail.value
    from jsonb_array_elements(revised_details) as detail(value)
    where detail.value->>'questionId' = answer.value->>'questionId'
      and detail.value->>'questionType' = 'short-answer'
      and detail.value->>'submitted' = 'true'
    limit 1
  ) as detail on true;

  perform set_config('app.allow_teacher_result_review', 'on', true);
  update public.quiz_attempts
  set answers = revised_answers,
      score = revised_score,
      percentage = revised_percentage,
      review_status = 'final',
      reviewed_at = now(),
      reviewed_by = auth.uid()
  where quiz_id = p_quiz_id and username = p_username
  returning * into saved_attempt;

  update public.student_quiz_reports
  set question_details = revised_details,
      score = revised_score,
      percentage = revised_percentage,
      review_status = 'final',
      reviewed_at = now(),
      reviewed_by = auth.uid()
  where quiz_id = p_quiz_id and username = p_username
  returning * into saved_report;

  update public.student_quiz_report_answers as saved_answer
  set question_details = detail.value,
      updated_at = now()
  from jsonb_array_elements(revised_details) as detail(value)
  where saved_answer.quiz_id = p_quiz_id
    and saved_answer.username = p_username
    and saved_answer.question_id = detail.value->>'questionId'
    and detail.value->>'questionType' = 'short-answer'
    and detail.value->>'submitted' = 'true';

  return jsonb_build_object(
    'saved', true,
    'result', to_jsonb(saved_attempt),
    'report', jsonb_build_object(
      'review_status', saved_report.review_status,
      'score', saved_report.score,
      'total_marks', saved_report.total_marks,
      'percentage', saved_report.percentage,
      'question_details', saved_report.question_details
    )
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
    select 1 from public.quiz_workspace workspace,
      jsonb_array_elements(coalesce(workspace.data->'users', '[]'::jsonb)) as users(user_record)
    where user_record->>'username' = p_username and user_record->>'password' = p_password
  ) then
    raise exception 'Student credentials could not be verified.' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.quiz_attempts
    where username = p_username and quiz_id = p_quiz_id
  ) then
    raise exception 'No completed result exists for this student and quiz.' using errcode = 'P0002';
  end if;
  select * into report from public.student_quiz_reports
  where username = p_username and quiz_id = p_quiz_id;
  if not found then
    raise exception 'A detailed report is not available for this quiz attempt.' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'username', report.username,
    'quiz_id', report.quiz_id,
    'question_details', report.question_details,
    'score', report.score,
    'total_marks', report.total_marks,
    'percentage', report.percentage,
    'review_status', report.review_status,
    'completed_at', report.completed_at
  );
end;
$$;

revoke all on function public.classify_quiz_attempt_review_before_insert() from public;
revoke all on function public.classify_student_quiz_report_review_before_insert() from public;
revoke all on function public.load_teacher_short_answer_review(text, text) from public, anon;
revoke all on function public.review_teacher_short_answer_result(text, text, jsonb) from public, anon;
revoke update on table public.quiz_attempts from public, anon, authenticated;
grant execute on function public.load_teacher_short_answer_review(text, text) to authenticated;
grant execute on function public.review_teacher_short_answer_result(text, text, jsonb) to authenticated;