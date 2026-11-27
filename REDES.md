# Publicar en Instagram y TikTok desde el CRM

El CRM publica directo en Instagram y TikTok, sin Buffer ni otros intermediarios.
En cada publicación (pestaña Semana u Hoy) aparece el recuadro **Publicar en …**:
subes el creativo, escribes el copy y tocas **Publicar ahora** o **Programar**
(usa la fecha y hora de la publicación, hora de Bogotá).

## Cómo funciona por dentro
- `sql/redes.sql`: tablas `redes_cuentas`, `publicaciones` (la cola), `redes_config`,
  el bucket `creativos` (máx. 50 MB por archivo) y el reloj (pg_cron) que revisa la cola cada minuto.
- `supabase/functions/redes-conectar`: recibe el regreso del inicio de sesión de Instagram/TikTok
  y guarda el permiso cifrado en el Vault.
- `supabase/functions/redes-publicar`: sube los creativos y publica. Los videos de Drive los
  descarga el servidor (hasta 120 MB) y los manda directo a Instagram/TikTok.
- Los permisos de Instagram duran 60 días y se renuevan solos cada noche.

## Configuración (una sola vez)
### Instagram (app de Meta "CRM de Luisa", ya creada)
Las apps nuevas de Meta ya no ofrecen "inicio de sesión con Instagram"; usan el **inicio de sesión unificado**
(Facebook Login para empresas con una configuración). Ya está configurado:
- Caso de uso "Administrar mensajes y contenido en Instagram", configuración de inicio de sesión
  `1170894498642054` (token de usuario del sistema, no vence).
- URL de redireccionamiento: `https://tvithmizrwinwsdsnabr.supabase.co/functions/v1/redes-conectar/instagram`
- El identificador de la app y el de la configuración están guardados en `redes_config`.

Falta solo: copiar la **clave secreta de la app** (developers.facebook.com › CRM de Luisa › Configuración de la app ›
Básica) en el CRM, pestaña **Redes › Datos de las apps**, y tocar **Conectar** en cada marca, eligiendo
solo la cuenta de Instagram de esa marca.

### TikTok
1. En developers.tiktok.com crea una app con **Login Kit** y **Content Posting API**
   (activa "Direct Post"). Permisos: `user.info.basic`, `video.upload`, `video.publish`.
2. Redirect URI: `https://tvithmizrwinwsdsnabr.supabase.co/functions/v1/redes-conectar/tiktok`
3. Copia el **Client key** y el **Client secret** en el CRM (Redes › Datos de las apps).

Límite de TikTok: mientras TikTok no apruebe la app, "Publicar directo" sale solo en privado.
La opción **A mis borradores de TikTok** manda el video a la bandeja de la app de TikTok
y desde ahí se publica con un toque.
