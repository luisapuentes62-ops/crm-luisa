// Regreso del inicio de sesión de Instagram / TikTok.
// Instagram o TikTok redirigen aquí con ?code=…&state=…; esta función cambia el código
// por un permiso (token), lo guarda cifrado en el Vault y vuelve al CRM.
// URLs que se registran en las apps:
//   https://tvithmizrwinwsdsnabr.supabase.co/functions/v1/redes-conectar/instagram
//   https://tvithmizrwinwsdsnabr.supabase.co/functions/v1/redes-conectar/tiktok
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SUPA_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BASE = SUPA_URL.replace(/\/$/, "") + "/functions/v1/redes-conectar/";
const IG_VER = "v22.0";
const VOLVER_OK = [/^https:\/\/crm-personalized\.netlify\.app\//, /^https:\/\/luisapuentes62-ops\.github\.io\//, /^http:\/\/localhost(:\d+)?\//];
const VOLVER_DEF = "https://crm-personalized.netlify.app/";

async function config(clave: string) {
  const { data } = await sb.from("redes_config").select("valor").eq("clave", clave).maybeSingle();
  return data?.valor as string | undefined;
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
async function json(r: Response) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
}
function volverA(url: string | null | undefined, ok: boolean, msg: string) {
  const base = url && VOLVER_OK.some((re) => re.test(url)) ? url.split("#")[0] : VOLVER_DEF;
  const hash = ok ? "#redes-ok=" + encodeURIComponent(msg) : "#redes-error=" + encodeURIComponent(msg);
  return new Response(null, { status: 302, headers: { Location: base + hash } });
}

async function guardarCuenta(c: {
  red: string; marca: string; cuenta: string; ext_id: string; email: string | null;
  token: string; expira: Date; refresh?: string; refresh_expira?: Date;
}) {
  // Una cuenta por red y marca: si ya existía, se reemplaza
  const { data: prev } = await sb.from("redes_cuentas").select("id").eq("red", c.red).eq("marca", c.marca).maybeSingle();
  const id = prev?.id ?? crypto.randomUUID();
  const token_id = await guardarSecreto("redes:tok:" + id, c.token);
  const refresh_id = c.refresh ? await guardarSecreto("redes:ref:" + id, c.refresh) : null;
  const row = {
    id, red: c.red, marca: c.marca, cuenta: c.cuenta, ext_id: c.ext_id, token_id, refresh_id,
    expira: c.expira.toISOString(), refresh_expira: c.refresh_expira?.toISOString() ?? null,
    conectado_por: c.email, actualizado: new Date().toISOString(),
  };
  const { error } = await sb.from("redes_cuentas").upsert(row);
  if (error) throw error;
}

async function instagram(code: string, st: { marca: string; email: string | null }) {
  const appId = await config("ig_app_id");
  const secret = await secreto("redes:ig_app_secret");
  if (!appId || !secret) throw new Error("Faltan el App ID o la clave secreta de Instagram en el CRM.");
  // 1) Código → permiso corto
  const f = new URLSearchParams({ client_id: appId, client_secret: secret, grant_type: "authorization_code", redirect_uri: BASE + "instagram", code });
  const r1 = await json(await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: f }));
  const corto = r1.access_token ?? r1.data?.[0]?.access_token;
  if (!corto) throw new Error("Instagram no entregó el permiso: " + (r1.error_message || r1.error?.message || JSON.stringify(r1).slice(0, 200)));
  // 2) Permiso corto → permiso de 60 días
  const r2 = await json(await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(secret)}&access_token=${encodeURIComponent(corto)}`));
  if (!r2.access_token) throw new Error("Instagram no entregó el permiso largo: " + (r2.error?.message || ""));
  // 3) Datos de la cuenta
  const me = await json(await fetch(`https://graph.instagram.com/${IG_VER}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(r2.access_token)}`));
  if (!me.user_id && !me.id) throw new Error("No se pudo leer la cuenta de Instagram: " + (me.error?.message || ""));
  await guardarCuenta({
    red: "instagram", marca: st.marca, cuenta: "@" + (me.username || ""), ext_id: String(me.user_id || me.id), email: st.email,
    token: r2.access_token, expira: new Date(Date.now() + (Number(r2.expires_in) || 5184000) * 1000),
  });
  return "@" + (me.username || "");
}

async function tiktok(code: string, st: { marca: string; email: string | null }) {
  const key = await config("tt_client_key");
  const secret = await secreto("redes:tt_client_secret");
  if (!key || !secret) throw new Error("Faltan el Client key o el Client secret de TikTok en el CRM.");
  const f = new URLSearchParams({ client_key: key, client_secret: secret, code, grant_type: "authorization_code", redirect_uri: BASE + "tiktok" });
  const r = await json(await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: f,
  }));
  if (!r.access_token) throw new Error("TikTok no entregó el permiso: " + (r.error_description || r.error || ""));
  const u = await json(await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", {
    headers: { Authorization: "Bearer " + r.access_token },
  }));
  const nombre = u.data?.user?.display_name || "TikTok";
  await guardarCuenta({
    red: "tiktok", marca: st.marca, cuenta: nombre, ext_id: String(r.open_id), email: st.email,
    token: r.access_token, expira: new Date(Date.now() + (Number(r.expires_in) || 86400) * 1000),
    refresh: r.refresh_token, refresh_expira: new Date(Date.now() + (Number(r.refresh_expires_in) || 31536000) * 1000),
  });
  return nombre;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const red = url.pathname.split("/").filter(Boolean).pop();
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (red !== "instagram" && red !== "tiktok") return new Response("Ruta no válida", { status: 404 });
  if (!state) return volverA(null, false, "Falta el estado de la conexión. Vuelve a intentarlo desde el CRM.");
  const { data: rows, error } = await sb.rpc("redes_tomar_estado", { p_state: state });
  const st = !error && Array.isArray(rows) ? rows[0] : null;
  if (!st || st.red !== red) return volverA(null, false, "La conexión venció o no es válida. Vuelve a intentarlo desde el CRM.");
  const denied = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (denied || !code) return volverA(st.volver, false, "No se dio el permiso" + (denied ? ": " + denied : "."));
  try {
    const cuenta = red === "instagram" ? await instagram(code, st) : await tiktok(code, st);
    return volverA(st.volver, true, `${red === "instagram" ? "Instagram" : "TikTok"} ${cuenta} conectado a ${st.marca}`);
  } catch (e) {
    console.error(e);
    return volverA(st.volver, false, String((e as Error).message || e).slice(0, 300));
  }
});
