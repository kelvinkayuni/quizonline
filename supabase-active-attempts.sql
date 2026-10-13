create table if not exists public.quiz_active_attempts (
	quiz_id text not null,
	username text not null,
	generation bigint not null default 1,
	revision bigint not null default 0,
	owner_token uuid not null default gen_random_uuid(),
	last_save_id uuid,
	attempt_data jsonb not null default '{}'::jsonb,
	updated_at timestamptz not null default now(),
	primary key (quiz_id, username)
);

create table if not exists public.student_quiz_report_answers (
	username text not null,
	quiz_id text not null,
	question_id text not null,
	question_number integer not null check (question_number > 0),
	question_details jsonb not null check (jsonb_typeof(question_details) = 'object'),
	updated_at timestamptz not null default now(),
	primary key (username, quiz_id, question_id)
);

alter table public.student_quiz_report_answers enable row level security;
revoke all on table public.student_quiz_report_answers from public, anon, authenticated;

alter table public.quiz_active_attempts
	add column if not exists last_save_id uuid;

alter table public.quiz_active_attempts enable row level security;
revoke all on public.quiz_active_attempts from anon, authenticated;

insert into public.quiz_active_attempts (quiz_id, username, attempt_data, updated_at)
select
	saved_attempt->>'quizId',
	saved_attempt->>'username',
	jsonb_build_object(
		'questionOrderIds', coalesce(saved_attempt->'questionOrderIds', '[]'::jsonb),
		'index', coalesce(saved_attempt->'index', '0'::jsonb),
		'selected', saved_attempt->'selected',
		'response', coalesce(saved_attempt->'response', '""'::jsonb),
		'feedback', saved_attempt->'feedback',
		'remaining', coalesce(saved_attempt->'remaining', '0'::jsonb),
		'deadlineAt', saved_attempt->'deadlineAt',
		'started', coalesce(saved_attempt->'started', 'false'::jsonb),
		'answers', coalesce(saved_attempt->'answers', '[]'::jsonb),
		'updatedAt', saved_attempt->'updatedAt'
	),
	coalesce(nullif(saved_attempt->>'updatedAt', '')::timestamptz, now())
from public.quiz_workspace workspace
cross join lateral jsonb_each(
	case
		when jsonb_typeof(workspace.data->'activeStudentSessions') = 'object'
			then workspace.data->'activeStudentSessions'
		else '{}'::jsonb
	end
) saved_sessions(session_key, saved_attempt)
where coalesce(saved_attempt->>'quizId', '') <> ''
	and coalesce(saved_attempt->>'username', '') <> ''
	and coalesce((saved_attempt->>'completed')::boolean, false) = false
on conflict (quiz_id, username) do nothing;

