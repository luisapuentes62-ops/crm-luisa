// Publica en Instagram y TikTok las publicaciones de la cola (tabla publicaciones).
// La despierta el reloj de Supabase (pg_cron, con la cabecera x-cron) cada minuto que haya trabajo,
// o el CRM (con la sesión del usuario) al tocar "Publicar ahora".
// Body opcional: {"mantenimiento":true} renueva permisos y borra creativos viejos;
//                {"accion":"tiktok_info","cuenta_id":"…"} devuelve las opciones de privacidad de TikTok.
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SUPA_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const IG = "https://graph.instagram.com/v22.0";
const TT = "https://open.tiktokapis.com/v2";
const BUCKET = "creativos";
const MAX_BYTES = 120 * 1024 * 1024; // límite de memoria de la función
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Pub = {
  id: string; contenido_id: string; cuenta_id: string | null; red: "instagram" | "tiktok"; tipo: string;
  media_url: string; copy: string | null; privacidad: string | null; programada: string; estado: string;
  ext_id: string | null; intentos: number; actualizado: string;
};
type Cuenta = {
  id: string; red: string; marca: string; cuenta: string; ext_id: string;
  expira: string | null; refresh_expira: string | null;
};

class Falla extends Error {}
const ahora = () => new Date().toISOString();
const minutosDesde = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60000;

async function json(r: Response) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300), status: r.status }; }
}
async function secreto(nombre: string) {
  const { data, error } = await sb.rpc("redes_secreto", { p_nombre: nombre });
  if (error) throw error;
  return data as string | null;
}
async function guardarSecreto(nombre: string, valor: string) {
  const { data, error } = await sb.rpc("redes_guardar_secreto", { p_nombre: nombre, p_valor: valor });
  if (error) throw error;
  return data as string;
}
async function config(clave: string) {
  const { data } = await sb.from("redes_config").select("valor").eq("clave", clave).maybeSingle();
  return data?.valor as string | undefined;
}

