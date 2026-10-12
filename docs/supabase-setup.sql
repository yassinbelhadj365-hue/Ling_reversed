-- Lingo Reader: accounts + sync between devices.
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again.

-- One table holds every synced record (lessons, words, stats, settings) of every user.
-- Row-level security makes sure each user can only see and change their own rows.
create table if not exists public.records (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null,                 -- 'lessons' | 'words' | 'activity' | 'kv'
  key        text not null,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at bigint not null,               -- when the device changed it (ms); the newest wins
  synced_at  timestamptz not null default clock_timestamp(),  -- when the server stored it; devices pull by this
  primary key (user_id, kind, key)
);
create index if not exists records_user_synced on public.records (user_id, synced_at);

alter table public.records enable row level security;
drop policy if exists "own records" on public.records;
create policy "own records" on public.records for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.touch_synced_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.synced_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.touch_synced_at();

-- Upload a batch of changes; a row only replaces the stored one if it is newer.
create or replace function public.push_records(rows jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into public.records (user_id, kind, key, data, deleted, updated_at)
  select auth.uid(), r->>'kind', r->>'key', r->'data',
         coalesce((r->>'deleted')::boolean, false), (r->>'updated_at')::bigint
  from jsonb_array_elements(rows) as r
  on conflict (user_id, kind, key) do update
    set data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at
    where excluded.updated_at > public.records.updated_at;
$$;
revoke execute on function public.push_records(jsonb) from anon;
grant execute on function public.push_records(jsonb) to authenticated;

-- Audio/video files you upload to lessons, in a private bucket: one folder per user.
insert into storage.buckets (id, name, public) values ('media', 'media', false)
  on conflict (id) do nothing;
drop policy if exists "own media" on storage.objects;
create policy "own media" on storage.objects for all to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
