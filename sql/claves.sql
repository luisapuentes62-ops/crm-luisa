-- Accesos con usuario y contraseña (sin Bitwarden).
-- Las contraseñas se guardan CIFRADAS en Supabase Vault, nunca en texto plano en la tabla.
-- Solo se pueden leer con la función ver_clave(), que revisa permisos y deja registro.

alter table public.accesos add column if not exists clave_id uuid;   -- id del secreto en vault.secrets
alter table public.accesos drop constraint if exists bitwarden_es_enlace;
alter table public.accesos drop column if exists bitwarden_url;

-- Registro de quién vio o copió cada contraseña
create table if not exists public.accesos_log (
  id bigint generated always as identity primary key,
  acceso_id uuid references public.accesos(id) on delete cascade,
  email text not null,
  accion text not null,          -- 'ver' o 'guardar'
  creado timestamptz not null default now()
);
alter table public.accesos_log enable row level security;
revoke all on public.accesos_log from anon;
drop policy if exists "log: admin lee" on public.accesos_log;
create policy "log: admin lee" on public.accesos_log for select to authenticated using (public.es_admin_crm());

create or replace function public.puede_ver_acceso(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.es_admin_crm() or exists (
    select 1 from public.accesos a where a.id = p_id
      and lower(coalesce(auth.jwt()->>'email','')) = any (select lower(x) from unnest(a.permitidos) x));
$$;
revoke all on function public.puede_ver_acceso(uuid) from public, anon;

-- Devuelve la contraseña descifrada solo a quien tiene permiso, y lo registra.
create or replace function public.ver_clave(p_id uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v text;
begin
  if auth.uid() is null or not public.puede_ver_acceso(p_id) then
    raise exception 'sin permiso';
  end if;
  select ds.decrypted_secret into v
    from public.accesos a join vault.decrypted_secrets ds on ds.id = a.clave_id
   where a.id = p_id;
  insert into public.accesos_log(acceso_id, email, accion) values (p_id, lower(auth.jwt()->>'email'), 'ver');
  return v;
end $$;
revoke all on function public.ver_clave(uuid) from public, anon;
grant execute on function public.ver_clave(uuid) to authenticated;

-- Guarda o cambia la contraseña (solo administradores). Vacía = borrarla.
create or replace function public.guardar_clave(p_id uuid, p_clave text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null or not public.es_admin_crm() then
    raise exception 'sin permiso';
  end if;
  select clave_id into cid from public.accesos where id = p_id;
  if not found then raise exception 'no existe'; end if;
  if coalesce(p_clave,'') = '' then
    if cid is not null then
      update public.accesos set clave_id = null where id = p_id;
      delete from vault.secrets where id = cid;
    end if;
  elsif cid is null then
    cid := vault.create_secret(p_clave, 'acceso_' || p_id::text, 'Contraseña de un acceso del CRM');
    update public.accesos set clave_id = cid, actualizado = now() where id = p_id;
  else
    perform vault.update_secret(cid, p_clave);
    update public.accesos set actualizado = now() where id = p_id;
  end if;
  insert into public.accesos_log(acceso_id, email, accion) values (p_id, lower(auth.jwt()->>'email'), 'guardar');
end $$;
revoke all on function public.guardar_clave(uuid, text) from public, anon;
grant execute on function public.guardar_clave(uuid, text) to authenticated;

-- Al borrar un acceso, borra también su contraseña del Vault.
create or replace function public.borrar_clave_de_acceso() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.clave_id is not null then delete from vault.secrets where id = old.clave_id; end if;
  return old;
end $$;
revoke all on function public.borrar_clave_de_acceso() from public, anon, authenticated;
drop trigger if exists accesos_borrar_clave on public.accesos;
create trigger accesos_borrar_clave after delete on public.accesos for each row execute function public.borrar_clave_de_acceso();

-- Nadie puede poner clave_id a mano desde la app (solo guardar_clave).
revoke insert, update on public.accesos from authenticated;
grant insert (marca, red, cuenta, url, permitidos, notas) on public.accesos to authenticated;
grant update (marca, red, cuenta, url, permitidos, notas, actualizado) on public.accesos to authenticated;

-- Arreglo del aviso de Supabase sobre search_path.
create or replace function public.soy_admin_crm() returns boolean language sql stable set search_path = public as $$ select public.es_admin_crm() $$;
