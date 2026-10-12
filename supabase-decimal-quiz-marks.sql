begin;

alter table public.quiz_attempts
  alter column score type numeric(12, 1) using round(score::numeric, 1),
  alter column total_marks type numeric(12, 1) using round(total_marks::numeric, 1);

do $$
begin
  if to_regclass('public.student_quiz_reports') is not null then
    alter table public.student_quiz_reports
      alter column score type numeric(12, 1) using round(score::numeric, 1),
      alter column total_marks type numeric(12, 1) using round(total_marks::numeric, 1);
  end if;
end;
$$;

commit;