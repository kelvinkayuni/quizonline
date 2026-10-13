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
	completed_result public.quiz_attempts;
begin
	perform pg_advisory_xact_lock(hashtext(p_quiz_id), hashtext(p_username));

	if not exists (
		select 1
		from public.quiz_workspace workspace,
			jsonb_array_elements(coalesce(workspace.data->'users', '[]'::jsonb)) as users(user_record)
		where user_record->>'username' = p_username
			and user_record->>'password' = p_password
	) then
		raise exception 'Student credentials could not be verified.' using errcode = '28000';
	end if;

	select * into completed_result
	from public.quiz_attempts
	where username = p_username and quiz_id = p_quiz_id;

	if found then
		return jsonb_build_object(
			'completed', true,
			'result', to_jsonb(completed_result)
		);
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
begin
	if coalesce(p_result->>'username', '') <> p_username
		or coalesce(p_result->>'quizId', '') <> p_quiz_id
		or coalesce(p_result->>'completedAt', '') = '' then
		raise exception 'Completed result does not match the active attempt.'
			using errcode = '22023';
	end if;

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

	delete from public.quiz_active_attempts
	where quiz_id = p_quiz_id
		and username = p_username
		and generation = p_generation
		and owner_token = p_owner_token;

	return jsonb_build_object(
		'saved', true,
		'already_completed', inserted_count = 0,
		'result', to_jsonb(saved_result)
	);
end;
$$;

revoke all on function public.complete_quiz_active_attempt(text, text, bigint, uuid, jsonb) from public;
grant execute on function public.claim_quiz_active_attempt(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.complete_quiz_active_attempt(text, text, bigint, uuid, jsonb) to anon, authenticated;

create or replace function public.prevent_completed_quiz_result_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
	raise exception 'Completed quiz results are immutable; a result already exists for this student and quiz.'
		using errcode = '23514';
end;
$$;

revoke all on function public.prevent_completed_quiz_result_update() from public;
revoke update on table public.quiz_attempts from anon, authenticated, public;
drop trigger if exists prevent_completed_quiz_result_update on public.quiz_attempts;
create trigger prevent_completed_quiz_result_update
before update on public.quiz_attempts
for each row
execute function public.prevent_completed_quiz_result_update();
