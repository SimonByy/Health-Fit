// Verstuurt pushmeldingen voor routines (elke 5 min aangeroepen door pg_cron).
// - kind 'notify'        : gewone melding (bv. "Log je gewicht")
// - kind 'weekly_review' : laat de AI een weekoverzicht maken en meldt dat het klaarstaat
// Ook: POST {"test": true} door de ingelogde eigenaar = testmelding.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

let appServer: webpush.ApplicationServer | null = null;
async function server() {
  if (appServer) return appServer;
  const raw = await rpc<string>("internal_get_secret", { p_name: "vapid_keys" });
  const keys = await webpush.importVapidKeys(JSON.parse(raw), { extractable: false });
  appServer = await webpush.ApplicationServer.new({ contactInformation: "mailto:noreply@health-hub.app", vapidKeys: keys });
  return appServer;
}

async function pushAll(payload: { title: string; body?: string; url?: string; tag?: string }) {
  const subs = await rpc<any[]>("internal_push_targets");
  const srv = await server();
  let sent = 0;
  for (const s of subs) {
    try {
      await srv.subscribe(s).pushTextMessage(JSON.stringify(payload), { ttl: 6 * 3600 });
      await rpc("internal_push_result", { p_endpoint: s.endpoint, p_ok: true, p_gone: false, p_error: null });
      sent++;
    } catch (e) {
      const gone = e instanceof webpush.PushMessageError && (e.isGone() || e.response?.status === 404);
      await rpc("internal_push_result", { p_endpoint: s.endpoint, p_ok: false, p_gone: gone, p_error: String(e).slice(0, 300) });
    }
  }
  return { sent, targets: subs.length };
}

async function weeklyReview(cronToken: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-token": cronToken },
    body: JSON.stringify({ mode: "weekly_review" }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `ask ${res.status}`);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const cronToken = await rpc<string>("internal_get_secret", { p_name: "cron_token" });
  const headerToken = req.headers.get("x-cron-token");
  let body: any = {};
  try { body = await req.json(); } catch { /* leeg */ }

  // testmelding door de eigenaar
  if (!headerToken) {
    const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const { data } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
    if (!data.user || !(await rpc<boolean>("internal_is_owner", { p_uid: data.user.id }))) return json({ error: "Geen toegang" }, 401);
    if (!body.test) return json({ error: "Onbekende actie" }, 400);
    try {
      return json({ ok: true, ...(await pushAll({ title: "Health Hub", body: "Meldingen werken 👍", url: "/#/vandaag", tag: "test" })) });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }
  if (headerToken !== cronToken) return json({ error: "Geen toegang" }, 401);

  const due = await rpc<any[]>("internal_claim_due_routines");
  const results = [];
  for (const r of due) {
    try {
      if (r.kind === "weekly_review") {
        await weeklyReview(cronToken);
        results.push({ id: r.id, ...(await pushAll({ title: r.title, body: r.body || "Je weekoverzicht staat klaar", url: "/#/vandaag", tag: "review" })) });
      } else {
        results.push({ id: r.id, ...(await pushAll({ title: r.title, body: r.body || "", url: r.url, tag: r.id })) });
      }
    } catch (e) {
      results.push({ id: r.id, error: String(e).slice(0, 300) });
    }
  }
  return json({ ok: true, due: due.length, results });
});
