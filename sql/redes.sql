-- Publicar directo en Instagram y TikTok desde el CRM, sin intermediarios.
-- Las claves de las apps (Meta y TikTok) y los permisos de cada cuenta se guardan
-- CIFRADOS en Supabase Vault. Solo las funciones del servidor (edge functions) los leen.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Datos públicos de las apps (App ID de Meta, Client key de TikTok). Los secretos van al Vault.
create table if not exists public.redes_config (
  clave text primary key,
  valor text
);
alter table public.redes_config enable row level security;
revoke all on public.redes_config from anon;
drop policy if exists "redes_config: equipo lee" on public.redes_config;
create policy "redes_config: equipo lee" on public.redes_config for select to authenticated using (true);

-- Cuentas conectadas: una de Instagram y una de TikTok por marca.
create table if not exists public.redes_cuentas (
  id uuid primary key default gen_random_uuid(),
  red text not null check (red in ('instagram','tiktok')),
  marca text not null,
  cuenta text,                 -- @usuario o nombre visible
  ext_id text not null,        -- id de la cuenta en Instagram / open_id en TikTok
  token_id uuid,               -- secreto en vault.secrets
  refresh_id uuid,             -- secreto en vault.secrets (TikTok)
  expira timestamptz,
  refresh_expira timestamptz,
  conectado_por text,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  unique (red, marca)
);
alter table public.redes_cuentas enable row level security;
revoke all on public.redes_cuentas from anon;
drop policy if exists "redes_cuentas: equipo lee" on public.redes_cuentas;
create policy "redes_cuentas: equipo lee" on public.redes_cuentas for select to authenticated using (true);
drop policy if exists "redes_cuentas: admin borra" on public.redes_cuentas;
create policy "redes_cuentas: admin borra" on public.redes_cuentas for delete to authenticated using (public.es_admin_crm());

create or replace function public.redes_cuentas_borrar_tokens()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from vault.secrets where id in (old.token_id, old.refresh_id);
  return old;
end $$;
drop trigger if exists redes_cuentas_borrar_tokens on public.redes_cuentas;
create trigger redes_cuentas_borrar_tokens after delete on public.redes_cuentas
  for each row execute function public.redes_cuentas_borrar_tokens();

-- Estados temporales del inicio de sesión con Instagram/TikTok (protegen el regreso al CRM)
create table if not exists public.redes_estados (
  state text primary key,
  red text not null,
  marca text not null,
  email text,
  volver text,
  creado timestamptz not null default now()
);
alter table public.redes_estados enable row level security;
revoke all on public.redes_estados from anon, authenticated;

