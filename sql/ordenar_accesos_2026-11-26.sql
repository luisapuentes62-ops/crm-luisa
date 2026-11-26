-- Ordena los accesos después de la importación del 26-nov-2026.
-- Solo mueve punteros a contraseñas ya cifradas; no contiene contraseñas. Se puede correr dos veces sin daño.
begin;
-- 1) La clave que cayó en Instagram de Crear Emprendedor era la del sitio web
update public.accesos s set clave_id = i.clave_id, notas = null, actualizado = now()
  from public.accesos i
 where s.id = 'd9edc467-f11d-4239-9afa-dcaf62d7feb5' and i.id = '7f130d74-1427-4c95-a659-70c2254d9566'
   and s.clave_id is null and i.clave_id is not null
   and exists (select 1 from public.accesos where id = 'efa5fdea-d9d5-4778-97e9-617bc888d6a7');
update public.accesos set clave_id = null
 where id = '7f130d74-1427-4c95-a659-70c2254d9566'
   and clave_id = (select clave_id from public.accesos where id = 'd9edc467-f11d-4239-9afa-dcaf62d7feb5');
-- 2) Pasar la clave de cada fila duplicada a su cuenta original y borrar el duplicado
create temp table _m(dup uuid, orig uuid) on commit drop;
insert into _m values
 ('46547edd-d912-4aac-8b52-312a7768017c','584554eb-ac42-449f-97ee-7c0ae199c8c3'),
 ('d9147a77-e564-4583-a233-6f0fa0efc7f3','e37f0560-903d-47d9-baeb-3b30840c073b'),
 ('d67d7f9c-8e57-4b81-9bbf-cfb3c92a0d56','9e32501e-3b8e-4fe3-a6aa-252368de02e4'),
 ('efa5fdea-d9d5-4778-97e9-617bc888d6a7','7f130d74-1427-4c95-a659-70c2254d9566'),
 ('96be89c4-03d4-4d35-9c87-c28a6041e023','70e8af89-193f-4cef-be7e-09c3ad6893b4'),
 ('b45309a5-1e4c-48ba-87c5-3f4be1343dae','8172ff2d-089c-4e63-af74-286f7367a301'),
 ('3a4ad4b5-37de-4628-8d6b-4fb0d7d03fa8','7c9434cd-a81a-472f-9445-368d5c464a25');
update public.accesos o set clave_id = d.clave_id, actualizado = now()
  from _m join public.accesos d on d.id = _m.dup
 where o.id = _m.orig and o.clave_id is null;
update public.accesos a set clave_id = null from _m
 where a.id = _m.dup and exists (select 1 from public.accesos o where o.id = _m.orig and o.clave_id = a.clave_id);
update public.accesos_log l set acceso_id = _m.orig from _m where l.acceso_id = _m.dup;
delete from public.accesos a using _m where a.id = _m.dup and a.clave_id is null;
-- 3) Filas del Sheets con usuario + sitio: son el acceso al sitio web
update public.accesos set red = 'Sitio web', notas = null, actualizado = now()
 where id in ('3877f068-3d0e-4ecf-b538-8cb4324abfa5','0769a744-03b8-4ec2-bd64-d341fccf5b35','1cc3dba8-8839-4cf4-88f4-73cc5c7e6253');
update public.accesos set red = 'Sitio web', notas = 'En el Sheets la contraseña decía "No disponible".', actualizado = now()
 where id = 'afccb476-0dbf-41bb-89e5-dcb2bac60f19';
update public.accesos set notas = null where id = '34545e3a-6908-42e3-a9c6-cf5f60da6994';
-- 4) Sitio web de CAVPRO
insert into public.accesos(marca, red, url)
select 'CAVPRO', 'Sitio web', 'https://cavpro.co'
 where not exists (select 1 from public.accesos where marca = 'CAVPRO' and red = 'Sitio web');
commit;
select marca, red, clave_id is not null as tiene_clave from public.accesos order by marca, red;
