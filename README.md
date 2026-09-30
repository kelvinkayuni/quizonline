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
- Student quiz flow with one question at a time, submit-gated feedback, timer, automatic submission, and no retakes after completion.
- Questions, quiz configuration, and completed attempts synchronize with Supabase. Draft forms, active timers, imported workbook credentials, and browser login sessions remain local until they are moved to authenticated server-side tables.
- `.xlsx` student import and results download through SheetJS.

Supabase tables and Row Level Security policies must exist before synchronization can succeed. The browser uses only `SUPABASE_URL` and `SUPABASE_ANON_KEY`; never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code.

For completed-result storage and the teacher's Clear history action, run [`supabase-quiz-attempts-policies.sql`](supabase-quiz-attempts-policies.sql) in the Supabase SQL Editor. The current browser-based model requires `quiz_attempts` select, insert, update, and delete access for `anon` and `authenticated`.

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

Question type and expected-answer metadata are stored in the `questionBank` array in `quiz_workspace.data`. The `questions` table stores the common question fields; hydration overlays the workspace metadata so short-answer questions are not interpreted as multiple choice.

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

Add course metadata to the quiz configuration table:

```sql
alter table public.quiz_config
add column if not exists course_name text,
add column if not exists course_code text;
```
