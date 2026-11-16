-- Super Pronostici: accesso con approvazione manuale
-- Eseguire una sola volta nel Supabase SQL Editor.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  first_name text,
  last_name text,
  birth_date date,
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name text;
alter table public.profiles add column if not exists birth_date date;

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
declare
  v_birth_date date;
  v_first_name text;
  v_last_name text;
begin
  begin
    v_birth_date := nullif(new.raw_user_meta_data ->> 'birth_date', '')::date;
  exception when others then
    raise exception 'Data di nascita non valida.';
  end;
  v_first_name := nullif(trim(new.raw_user_meta_data ->> 'first_name'), '');
  v_last_name := nullif(trim(new.raw_user_meta_data ->> 'last_name'), '');
  if v_first_name is null or v_last_name is null or v_birth_date is null then
    raise exception 'Nome, cognome e data di nascita sono obbligatori.';
  end if;
  if v_birth_date > current_date or v_birth_date > (current_date - interval '18 years')::date then
    raise exception 'La registrazione è riservata alle persone maggiorenni (18+).';
  end if;
  insert into public.profiles (user_id, email, first_name, last_name, birth_date, approved)
  values (
    new.id,
    lower(new.email),
    v_first_name,
    v_last_name,
    v_birth_date,
    lower(new.email) = 'frankferra7@gmail.com'
  )
  on conflict (user_id) do update
    set email = excluded.email,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        birth_date = excluded.birth_date;
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
