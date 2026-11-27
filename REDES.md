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
### Instagram
1. Cada Instagram debe ser cuenta **profesional** (empresa o creador).
2. En developers.facebook.com crea una app (tipo "Empresa") y agrega el producto
   **Instagram › API con inicio de sesión de Instagram**.
3. En "Configurar el inicio de sesión para empresas" pega como URL de redireccionamiento:
   `https://tvithmizrwinwsdsnabr.supabase.co/functions/v1/redes-conectar/instagram`
4. En "Roles de la app › Probadores de Instagram" agrega cada cuenta, y acepta la invitación
   desde Instagram (Configuración › Apps y sitios web › Invitaciones de evaluador).
5. Copia el **ID de la app de Instagram** y la **clave secreta de la app de Instagram**
   en el CRM, pestaña **Redes › Datos de las apps**, y luego toca **Conectar** en cada marca.

La app puede quedarse en modo desarrollo: solo la usan tus propias cuentas.

### TikTok
1. En developers.tiktok.com crea una app con **Login Kit** y **Content Posting API**
   (activa "Direct Post"). Permisos: `user.info.basic`, `video.upload`, `video.publish`.
2. Redirect URI: `https://tvithmizrwinwsdsnabr.supabase.co/functions/v1/redes-conectar/tiktok`
3. Copia el **Client key** y el **Client secret** en el CRM (Redes › Datos de las apps).

Límite de TikTok: mientras TikTok no apruebe la app, "Publicar directo" sale solo en privado.
La opción **A mis borradores de TikTok** manda el video a la bandeja de la app de TikTok
y desde ahí se publica con un toque.