// ---------- Permisos ----------
async function cuentaDe(id: string | null): Promise<Cuenta> {
  if (!id) throw new Falla("La cuenta ya no está conectada. Conéctala de nuevo en la pestaña Redes.");
  const { data } = await sb.from("redes_cuentas").select("id,red,marca,cuenta,ext_id,expira,refresh_expira").eq("id", id).maybeSingle();
  if (!data) throw new Falla("La cuenta ya no está conectada. Conéctala de nuevo en la pestaña Redes.");
  return data as Cuenta;
}
async function tokenDe(c: Cuenta): Promise<string> {
  let tok = await secreto("redes:tok:" + c.id);
  if (!tok) throw new Falla("Falta el permiso de la cuenta. Conéctala de nuevo en la pestaña Redes.");
  const vence = c.expira ? new Date(c.expira).getTime() : 0;
  if (c.red === "tiktok" && vence - Date.now() < 10 * 60000) tok = await refrescarTikTok(c);
  if (c.red === "instagram" && vence && vence < Date.now()) throw new Falla("El permiso de Instagram venció. Conéctala de nuevo en la pestaña Redes.");
  return tok;
}
async function refrescarTikTok(c: Cuenta): Promise<string> {
  const key = await config("tt_client_key");
  const sec = await secreto("redes:tt_client_secret");
  const ref = await secreto("redes:ref:" + c.id);
  if (!key || !sec || !ref) throw new Falla("Falta el permiso de TikTok. Conéctala de nuevo en la pestaña Redes.");
  const r = await json(await fetch(TT + "/oauth/token/", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: key, client_secret: sec, grant_type: "refresh_token", refresh_token: ref }),
  }));
  if (!r.access_token) throw new Falla("TikTok no renovó el permiso. Conéctala de nuevo en la pestaña Redes.");
  await guardarSecreto("redes:tok:" + c.id, r.access_token);
  if (r.refresh_token) await guardarSecreto("redes:ref:" + c.id, r.refresh_token);
  await sb.from("redes_cuentas").update({
    expira: new Date(Date.now() + (Number(r.expires_in) || 86400) * 1000).toISOString(),
    refresh_expira: r.refresh_expires_in ? new Date(Date.now() + Number(r.refresh_expires_in) * 1000).toISOString() : c.refresh_expira,
    actualizado: ahora(),
  }).eq("id", c.id);
  return r.access_token;
}
async function refrescarInstagram(c: Cuenta) {
  const tok = await secreto("redes:tok:" + c.id);
  if (!tok) return;
  const r = await json(await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tok)}`));
  if (!r.access_token) { console.error("IG refresh", c.cuenta, r); return; }
  await guardarSecreto("redes:tok:" + c.id, r.access_token);
  await sb.from("redes_cuentas").update({
    expira: new Date(Date.now() + (Number(r.expires_in) || 5184000) * 1000).toISOString(), actualizado: ahora(),
  }).eq("id", c.id);
}

// ---------- Archivos ----------
// Enlaces de Drive → descarga directa
function urlDirecta(u: string) {
  const m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{10,})/.exec(u) || /drive\.usercontent\.google\.com\/[^?]*\?(?:[^#]*&)?id=([\w-]{10,})/.exec(u);
  return m ? `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t` : u;
}
async function descargar(u: string): Promise<{ bytes: Uint8Array; tipo: string }> {
  let r: Response;
  try { r = await fetch(urlDirecta(u), { redirect: "follow" }); } catch { throw new Falla("No se pudo descargar el creativo. Revisa el enlace."); }
  if (!r.ok) throw new Falla(`No se pudo descargar el creativo (error ${r.status}). Si es de Drive, compártelo como "Cualquier persona con el enlace".`);
  const tipo = (r.headers.get("content-type") || "").toLowerCase();
  if (tipo.includes("text/html")) throw new Falla('El enlace abre una página, no el archivo. Si es de Drive, compártelo como "Cualquier persona con el enlace".');
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Falla("El archivo pesa más de 120 MB. Expórtalo más liviano.");
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Falla("El archivo pesa más de 120 MB. Expórtalo más liviano.");
  if (bytes.length < 1000) throw new Falla("El archivo descargado está vacío. Revisa el enlace.");
  return { bytes, tipo };
}
const esJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;
const esNuestro = (u: string) => u.startsWith(SUPA_URL + "/storage/v1/object/public/" + BUCKET + "/");
function tipoVideo(u: string, tipo: string) {
  if (tipo.startsWith("video/")) return tipo;
  return /\.mov(\?|$)/i.test(u) ? "video/quicktime" : "video/mp4";
}

// ---------- Instagram ----------
async function igPost(path: string, params: Record<string, string>, tok: string) {
  const r = await json(await fetch(`${IG}/${path}`, {
    method: "POST", body: new URLSearchParams({ ...params, access_token: tok }),
  }));
  if (r.error) throw new Falla("Instagram: " + (r.error.error_user_msg || r.error.message || "error"));
  return r;
}
async function igSubir(p: Pub, c: Cuenta) {
  const tok = await tokenDe(c);
  const caption = (p.copy || "").slice(0, 2200);
  if (p.tipo === "imagen" || p.tipo === "historia_imagen") {
    // Las imágenes las descarga Instagram: deben ser JPG y estar en un enlace público estable
    let url = p.media_url;
    if (!esNuestro(url)) {
      const { bytes, tipo } = await descargar(url);
      if (!esJpeg(bytes)) throw new Falla("Instagram solo acepta imágenes JPG. Súbela con el botón \"Subir creativo\" del CRM (la convierte sola).");
      const path = `copias/${p.id}.jpg`;
      const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: tipo || "image/jpeg", upsert: true });
      if (up.error) throw new Falla("No se pudo preparar la imagen: " + up.error.message);
      url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    }
    const params: Record<string, string> = { image_url: url };
    if (p.tipo === "historia_imagen") params.media_type = "STORIES"; else params.caption = caption;
    const r = await igPost(`${c.ext_id}/media`, params, tok);
    return String(r.id);
  }
  // Video (reel o historia): subida directa a Instagram, sin que Instagram tenga que descargar de Drive
  const { bytes } = await descargar(p.media_url);
  const historia = p.tipo === "historia_video";
  const params: Record<string, string> = { media_type: historia ? "STORIES" : "REELS", upload_type: "resumable" };
  if (!historia) { params.caption = caption; params.share_to_feed = "true"; }
  const r = await igPost(`${c.ext_id}/media`, params, tok);
  const id = String(r.id);
  const up = await json(await fetch(`https://rupload.facebook.com/ig-api-upload/v22.0/${id}`, {
    method: "POST",
    headers: { Authorization: "OAuth " + tok, offset: "0", file_size: String(bytes.length) },
    body: bytes,
  }));
  if (!up.success) throw new Falla("Instagram no recibió el video: " + (up.debug_info?.message || up.message || JSON.stringify(up).slice(0, 200)));
  return id;
}
async function igAvanzar(p: Pub, c: Cuenta) {
  const tok = await tokenDe(c);
  const st = await json(await fetch(`${IG}/${p.ext_id}?fields=status_code,status&access_token=${encodeURIComponent(tok)}`));
  if (st.error) throw new Falla("Instagram: " + st.error.message);
  if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Falla("Instagram no pudo procesar el archivo: " + (st.status || st.status_code) + ". Revisa formato y duración (reels de 3 s a 15 min, vertical 9:16).");
  if (st.status_code !== "FINISHED") {
    if (minutosDesde(p.actualizado) > 30) throw new Falla("Instagram tardó demasiado procesando el video. Intenta de nuevo.");
    return; // sigue procesando
  }
  // Candado: solo una ejecución publica
  const { data: lock } = await sb.from("publicaciones").update({ estado: "publicando", actualizado: ahora() })
    .eq("id", p.id).eq("estado", "procesando").select("id");
  if (!lock?.length) return;
  const r = await igPost(`${c.ext_id}/media_publish`, { creation_id: String(p.ext_id) }, tok);
  const mediaId = String(r.id);
  const info = await json(await fetch(`${IG}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(tok)}`));
  await terminar(p, "publicada", { post_id: mediaId, permalink: info.permalink || null });
}

