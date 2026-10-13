alter table public.questions
  add column if not exists type text not null default 'multiple-choice',
  add column if not exists answer text not null default '',
  add column if not exists reference_answer text not null default '',
  add column if not exists metadata_updated_at text;

with question_metadata as (
  select question.id, metadata.value
  from public.questions as question
  join public.quiz_workspace as workspace on workspace.id = 1
  cross join lateral (
    select item.value, item.ordinality, 2 as priority
    from jsonb_array_elements(
      case
        when jsonb_typeof(workspace.data->'questionBank') = 'array'
          then workspace.data->'questionBank'
        else '[]'::jsonb
      end
    ) with ordinality as item(value, ordinality)
    where item.value->>'id' = question.id::text

    union all

    select item.value, item.ordinality, 1 as priority
    from jsonb_array_elements(
      case
        when jsonb_typeof(workspace.data->'currentQuizQuestions'->'questions') = 'array'
          then workspace.data->'currentQuizQuestions'->'questions'
        else '[]'::jsonb
      end
    ) with ordinality as item(value, ordinality)
    where item.value->>'id' = question.id::text
    order by priority desc, ordinality desc
    limit 1
  ) as metadata
)
update public.questions as question
set type = case
      when question_metadata.value->>'type' = 'short-answer' then 'short-answer'
      when question.type = 'short-answer' then 'short-answer'
      else 'multiple-choice'
    end,
    answer = coalesce(question_metadata.value->>'answer', question.answer, ''),
    reference_answer = coalesce(question_metadata.value->>'referenceAnswer', question.reference_answer, ''),
    metadata_updated_at = coalesce(question_metadata.value->>'metadataUpdatedAt', question.metadata_updated_at)
from question_metadata
where question.id = question_metadata.id;
