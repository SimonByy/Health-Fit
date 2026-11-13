// garmin-pull: haalt Garmin-data op via de athletedata MCP-server (officiële Garmin-koppeling bij athletedata).
// Secret: ATHLETEDATA_MCP_URL (door Simon zelf gezet). Aangeroepen door pg_cron (x-cron-token), door de sync-knop
// (trigger op app.sync_requests) of door de app (ingelogde eigenaar).
//   ?mode=discover  -> tools/list opslaan in app.settings 'athletedata_tools' (nodig om de mapping te schrijven)
//   (standaard)     -> de tools uit app.settings 'athletedata_pull' oproepen, ruwe antwoorden opslaan,
//                      bij wijziging health.ingest_garmin_raw via internal_athletedata_ingest
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info",
};
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MCP_URL = Deno.env.get("ATHLETEDATA_MCP_URL") ?? "";

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

// ---- minimale MCP-client (streamable HTTP, JSON of SSE) ----
class Mcp {
  session = "";
  n = 0;
  async send(method: string, params?: unknown, notify = false) {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    if (!notify) body.id = ++this.n;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };
    if (this.session) headers["mcp-session-id"] = this.session;
    const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (notify) { await res.body?.cancel(); return null; }
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${method} ${res.status}: ${text.slice(0, 300)}`);
    let msg: any = null;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try { const m = JSON.parse(line.slice(5).trim()); if (m.id === body.id) msg = m; } catch { /* skip */ }
      }
    } else msg = JSON.parse(text);
    if (!msg) throw new Error(`MCP ${method}: leeg antwoord`);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  }
  async init() {
    await this.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health-hub", version: "1.0" } });
    await this.send("notifications/initialized", undefined, true);
  }
  async listTools() {
    const out: any[] = []; let cursor: string | undefined;
    do {
      const r = await this.send("tools/list", cursor ? { cursor } : {});
      out.push(...(r.tools ?? [])); cursor = r.nextCursor;
    } while (cursor);
    return out;
  }
  async call(name: string, args: Record<string, unknown>) {
    const r = await this.send("tools/call", { name, arguments: args });
    if (r.structuredContent) return r.structuredContent;
    const txt = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    try { return JSON.parse(txt); } catch { return { text: txt, isError: !!r.isError }; }
  }
}

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });
const minus = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
// placeholders in de mapping: {today}, {yesterday}, {days_ago_7}
function fill(v: unknown): unknown {
  if (typeof v === "string") {
    const t = today();
    return v.replace("{today}", t).replace("{yesterday}", minus(t, 1)).replace(/\{days_ago_(\d+)\}/, (_, n) => minus(t, +n));
  }
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
  try {
    if (!(await isAuthorized(req))) return json({ error: "unauthorized" }, 401);
    if (!MCP_URL) return json({ error: "ATHLETEDATA_MCP_URL ontbreekt" }, 500);
    const mode = new URL(req.url).searchParams.get("mode") ?? "pull";
    const mcp = new Mcp();
    await mcp.init();

    if (mode === "discover") {
      const tools = await mcp.listTools();
      await rpc("internal_athletedata_set", { p_key: "athletedata_tools", p_value: tools });
      return json({ ok: true, tools: tools.map((t) => t.name) });
    }

    const plan = await rpc<any[]>("internal_athletedata_get", { p_key: "athletedata_pull" });
    if (!Array.isArray(plan) || !plan.length) return json({ ok: false, error: "geen mapping (athletedata_pull) — eerst ?mode=discover" });
    const results: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const step of plan) {
      try {
        const out = await mcp.call(step.tool, fill(step.args ?? {}) as Record<string, unknown>);
        results[step.as ?? step.tool] = out;
      } catch (e) { errors.push(`${step.tool}: ${(e as Error).message}`); }
    }
    const r = await rpc("internal_athletedata_ingest", { p_raw: results, p_errors: errors });
    return json({ ok: true, ...(r as object), errors });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