// ---------- TikTok ----------
async function ttPost(path: string, body: unknown, tok: string) {
  const r = await json(await fetch(`${TT}/${path}`, {
    method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  }));
  if (r.error && r.error.code && r.error.code !== "ok") {
    const m: Record<string, string> = {
      unaudited_client_can_only_post_to_private_accounts: "TikTok todavía no aprobó la app: solo deja publicar en privado y con la cuenta en modo privado.",
      privacy_level_option_mismatch: "Esa privacidad no está disponible para esta cuenta.",
      spam_risk_too_many_posts: "TikTok bloqueó por demasiadas publicaciones hoy. Intenta mañana.",
      access_token_invalid: "El permiso de TikTok venció. Conéctala de nuevo en la pestaña Redes.",
      scope_not_authorized: "Falta un permiso de TikTok. Conéctala de nuevo en la pestaña Redes.",
    };
    throw new Falla(m[r.error.code] || "TikTok: " + (r.error.message || r.error.code));
  }
  return r.data || {};
}
async function ttSubir(p: Pub, c: Cuenta) {
  const tok = await tokenDe(c);
  const { bytes, tipo } = await descargar(p.media_url);
  const size = bytes.length;
  // Trozos: un solo trozo hasta 64 MB; si no, de 10 MB y el último con el sobrante
  const chunk = size <= 64 * 1024 * 1024 ? size : 10 * 1024 * 1024;
  const total = Math.floor(size / chunk);
  const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: total };
  let data;
  if (p.tipo === "directo") {
    data = await ttPost("post/publish/video/init/", {
      post_info: {
        title: (p.copy || "").slice(0, 2200), privacy_level: p.privacidad || "SELF_ONLY",
        disable_comment: false, disable_duet: false, disable_stitch: false,
      },
      source_info,
    }, tok);
  } else {
    data = await ttPost("post/publish/inbox/video/init/", { source_info }, tok);
  }
  const ct = tipoVideo(p.media_url, tipo);
  for (let i = 0; i < total; i++) {
    const ini = i * chunk;
    const fin = i === total - 1 ? size : ini + chunk;
    const r = await fetch(data.upload_url, {
      method: "PUT",
      headers: { "Content-Type": ct, "Content-Length": String(fin - ini), "Content-Range": `bytes ${ini}-${fin - 1}/${size}` },
      body: bytes.subarray(ini, fin),
    });
    if (!r.ok && r.status !== 206 && r.status !== 201) throw new Falla(`TikTok no recibió el video (error ${r.status}).`);
  }
  return String(data.publish_id);
}
async function ttAvanzar(p: Pub, c: Cuenta) {
  const tok = await tokenDe(c);
  const d = await ttPost("post/publish/status/fetch/", { publish_id: p.ext_id }, tok);
  if (d.status === "FAILED") throw new Falla("TikTok no pudo procesar el video: " + (d.fail_reason || "error") + ".");
  if (d.status === "SEND_TO_USER_INBOX") return terminar(p, "en_borradores", {});
  if (d.status === "PUBLISH_COMPLETE") {
    const pid = Array.isArray(d.publicaly_available_post_id) ? d.publicaly_available_post_id[0] : null;
    return terminar(p, "publicada", { post_id: pid ? String(pid) : null, permalink: null });
  }
  if (minutosDesde(p.actualizado) > 30) throw new Falla("TikTok tardó demasiado procesando el video. Revisa la app de TikTok antes de reintentar.");
}

