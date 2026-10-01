# ASSESSMENT GATEWAY

A browser-based quiz dashboard with separate teacher and student experiences.

## Run

Install dependencies and start the Vite server:

```bash
npm install
npm run dev
```

An internet connection is needed for Supabase, Google Fonts, and the SheetJS CDN assets used by the interface and Excel tools.

## Demo access

- Teacher: `APP_USERNAME` / `APP_PASSWORD` from `.env`
- Student: Import student credentials through the Student access screen.

## Included

- Teacher dashboard with overview, question bank, quiz configuration, student Excel import, live monitoring, and results export.
- Reusable multiple-choice and short-answer questions with per-question marks.
- Teacher-only question-corrections PDF downloads with answer keys from the saved question bank.
- Short-answer questions keep expected concepts for marking separate from an optional teacher reference answer.
- Student quiz flow with one question at a time, submit-gated feedback, timer, automatic submission, and no retakes after completion.
- Before starting a published quiz, student sign-in checks Supabase for a result matching that exact username and quiz ID; the database claim function repeats this check atomically to prevent a sign-in race. Completion inserts the result once and deletes the active attempt in the same database transaction. A result already stored for that username and quiz ID is returned unchanged, and later updates are rejected.
- Questions, quiz configuration, imported student accounts, and completed attempts synchronize with Supabase. Active student quiz progress is saved in a dedicated Supabase table so it can resume on another device; browser login sessions remain browser-local.
- `.xlsx` student import and results download through SheetJS.

Supabase tables and Row Level Security policies must exist before synchronization can succeed. The browser uses only `SUPABASE_URL` and `SUPABASE_ANON_KEY`; never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code.

## Shared workspace table

Run this once in the Supabase SQL Editor so student access, activity, result files, and teacher dashboard data are shared across browsers:

```sql
create table if not exists public.quiz_workspace (
	id integer primary key default 1,
	data jsonb not null default '{}'::jsonb,
	updated_at timestamptz not null default now()
);

alter table public.quiz_workspace enable row level security;
grant select, insert, update, delete on public.quiz_workspace to anon, authenticated;

drop policy if exists "quiz workspace browser access" on public.quiz_workspace;
create policy "quiz workspace browser access"
on public.quiz_workspace
for all
to anon, authenticated
using (true)
with check (true);
```

Question type and expected-answer metadata are stored in the `questionBank` array in `quiz_workspace.data` for compatibility, and are also stored directly on question rows. Run [`supabase-short-answer-columns.sql`](supabase-short-answer-columns.sql) before deploying the direct short-answer save update; it adds the type, expected-answer, reference-answer, and metadata timestamp columns and backfills existing rows from workspace metadata. Both question types then save directly to their `questions` row; the short-answer UI and marking continue to use expected concepts as before, while the teacher reference answer remains separate and is not used for marking.

For accurate live-student counts across browsers, also run:

```sql
create table if not exists public.quiz_presence (
	username text not null,
	quiz_id text not null,
	online boolean not null default false,
	last_seen timestamptz not null default now(),
	primary key (username, quiz_id)
);

alter table public.quiz_presence enable row level security;
grant select, insert, update on public.quiz_presence to anon, authenticated;

drop policy if exists "quiz presence browser access" on public.quiz_presence;
create policy "quiz presence browser access"
on public.quiz_presence
for all
to anon, authenticated
using (true)
with check (true);
```

For cross-device resume of in-progress quizzes, run [`supabase-active-attempts.sql`](supabase-active-attempts.sql) in the Supabase SQL Editor after creating `quiz_workspace`. Then run [`supabase-complete-attempt.sql`](supabase-complete-attempt.sql) before deploying the matching app. This second script updates the claim function to check for a completed result atomically, adds an atomic completion function that inserts a result only once and removes the active attempt, rejects updates to completed results, and revokes `UPDATE` from browser roles. The app confirms the result from Supabase before treating submission as complete; if confirmation fails, the student gets a retry state and the active attempt remains available. For both scripts, re-run the current version if an earlier version was already applied.

Before deploying the atomic quiz-publication app changes, run [`supabase-publish-quiz.sql`](supabase-publish-quiz.sql) in the Supabase SQL Editor. It installs a browser-callable database function that writes the published quiz configuration and its question snapshot in one transaction while preserving other workspace data. The teacher interface verifies the saved configuration first, then retries snapshot verification for up to 30 seconds. If Supabase cannot confirm the outcome, the quiz ID is retained and the interface offers a status check rather than creating another publication.

Before deploying the targeted question-delete app change, run [`supabase-delete-question.sql`](supabase-delete-question.sql) in the Supabase SQL Editor. It installs a transaction that deletes the selected question row, removes that question from workspace metadata and the quiz snapshot, clears the active quiz publication as the existing delete action does, adjusts the configured question count, and records the activity entry. It does not delete student results or other questions. The app reports success only after the function confirms the transaction.

The app claims an attempt on student sign-in and saves versioned progress through database functions; a newer sign-in takes ownership and invalidates writes from the previous device, which is signed out on its next save attempt. Save IDs make retries idempotent, and revision conflicts return the current server copy so the client only retries when its progress safely extends that copy. On sign-in, compatible local progress is reconciled with the server copy; incompatible copies do not overwrite the server version. A device that has lost ownership cannot submit its local result at timeout; the active device retains the original deadline and is responsible for automatic submission. Attempt rows are not directly readable by browser clients, and the claim function checks the supplied student credentials against the shared workspace.

Add course metadata to the quiz configuration table:

```sql
alter table public.quiz_config
add column if not exists course_name text,
add column if not exists course_code text;
```
