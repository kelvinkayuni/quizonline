# ASSESSMENT GATEWAY

A browser-based quiz dashboard with separate teacher and student experiences.

## Run

Install dependencies and start the Vite server:

```bash
npm install
npm run dev
```

An internet connection is needed for Supabase, Google Fonts, and the SheetJS CDN assets used by the interface and Excel tools.

## Teacher and student access

- Teacher: `APP_USERNAME` from `.env` and the password for the Supabase Auth account `kelvinkayuni13@gmail.com`.
- Student: Import student credentials through the Student access screen.

Create the teacher user in Supabase Auth before running the quiz question history migration. The migration marks that exact Auth user's protected `app_metadata.role` as `teacher`; the app verifies this role at sign-in, and the database checks the signed-in teacher claim for question-history reads, publication, and result/history deletion. Do not use `user_metadata` for this role.

## Included

- Teacher dashboard with overview, question bank, quiz configuration, student Excel import, live monitoring, and results export.
- Reusable multiple-choice and short-answer questions with per-question marks.
- Teacher-only question-corrections PDF downloads with answer keys from the saved question bank.
- Separate Supabase archives of each published quiz question set, including answer keys and teacher-only short-answer reference answers; teachers can view and download these snapshots without affecting the current question bank.
- Short-answer questions keep expected concepts for marking separate from an optional teacher reference answer.
- Short-answer matching normalizes common gemology answer variants, including weight/size/toughness terms, chipping/breaking, and resistance synonyms; selected connector words are ignored between concepts.
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

For student per-quiz detailed report downloads, first apply the current `supabase-active-attempts.sql` and `supabase-complete-attempt.sql`, then run [`supabase-student-quiz-reports.sql`](supabase-student-quiz-reports.sql) in the Supabase SQL Editor before deploying the matching app. The active-attempt save function writes each submitted question, the student's answer, and its marks into the separate, browser-inaccessible `student_quiz_report_answers` table in the same transaction as the progress save; the app starts that save immediately after submission and allows the student to continue while it syncs. If a transient save fails, later progress saves retry the current answer data. At quiz completion, the app flushes pending progress, and the detailed report is saved atomically with the official result; a credential-checked, read-only report RPC enables downloads. Deleting an official result by a teacher removes both the report and its per-question rows. Students can download a report from each quiz-history row but have no option to delete their history. Detailed reports are available only for attempts completed after this migration; older summaries remain in history and display an unavailable message when a report is requested. Re-run these current migrations if earlier versions were already applied.

Before deploying the atomic quiz-publication app changes, run [`supabase-publish-quiz.sql`](supabase-publish-quiz.sql) in the Supabase SQL Editor. It installs a database function that writes the published quiz configuration and its question snapshot in one transaction while preserving other workspace data. The teacher interface verifies the saved configuration first, then retries snapshot verification for up to 30 seconds. If Supabase cannot confirm the outcome, the quiz ID is retained and the interface offers a status check rather than creating another publication. When enabling authenticated question history, run `supabase-quiz-question-history.sql` after this script; it replaces the publication function with a teacher-authenticated version.

For a separate archive of published teacher question sets, first create the Supabase Auth user `kelvinkayuni13@gmail.com`, then run [`supabase-quiz-question-history.sql`](supabase-quiz-question-history.sql) after the existing quiz publication, workspace, and results tables/functions are installed. The migration marks the account's protected app metadata as a teacher, creates a browser-inaccessible archive table, and replaces quiz publication, history read, and result deletion functions with teacher-authenticated versions. Each publication stores an immutable snapshot of its questions, choices, correct answers, marks, short-answer expected concepts, and teacher reference answers. The Saved Questions panel's View quiz history control loads archives, and each archived quiz can be downloaded as a PDF. Clear all only affects the current question bank. Deleting a quiz's result file (or clearing result-file history) removes that quiz's archive and detailed student reports in the same database transaction; clearing the question bank does not. This archive starts with quizzes published after applying the migration; it cannot reconstruct earlier snapshots. Do not rerun `supabase-publish-quiz.sql` afterward, because it would replace the authenticated publication function with its earlier version.

Before deploying the targeted question-delete app change, run [`supabase-delete-question.sql`](supabase-delete-question.sql) in the Supabase SQL Editor. It installs a transaction that deletes the selected question row, removes that question from workspace metadata and the quiz snapshot, clears the active quiz publication as the existing delete action does, adjusts the configured question count, and records the activity entry. It does not delete student results or other questions. The app reports success only after the function confirms the transaction.

The teacher signs in through Supabase Auth; student credentials continue to use the existing workspace-based login. The app claims a student attempt and saves versioned progress through database functions; a newer sign-in takes ownership and invalidates writes from the previous device, which is signed out on its next save attempt. Save IDs make retries idempotent, and revision conflicts return the current server copy so the client only retries when its progress safely extends that copy. On student sign-in, compatible local progress is reconciled with the server copy; incompatible copies do not overwrite the server version. A device that has lost ownership cannot submit its local result at timeout; the active device retains the original deadline and is responsible for automatic submission. Attempt rows are not directly readable by browser clients, and the claim function checks the supplied student credentials against the shared workspace.

Add course metadata to the quiz configuration table:

```sql
alter table public.quiz_config
add column if not exists course_name text,
add column if not exists course_code text;
```