// ---------- Cola ----------
async function terminar(p: Pub, estado: string, extra: Record<string, unknown>) {
  await sb.from("publicaciones").update({ estado, error: null, actualizado: ahora(), ...extra }).eq("id", p.id);
  if (estado === "publicada") await marcarContenido(p.contenido_id, { estado: "publicado", publicadoEn: ahora(), ...(extra.permalink ? { permalink: extra.permalink } : {}) });
}
async function marcarContenido(id: string, patch: Record<string, unknown>) {
  const { data } = await sb.from("docs").select("data").eq("collection", "contenido").eq("id", id).maybeSingle();
  if (!data) return;
  await sb.from("docs").update({ data: { ...data.data, ...patch, actualizado: ahora() }, updated_at: ahora() })
    .eq("collection", "contenido").eq("id", id);
}
async function fallar(p: Pub, e: unknown) {
  const msg = e instanceof Falla ? e.message : "Error inesperado: " + String((e as Error)?.message || e).slice(0, 250);
  if (!(e instanceof Falla)) console.error(p.id, e);
  await sb.from("publicaciones").update({ estado: "error", error: msg, actualizado: ahora() }).eq("id", p.id);
}

async function procesar() {
  const hechas: string[] = [];
  // 1) Lo que quedó a medias por un corte (la función se detuvo a mitad de una subida)
  const { data: colgadas } = await sb.from("publicaciones").select("*").in("estado", ["subiendo", "publicando"]);
  for (const p of (colgadas || []) as Pub[]) {
    const lim = p.estado === "subiendo" ? 10 : 5;
    if (minutosDesde(p.actualizado) > lim) {
      await fallar(p, new Falla(p.estado === "subiendo"
        ? "La subida se interrumpió. Toca Reintentar."
        : "No se confirmó la publicación. Revisa en la red si salió antes de reintentar."));
    }
  }
  // 2) En proceso: revisar si ya terminó
  const { data: proc } = await sb.from("publicaciones").select("*").eq("estado", "procesando").limit(10);
  for (const p of (proc || []) as Pub[]) {
    try {
      const c = await cuentaDe(p.cuenta_id);
      if (p.red === "instagram") await igAvanzar(p, c); else await ttAvanzar(p, c);
      hechas.push(p.id);
    } catch (e) { await fallar(p, e); }
  }
  // 3) Pendientes cuya hora ya llegó (máx. 2 por vez: subir videos toma tiempo)
  const { data: pend } = await sb.from("publicaciones").select("*").eq("estado", "pendiente")
    .lte("programada", ahora()).order("programada").limit(2);
  for (const p0 of (pend || []) as Pub[]) {
    const { data: lock } = await sb.from("publicaciones")
      .update({ estado: "subiendo", intentos: p0.intentos + 1, error: null, actualizado: ahora() })
      .eq("id", p0.id).eq("estado", "pendiente").select("*");
    const p = lock?.[0] as Pub | undefined;
    if (!p) continue;
    try {
      const c = await cuentaDe(p.cuenta_id);
      const ext = p.red === "instagram" ? await igSubir(p, c) : await ttSubir(p, c);
      const { data: upd } = await sb.from("publicaciones").update({ estado: "procesando", ext_id: ext, actualizado: ahora() }).eq("id", p.id).select("*");
      hechas.push(p.id);
      // Las imágenes suelen estar listas de inmediato
      if (upd?.[0] && p.red === "instagram") { await new Promise((r) => setTimeout(r, 3000)); try { await igAvanzar(upd[0] as Pub, c); } catch (e) { await fallar(p, e); } }
    } catch (e) { await fallar(p, e); }
  }
  return hechas;
}

