// Rusttimer tussen sets: stuurt een pushmelding als de rust voorbij is,
// ook als de app op de achtergrond staat. Werkt in "hops" van ±110 s
// (limiet van edge functions) en roept zichzelf opnieuw aan voor langere rusttijden.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

let appServer: webpush.ApplicationServer | null = null;
async function pushAll(payload: Record<string, unknown>) {
  if (!appServer) {
    const keys = await webpush.importVapidKeys(JSON.parse(await rpc<string>("internal_get_secret", { p_name: "vapid_keys" })), { extractable: false });
    appServer = await webpush.ApplicationServer.new({ contactInformation: "mailto:noreply@health-hub.app", vapidKeys: keys });
  }
  const subs = await rpc<any[]>("internal_push_targets");
  for (const s of subs) {
    try {
      await appServer.subscribe(s).pushTextMessage(JSON.stringify(payload), { ttl: 120, urgency: webpush.Urgency.High });
      await rpc("internal_push_result", { p_endpoint: s.endpoint, p_ok: true, p_gone: false, p_error: null });
    } catch (e) {
      const gone = e instanceof webpush.PushMessageError && (e.isGone() || e.response?.status === 404);
      await rpc("internal_push_result", { p_endpoint: s.endpoint, p_ok: false, p_gone: gone, p_error: String(e).slice(0, 300) });
    }
  }
}

async function run(id: string, cronToken: string) {
  const t0 = Date.now();
  for (;;) {
    const t = await rpc<any>("internal_timer_get", { p_id: id });
    if (!t || t.state !== "active") return;
    const rem = Date.parse(t.due_at) - Date.now();
    if (rem <= 300) {
      await rpc("internal_timer_mark", { p_id: id, p_state: "sent" });
      await pushAll({ title: t.title, body: t.body || "", url: "/#/workout", tag: "rest-timer" });
      return;
    }
    if (Date.now() - t0 > 110_000) {
      // volgende hop
      await fetch(`${SUPABASE_URL}/functions/v1/rest-timer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-token": cronToken },
        body: JSON.stringify({ action: "resume", id }),
      });
      return;
    }
    await sleep(Math.min(rem - 150, 4000));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {};
  try { body = await req.json(); } catch { /* leeg */ }
  const cronToken = await rpc<string>("internal_get_secret", { p_name: "cron_token" });

  if (body.action === "resume") {
    if (req.headers.get("x-cron-token") !== cronToken) return json({ error: "Geen toegang" }, 401);
    EdgeRuntime.waitUntil(run(body.id, cronToken).catch((e) => console.error(e)));
    return json({ ok: true });
  }

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const { data } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
  if (!data.user || !(await rpc<boolean>("internal_is_owner", { p_uid: data.user.id }))) return json({ error: "Geen toegang" }, 401);

  if (body.action === "start") {
    const secs = Math.round(Number(body.seconds) || 90);
    const t = await rpc<any>("internal_timer_start", {
      p_seconds: secs, p_title: String(body.title || "Rust voorbij"), p_body: body.body ? String(body.body) : null,
    });
    EdgeRuntime.waitUntil(run(t.id, cronToken).catch((e) => console.error(e)));
    return json(t);
  }
  return json({ error: "Onbekende actie" }, 400);
});