create or replace function public.claim_quiz_active_attempt(
	p_quiz_id text,
	p_username text,
	p_password text,
	p_initial_data jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
	attempt public.quiz_active_attempts;
begin
	if not exists (
		select 1
		from public.quiz_workspace workspace,
			jsonb_array_elements(coalesce(workspace.data->'users', '[]'::jsonb)) as users(user_record)
		where user_record->>'username' = p_username
			and user_record->>'password' = p_password
	) then
		raise exception 'Student credentials could not be verified.' using errcode = '28000';
	end if;

	insert into public.quiz_active_attempts (quiz_id, username, generation, revision, attempt_data)
	values (p_quiz_id, p_username, 1, 0, coalesce(p_initial_data, '{}'::jsonb))
	on conflict (quiz_id, username) do update
	set generation = public.quiz_active_attempts.generation + 1,
		revision = public.quiz_active_attempts.revision + 1,
		owner_token = gen_random_uuid(),
		updated_at = now()
	returning * into attempt;

	return jsonb_build_object(
		'generation', attempt.generation,
		'revision', attempt.revision,
		'owner_token', attempt.owner_token,
		'attempt_data', attempt.attempt_data
	);
end;
$$;

create or replace function public.save_quiz_active_attempt(
	p_quiz_id text,
	p_username text,
	p_generation bigint,
	p_owner_token uuid,
	p_expected_revision bigint,
	p_save_id uuid,
	p_attempt_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
	attempt public.quiz_active_attempts;
begin
	select * into attempt
	from public.quiz_active_attempts
	where quiz_id = p_quiz_id and username = p_username
	for update;

	if not found then
		return jsonb_build_object('saved', false, 'reason', 'missing', 'revision', 0);
	end if;

	if attempt.generation <> p_generation or attempt.owner_token <> p_owner_token then
		return jsonb_build_object('saved', false, 'reason', 'claimed', 'revision', attempt.revision);
	end if;

	if attempt.last_save_id = p_save_id then
		return jsonb_build_object('saved', true, 'revision', attempt.revision, 'replayed', true);
	end if;

	if attempt.attempt_data = p_attempt_data then
		update public.quiz_active_attempts
		set last_save_id = p_save_id, updated_at = now()
		where quiz_id = p_quiz_id and username = p_username;
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
		from jsonb_array_elements(coalesce(p_attempt_data->'questionDetails', '[]'::jsonb)) as answers(detail)
		where coalesce(detail->>'questionId', '') <> ''
		on conflict (username, quiz_id, question_id) do update
		set question_number = excluded.question_number,
			question_details = excluded.question_details,
			updated_at = excluded.updated_at
		where saved_answer.question_number <> excluded.question_number
			or saved_answer.question_details <> excluded.question_details;
		return jsonb_build_object('saved', true, 'revision', attempt.revision, 'replayed', true);
	end if;

	update public.quiz_active_attempts
	set attempt_data = p_attempt_data,
		revision = revision + 1,
		last_save_id = p_save_id,
		updated_at = now()
	where quiz_id = p_quiz_id
		and username = p_username
		and generation = p_generation
		and owner_token = p_owner_token
		and revision = p_expected_revision
	returning * into attempt;

	if found then
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
		from jsonb_array_elements(coalesce(p_attempt_data->'questionDetails', '[]'::jsonb)) as answers(detail)
		where coalesce(detail->>'questionId', '') <> ''
		on conflict (username, quiz_id, question_id) do update
		set question_number = excluded.question_number,
			question_details = excluded.question_details,
			updated_at = excluded.updated_at
		where saved_answer.question_number <> excluded.question_number
			or saved_answer.question_details <> excluded.question_details;
		return jsonb_build_object('saved', true, 'revision', attempt.revision);
	end if;

	select * into attempt
	from public.quiz_active_attempts
	where quiz_id = p_quiz_id and username = p_username;

	if not found then
		return jsonb_build_object('saved', false, 'reason', 'missing');
	end if;

	return jsonb_build_object(
		'saved', false,
		'reason', case when attempt.generation <> p_generation or attempt.owner_token <> p_owner_token then 'claimed' else 'revision' end,
		'revision', attempt.revision,
		'attempt_data', case
			when attempt.generation = p_generation and attempt.owner_token = p_owner_token
				then attempt.attempt_data
			else null
		end
	);
end;
$$;

create or replace function public.delete_quiz_active_attempt(
	p_quiz_id text,
	p_username text,
	p_generation bigint,
	p_owner_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
	deleted_count integer;
	attempt_exists boolean;
begin
	delete from public.quiz_active_attempts
	where quiz_id = p_quiz_id
		and username = p_username
		and generation = p_generation
		and owner_token = p_owner_token;

	get diagnostics deleted_count = row_count;
	if deleted_count = 1 then
		return jsonb_build_object('deleted', true, 'missing', false);
	end if;

	select exists (
		select 1 from public.quiz_active_attempts
		where quiz_id = p_quiz_id and username = p_username
	) into attempt_exists;
	return jsonb_build_object('deleted', false, 'missing', not attempt_exists);
end;
$$;

revoke all on function public.claim_quiz_active_attempt(text, text, text, jsonb) from public;
drop function if exists public.save_quiz_active_attempt(text, text, bigint, uuid, bigint, jsonb);
revoke all on function public.save_quiz_active_attempt(text, text, bigint, uuid, bigint, uuid, jsonb) from public;
revoke all on function public.delete_quiz_active_attempt(text, text, bigint, uuid) from public;
grant execute on function public.claim_quiz_active_attempt(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.save_quiz_active_attempt(text, text, bigint, uuid, bigint, uuid, jsonb) to anon, authenticated;
grant execute on function public.delete_quiz_active_attempt(text, text, bigint, uuid) to anon, authenticated;