async function mantenimiento() {
  const { data: cuentas } = await sb.from("redes_cuentas").select("id,red,marca,cuenta,ext_id,expira,refresh_expira");
  for (const c of (cuentas || []) as Cuenta[]) {
    try {
      // Instagram: renovar cuando falten menos de 20 días (el permiso dura 60)
      if (c.red === "instagram" && c.expira && new Date(c.expira).getTime() - Date.now() < 20 * 86400000) await refrescarInstagram(c);
    } catch (e) { console.error("refresh", c.id, e); }
  }
  // Borrar del almacenamiento los creativos de publicaciones terminadas hace más de 15 días (el plan gratis tiene 1 GB)
  const hace = new Date(Date.now() - 15 * 86400000).toISOString();
  const { data: viejas } = await sb.from("publicaciones").select("id,media_url")
    .in("estado", ["publicada", "en_borradores", "cancelada"]).lt("actualizado", hace);
  const { data: activas } = await sb.from("publicaciones").select("media_url").in("estado", ["pendiente", "subiendo", "procesando", "publicando", "error"]);
  const enUso = new Set((activas || []).map((x) => x.media_url));
  const pre = SUPA_URL + "/storage/v1/object/public/" + BUCKET + "/";
  const paths = new Set<string>();
  for (const v of viejas || []) {
    paths.add(`copias/${v.id}.jpg`);
    if (v.media_url.startsWith(pre) && !enUso.has(v.media_url)) paths.add(decodeURIComponent(v.media_url.slice(pre.length)));
  }
  if (paths.size) await sb.storage.from(BUCKET).remove([...paths]);
}

async function tiktokInfo(cuentaId: string) {
  const c = await cuentaDe(cuentaId);
  const tok = await tokenDe(c);
  const d = await ttPost("post/publish/creator_info/query/", {}, tok);
  return { nombre: d.creator_nickname || c.cuenta, privacidad: d.privacy_level_options || [], max_segundos: d.max_video_post_duration_sec || null };
}

const responder = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // Quién llama: el reloj interno o un usuario con sesión en el CRM
  const cron = req.headers.get("x-cron");
  let permitido = false;
  if (cron) permitido = cron === (await secreto("redes:cron"));
  else {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (jwt) { const { data } = await sb.auth.getUser(jwt); permitido = !!data?.user; }
  }
  if (!permitido) return responder({ error: "sin permiso" }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* sin body */ }
  try {
    if (body.accion === "tiktok_info") return responder(await tiktokInfo(String(body.cuenta_id)));
    if (body.mantenimiento) { await mantenimiento(); return responder({ ok: true }); }
    return responder({ ok: true, procesadas: await procesar() });
  } catch (e) {
    console.error(e);
    return responder({ error: e instanceof Falla ? e.message : "Error inesperado" }, 500);
  }
});
