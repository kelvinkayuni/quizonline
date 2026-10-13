create or replace function public.delete_question_atomically(
  p_question_id text,
  p_total_questions integer,
  p_activity_item jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_data jsonb;
  question_bank jsonb;
  snapshot_questions jsonb;
  activity jsonb;
  remaining_count integer;
  updated_total_questions integer;
begin
  if nullif(p_question_id, '') is null
    or jsonb_typeof(p_activity_item) is distinct from 'object'
    or p_activity_item->>'text' is distinct from 'A saved question was deleted'
    or p_activity_item->>'type' is distinct from 'question'
    or nullif(p_activity_item->>'time', '') is null then
    raise exception 'Invalid question deletion request.';
  end if;

  perform 1
  from public.quiz_config
  where id = 1
  for update;
  if not found then
    raise exception 'Quiz configuration is not initialized.';
  end if;

  perform 1
  from public.quiz_workspace
  where id = 1
  for update;
  if not found then
    raise exception 'Quiz workspace is not initialized.';
  end if;

  delete from public.questions
  where id::text = p_question_id;

  select count(*)::integer
  into remaining_count
  from public.questions;

  updated_total_questions := least(
    greatest(coalesce(p_total_questions, remaining_count), 0),
    remaining_count
  );

  update public.quiz_config
  set total_questions = updated_total_questions,
      quiz_id = null,
      published = false,
      stopped = false
  where id = 1;

  select coalesce(data, '{}'::jsonb)
  into workspace_data
  from public.quiz_workspace
  where id = 1
  for update;

  if jsonb_typeof(workspace_data->'questionBank') = 'array' then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into question_bank
    from jsonb_array_elements(workspace_data->'questionBank') with ordinality as item(value, ordinality)
    where item.value->>'id' is distinct from p_question_id;
  elsif jsonb_typeof(workspace_data->'currentQuizQuestions'->'questions') = 'array' then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into question_bank
    from jsonb_array_elements(workspace_data->'currentQuizQuestions'->'questions') with ordinality as item(value, ordinality)
    where item.value->>'id' is distinct from p_question_id;
  else
    question_bank := '[]'::jsonb;
  end if;

  if jsonb_typeof(workspace_data->'currentQuizQuestions'->'questions') = 'array' then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into snapshot_questions
    from jsonb_array_elements(workspace_data->'currentQuizQuestions'->'questions') with ordinality as item(value, ordinality)
    where item.value->>'id' is distinct from p_question_id;
  else
    snapshot_questions := question_bank;
  end if;

  if jsonb_typeof(workspace_data->'activity') = 'array' then
    activity := jsonb_build_array(p_activity_item) || workspace_data->'activity';
  else
    activity := jsonb_build_array(p_activity_item);
  end if;

  select coalesce(jsonb_agg(recent.item order by recent.ordinality), '[]'::jsonb)
  into activity
  from (
    select item.value, item.ordinality
    from jsonb_array_elements(activity) with ordinality as item(value, ordinality)
    order by item.ordinality
    limit 20
  ) as recent(item, ordinality);

  workspace_data := jsonb_set(
    jsonb_set(
      jsonb_set(workspace_data, '{questionBank}', question_bank, true),
      '{currentQuizQuestions}',
      jsonb_build_object('quizId', null, 'questions', snapshot_questions),
      true
    ),
    '{activity}',
    activity,
    true
  );

  update public.quiz_workspace
  set data = workspace_data,
      updated_at = now()
  where id = 1;

  return jsonb_build_object(
    'deleted', true,
    'question_id', p_question_id,
    'remaining_question_count', remaining_count,
    'total_questions', updated_total_questions,
    'quiz_id', null,
    'published', false,
    'stopped', false
  );
end;
$$;

revoke all on function public.delete_question_atomically(text, integer, jsonb) from public;
grant execute on function public.delete_question_atomically(text, integer, jsonb) to anon, authenticated;
