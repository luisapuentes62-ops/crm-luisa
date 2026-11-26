-- "Accesos" del CRM. Base: tabla de accesos con permisos por persona (ver también sql/claves.sql).
-- Cada fila tiene la lista de correos que la pueden ver (permitidos).
-- Los administradores (tabla crm_admins) ven todo y son los únicos que editan.

create table if not exists public.crm_admins (
  email text primary key
);
alter table public.crm_admins enable row level security;
-- Nadie la lee ni la edita desde la app; se administra desde Supabase.

create or replace function public.es_admin_crm()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.crm_admins where lower(email) = lower(coalesce(auth.jwt()->>'email','')));
$$;
revoke all on function public.es_admin_crm() from public, anon;
grant execute on function public.es_admin_crm() to authenticated;

create table if not exists public.accesos (
  id uuid primary key default gen_random_uuid(),
  marca text not null,
  red text not null,                 -- Instagram, TikTok, Gmail, Sitio web...
  cuenta text,                       -- usuario o correo con el que se entra
  url text,                          -- enlace a la red o al sitio
  bitwarden_url text,                -- enlace a la ficha en Bitwarden
  permitidos text[] not null default '{}',  -- correos que pueden ver esta fila
  notas text,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  constraint bitwarden_es_enlace check (bitwarden_url is null or bitwarden_url = '' or bitwarden_url ~* '^https://'),
  constraint url_es_enlace check (url is null or url = '' or url ~* '^https?://')
);
alter table public.accesos enable row level security;
revoke all on public.accesos from anon;

drop policy if exists "accesos: ver los propios" on public.accesos;
create policy "accesos: ver los propios" on public.accesos for select to authenticated
  using (public.es_admin_crm() or lower(coalesce(auth.jwt()->>'email','')) = any (select lower(x) from unnest(permitidos) x));

drop policy if exists "accesos: admin crea" on public.accesos;
create policy "accesos: admin crea" on public.accesos for insert to authenticated with check (public.es_admin_crm());
drop policy if exists "accesos: admin edita" on public.accesos;
create policy "accesos: admin edita" on public.accesos for update to authenticated using (public.es_admin_crm()) with check (public.es_admin_crm());
drop policy if exists "accesos: admin borra" on public.accesos;
create policy "accesos: admin borra" on public.accesos for delete to authenticated using (public.es_admin_crm());

-- Para saber en la app si quien entró es administrador.
create or replace function public.soy_admin_crm() returns boolean language sql stable as $$ select public.es_admin_crm() $$;
revoke all on function public.soy_admin_crm() from public, anon;
grant execute on function public.soy_admin_crm() to authenticated;

-- Después de crear esto, agrega a los administradores desde el editor SQL de Supabase:
--   insert into public.crm_admins(email) values ('correo@ejemplo.com');
