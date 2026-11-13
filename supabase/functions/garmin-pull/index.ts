// garmin-pull: haalt Garmin-data rechtstreeks bij Garmin Connect (zelfde native login als python-garminconnect 0.3.x).
// Startsleutel: secret GARMIN_TOKENS (base64 van garmin_tokens.json, door Simon zelf gezet via tools/garmin_login.py).
// Daarna roteert de refresh-token en staat hij in app.garmin_auth (alleen service role).
// Aangeroepen door pg_cron (x-cron-token, elke 10 min), door de sync-knop (trigger op app.sync_requests) of door de app.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info",
};
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const API = "https://connectapi.garmin.com";
const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const NATIVE: Record<string, string> = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent": "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9",
};

async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

async function isAuthorized(req: Request): Promise<boolean> {
  const cron = req.headers.get("x-cron-token");
  if (cron) {
    const expected = await rpc<string>("internal_get_secret", { p_name: "cron_token" });
    return !!expected && cron === expected;
  }
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return false;
  return await rpc<boolean>("internal_is_owner", { p_uid: data.user.id });
}

function jwtPayload(t: string): any {
  try { const p = t.split(".")[1]; return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - p.length % 4) % 4))); } catch { return {}; }
}

type Auth = { access_token: string | null; refresh_token: string; client_id: string; display_name: string | null };

async function loadAuth(): Promise<Auth> {
  const row = await rpc<Auth | null>("internal_garmin_auth_get");
  if (row?.refresh_token) return row;
  const seed = Deno.env.get("GARMIN_TOKENS");
  if (!seed) throw new Error("GARMIN_TOKENS ontbreekt (eerst tools/garmin_login.py)");
  const t = JSON.parse(seed.trim().startsWith("{") ? seed : atob(seed.trim()));
  const a: Auth = { access_token: t.di_token ?? null, refresh_token: t.di_refresh_token, client_id: t.di_client_id ?? jwtPayload(t.di_token ?? "").client_id, display_name: null };
  await rpc("internal_garmin_auth_save", { p: a });
  return a;
}

async function refresh(a: Auth): Promise<Auth> {
  const res = await fetch(DI_TOKEN_URL, {
    method: "POST",
    headers: { ...NATIVE, Authorization: "Basic " + btoa(`${a.client_id}:`), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: a.client_id, refresh_token: a.refresh_token }),
  });
  const txt = await res.text();
  if (!res.ok) {
    const e = new Error(`token refresh ${res.status}: ${txt.slice(0, 200)}`);
    (e as any).auth = res.status === 400 || res.status === 401;
    throw e;
  }
  const d = JSON.parse(txt);
  const n: Auth = { ...a, access_token: d.access_token, refresh_token: d.refresh_token ?? a.refresh_token, client_id: jwtPayload(d.access_token).client_id ?? a.client_id };
  await rpc("internal_garmin_auth_save", { p: n }); // meteen bewaren: de oude refresh-token is nu ongeldig
  return n;
}

async function session(): Promise<Auth> {
  let a = await loadAuth();
  const exp = a.access_token ? Number(jwtPayload(a.access_token).exp ?? 0) : 0;
  if (!a.access_token || Date.now() / 1000 > exp - 900) a = await refresh(a);
  return a;
}

async function get(a: Auth, path: string, params?: Record<string, string>): Promise<any> {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { ...NATIVE, Authorization: `Bearer ${a.access_token}`, Accept: "application/json" } });
  if (res.status === 204 || res.status === 404) return null;
  const txt = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${txt.slice(0, 160)}`);
  return txt ? JSON.parse(txt) : null;
}

const tz = "Europe/Brussels";
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: tz });
const minus = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
  if (!(await isAuthorized(req))) return json({ error: "unauthorized" }, 401);
  const errors: string[] = [];
  try {
    let a = await session();
    if (!a.display_name) {
      const prof = await get(a, "/userprofile-service/socialProfile");
      a = { ...a, display_name: prof?.displayName ?? null };
      await rpc("internal_garmin_auth_save", { p: a });
    }
    const dn = encodeURIComponent(a.display_name ?? "");
    const t = today(), y = minus(t, 1);
    const safe = async <T>(label: string, f: () => Promise<T>): Promise<T | null> => {
      try { return await f(); } catch (e) { errors.push(`${label}: ${(e as Error).message}`); return null; }
    };

    const summaries = (await Promise.all([y, t].map((d) => safe(`summary ${d}`, () => get(a, `/usersummary-service/usersummary/daily/${dn}`, { calendarDate: d }))))).filter(Boolean);
    const sleepRaw = (await Promise.all([y, t].map((d) => safe(`sleep ${d}`, () => get(a, `/wellness-service/wellness/dailySleepData/${dn}`, { date: d, nonSleepBufferMinutes: "60" }))))).filter(Boolean);
    const ready = await safe("readiness", () => get(a, `/metrics-service/metrics/trainingreadiness/${t}`));
    const acts = await safe("activities", () => get(a, "/activitylist-service/activities/search/activities", { startDate: minus(t, 2), endDate: t, start: "0", limit: "20" }));

    const sleep = sleepRaw.map((s: any) => {
      const d = s.dailySleepDTO ?? {};
      return {
        date: d.calendarDate, sleep_seconds: d.sleepTimeSeconds, deep_sleep_seconds: d.deepSleepSeconds,
        light_sleep_seconds: d.lightSleepSeconds, rem_sleep_seconds: d.remSleepSeconds, awake_seconds: d.awakeSleepSeconds,
        sleep_start: d.sleepStartTimestampGMT, sleep_end: d.sleepEndTimestampGMT,
        sleep_score: d.sleepScores?.overall?.value, avg_overnight_hrv: s.avgOvernightHrv ?? d.avgOvernightHrv,
      };
    }).filter((s: any) => s.date);
    const readiness = (Array.isArray(ready) ? ready : ready ? [ready] : [])
      .filter((r: any) => r?.score != null)
      .map((r: any) => ({ date: r.calendarDate ?? t, score: r.score }));
    const activities = (Array.isArray(acts) ? acts : []).map((x: any) => ({
      id: String(x.activityId), name: x.activityName, type: x.activityType?.typeKey, start_time: x.startTimeLocal,
      duration_seconds: x.duration, distance_meters: x.distance, calories: x.calories,
      avg_hr_bpm: x.averageHR, max_hr_bpm: x.maxHR, elevation_gain_meters: x.elevationGain,
    }));
    const bbNow = (summaries.find((s: any) => s?.calendarDate === t) as any)?.bodyBatteryMostRecentValue ?? null;

    const r = await rpc("internal_garmin_pull_ingest", {
      p_raw: { summaries, sleep, readiness, activities }, p_bb_now: bbNow, p_errors: errors,
    });
    return json({ ok: true, ...(r as object), errors });
  } catch (e) {
    const msg = (e as Error).message;
    await rpc("internal_garmin_pull_fail", { p_error: msg, p_auth: !!(e as any).auth }).catch(() => {});
    return json({ ok: false, error: msg, errors }, 500);
  }
});