-- Cola de publicaciones: el CRM las crea y el servidor las sube a su hora.
create table if not exists public.publicaciones (
  id uuid primary key default gen_random_uuid(),
  contenido_id text not null,
  cuenta_id uuid references public.redes_cuentas(id) on delete set null,
  red text not null check (red in ('instagram','tiktok')),
  tipo text not null,          -- instagram: reel | imagen | historia_imagen | historia_video; tiktok: borrador | directo
  media_url text not null,
  copy text,
  privacidad text,             -- TikTok directo: SELF_ONLY, PUBLIC_TO_EVERYONE, ...
  programada timestamptz not null default now(),
  estado text not null default 'pendiente'
    check (estado in ('pendiente','subiendo','procesando','publicando','publicada','en_borradores','error','cancelada')),
  ext_id text,                 -- contenedor de Instagram / publish_id de TikTok
  post_id text,
  permalink text,
  error text,
  intentos int not null default 0,
  creado_por text default lower(coalesce(auth.jwt()->>'email','')),
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
create index if not exists publicaciones_estado on public.publicaciones (estado, programada);
create index if not exists publicaciones_contenido on public.publicaciones (contenido_id);
alter table public.publicaciones enable row level security;
revoke all on public.publicaciones from anon;
drop policy if exists "publicaciones: equipo lee" on public.publicaciones;
create policy "publicaciones: equipo lee" on public.publicaciones for select to authenticated using (true);
drop policy if exists "publicaciones: equipo crea" on public.publicaciones;
create policy "publicaciones: equipo crea" on public.publicaciones for insert to authenticated
  with check (estado = 'pendiente' and intentos = 0 and ext_id is null and post_id is null);
-- El equipo solo puede cancelar una pendiente o volver a intentar una con error
drop policy if exists "publicaciones: cancelar o reintentar" on public.publicaciones;
create policy "publicaciones: cancelar o reintentar" on public.publicaciones for update to authenticated
  using (estado in ('pendiente','error')) with check (estado in ('pendiente','cancelada') and post_id is null);
do $$ begin
  alter publication supabase_realtime add table public.publicaciones;
exception when duplicate_object then null; end $$;

-- ---------- Funciones ----------
-- Solo el servidor: leer y guardar secretos del Vault
create or replace function public.redes_secreto(p_nombre text)
returns text language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_nombre limit 1;
$$;
create or replace function public.redes_guardar_secreto(p_nombre text, p_valor text)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = p_nombre;
  if coalesce(p_valor,'') = '' then
    if sid is not null then delete from vault.secrets where id = sid; end if;
    return null;
  end if;
  if sid is null then sid := vault.create_secret(p_valor, p_nombre);
  else perform vault.update_secret(sid, p_valor); end if;
  return sid;
end $$;
create or replace function public.redes_tomar_estado(p_state text)
returns table (red text, marca text, email text, volver text)
language sql volatile security definer set search_path = public as $$
  delete from public.redes_estados e
   where e.state = p_state and e.creado > now() - interval '20 minutes'
  returning e.red, e.marca, e.email, e.volver;
$$;
revoke all on function public.redes_secreto(text) from public, anon, authenticated;
revoke all on function public.redes_guardar_secreto(text,text) from public, anon, authenticated;
revoke all on function public.redes_tomar_estado(text) from public, anon, authenticated;
grant execute on function public.redes_secreto(text) to service_role;
grant execute on function public.redes_guardar_secreto(text,text) to service_role;
grant execute on function public.redes_tomar_estado(text) to service_role;

-- Administrador: guardar los datos de las apps. Vacío = no cambiar.
create or replace function public.redes_config_guardar(p_ig_app_id text, p_ig_secret text, p_tt_key text, p_tt_secret text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.es_admin_crm() then raise exception 'sin permiso'; end if;
  if coalesce(p_ig_app_id,'') <> '' then
    insert into public.redes_config values ('ig_app_id', trim(p_ig_app_id)) on conflict (clave) do update set valor = excluded.valor;
  end if;
  if coalesce(p_tt_key,'') <> '' then
    insert into public.redes_config values ('tt_client_key', trim(p_tt_key)) on conflict (clave) do update set valor = excluded.valor;
  end if;
  if coalesce(p_ig_secret,'') <> '' then perform public.redes_guardar_secreto('redes:ig_app_secret', trim(p_ig_secret)); end if;
  if coalesce(p_tt_secret,'') <> '' then perform public.redes_guardar_secreto('redes:tt_client_secret', trim(p_tt_secret)); end if;
end $$;
revoke all on function public.redes_config_guardar(text,text,text,text) from public, anon;
grant execute on function public.redes_config_guardar(text,text,text,text) to authenticated;

-- Para mostrar en el CRM si ya están guardados los secretos (sin revelarlos)
create or replace function public.redes_config_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ig_secret', exists (select 1 from vault.secrets where name = 'redes:ig_app_secret'),
    'tt_secret', exists (select 1 from vault.secrets where name = 'redes:tt_client_secret'));
$$;
revoke all on function public.redes_config_estado() from public, anon;
grant execute on function public.redes_config_estado() to authenticated;

-- Administrador: empezar a conectar una cuenta. Devuelve el "state" para el inicio de sesión.
create or replace function public.redes_iniciar(p_red text, p_marca text, p_volver text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare s text;
begin
  if auth.uid() is null or not public.es_admin_crm() then raise exception 'sin permiso'; end if;
  if p_red not in ('instagram','tiktok') then raise exception 'red no válida'; end if;
  delete from public.redes_estados where creado < now() - interval '1 day';
  s := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.redes_estados (state, red, marca, email, volver)
    values (s, p_red, p_marca, lower(auth.jwt()->>'email'), p_volver);
  return s;
end $$;
revoke all on function public.redes_iniciar(text,text,text) from public, anon;
grant execute on function public.redes_iniciar(text,text,text) to authenticated;

-- ---------- Programación ----------
-- Clave interna para que el reloj (pg_cron) despierte la función que publica
select public.redes_guardar_secreto('redes:cron', encode(extensions.gen_random_bytes(24), 'hex'))
 where not exists (select 1 from vault.secrets where name = 'redes:cron');

-- Cada minuto: si hay algo por subir o en proceso, despierta la función
select cron.unschedule('redes-publicar') where exists (select 1 from cron.job where jobname = 'redes-publicar');
select cron.schedule('redes-publicar', '* * * * *', $job$
  select net.http_post(
    url := 'https://tvithmizrwinwsdsnabr.supabase.co/functions/v1/redes-publicar',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'redes:cron')),
    body := '{}'::jsonb, timeout_milliseconds := 5000)
  where exists (select 1 from public.publicaciones
    where (estado = 'pendiente' and programada <= now()) or estado in ('subiendo','procesando','publicando'));
$job$);

-- Cada día a las 3 a. m. de Bogotá (8:00 UTC): renueva permisos y limpia archivos viejos
select cron.unschedule('redes-mantenimiento') where exists (select 1 from cron.job where jobname = 'redes-mantenimiento');
select cron.schedule('redes-mantenimiento', '0 8 * * *', $job$
  select net.http_post(
    url := 'https://tvithmizrwinwsdsnabr.supabase.co/functions/v1/redes-publicar',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'redes:cron')),
    body := '{"mantenimiento":true}'::jsonb, timeout_milliseconds := 5000);
$job$);

-- ---------- Archivos (creativos) ----------
-- Bucket público de lectura (Instagram y TikTok necesitan descargar el archivo). Máx. 50 MB (plan gratis).
insert into storage.buckets (id, name, public, file_size_limit)
values ('creativos', 'creativos', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;
drop policy if exists "creativos: equipo sube" on storage.objects;
create policy "creativos: equipo sube" on storage.objects for insert to authenticated with check (bucket_id = 'creativos');
drop policy if exists "creativos: equipo borra" on storage.objects;
create policy "creativos: equipo borra" on storage.objects for delete to authenticated using (bucket_id = 'creativos');
