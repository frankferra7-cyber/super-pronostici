-- Super Pronostici: accesso con approvazione manuale
-- Eseguire una sola volta nel Supabase SQL Editor.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.is_super_pronostici_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'frankferra7@gmail.com';
$$;

create or replace function public.handle_new_super_pronostici_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, approved)
  values (
    new.id,
    lower(new.email),
    lower(new.email) = 'frankferra7@gmail.com'
  )
  on conflict (user_id) do update
    set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_super_pronostici_user_created on auth.users;
create trigger on_super_pronostici_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_super_pronostici_user();

drop policy if exists "Users read own profile or admin reads all" on public.profiles;
create policy "Users read own profile or admin reads all"
  on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_super_pronostici_admin());

drop policy if exists "Only admin can approve profiles" on public.profiles;
create policy "Only admin can approve profiles"
  on public.profiles for update to authenticated
  using (public.is_super_pronostici_admin())
  with check (public.is_super_pronostici_admin());

grant select, update on public.profiles to authenticated;
