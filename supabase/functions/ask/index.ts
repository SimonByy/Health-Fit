// AI-assistent over je eigen data. Claude krijgt één tool (run_sql) die enkel
// SELECT-queries uitvoert als de read-only rol `ai_reader` op het schema `ai`.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const TOOLS = [
  {
    name: "run_sql",
    description:
      "Voer één read-only PostgreSQL SELECT-query uit op de views in schema `ai` (gebruik ai.<view> of gewoon <view>). " +
      "Geeft maximaal 300 rijen als JSON terug. Gebruik aggregaties (avg, sum, count, date_trunc) om resultaten klein te houden. " +
      "Regels: geen puntkomma, geen dubbele aanhalingstekens (gebruik aliassen zonder quotes), geen andere schema's dan ai.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Eén SELECT- of WITH-query, zonder puntkomma." },
        purpose: { type: "string", description: "Korte uitleg in het Nederlands wat je opzoekt." },
      },
      required: ["query"],
    },
  },
];

function systemPrompt(schema: string) {
  const now = new Date();
  const today = now.toLocaleDateString("nl-BE", { timeZone: "Europe/Brussels", weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(now);
  return `Je bent de persoonlijke health- & fitness-analist in Simon's eigen app. Je antwoordt in het Nederlands, direct en beknopt.

Vandaag is ${today} (${iso}), tijdzone Europe/Brussels.

DATABRONNEN: Apple Health (inclusief data die Garmin daarheen synct: stappen, hartslag, HRV, slaap, workouts), Apple Health-voeding (calorieën, macro's en micro's) en Hevy (krachttraining per set).

WERKWIJZE
- Gebruik altijd de tool run_sql om echte cijfers op te halen voor je antwoordt. Verzin nooit getallen.
- Begin voor algemene vragen bij ai.daily_summary. Combineer views waar nodig (bv. slaap vs. trainingsvolume).
- Houd queries efficiënt: filter op day, aggregeer, gebruik limit.
- Zegt een query niets op (lege data), zeg dat eerlijk en vermeld welke data ontbreekt.
- Geef concrete getallen met eenheid, en vergelijk met het gemiddelde of de trend als dat helpt.
- Correlatie is geen oorzaak: wees eerlijk over onzekerheid bij weinig datapunten.
- Je bent geen arts: bij medisch klinkende vragen geef je de data, en raad je aan een professional te raadplegen.
- Opmaak: korte alinea's of een kleine lijst/tabel in Markdown. Geen SQL tonen tenzij gevraagd.

BESCHIKBARE VIEWS (schema ai):
${schema}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Gebruik POST" }, 405);

  // --- auth: ingelogde eigenaar ---
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet ingelogd" }, 401);
  const { data: u, error: ue } = await admin.auth.getUser(jwt);
  if (ue || !u.user) return json({ error: "Niet ingelogd" }, 401);
  if (!(await rpc<boolean>("internal_is_owner", { p_uid: u.user.id }))) return json({ error: "Geen toegang" }, 403);

  let body: { message?: string; conversation_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Ongeldige body" }, 400);
  }
  const message = (body.message ?? "").trim();
  if (!message) return json({ error: "Lege vraag" }, 400);
  const conversationId = body.conversation_id || crypto.randomUUID();

  const apiKey = await rpc<string | null>("internal_get_secret", { p_name: "anthropic_api_key" });
  if (!apiKey) return json({ error: "Geen Claude API-key ingesteld (Instellingen in de app)" }, 400);
  const model = ((await rpc<string | null>("internal_get_setting", { p_key: "ai_model" })) as string) || "claude-sonnet-5-5";
  const schema = await rpc<string>("ai_schema_doc");

  const history = await rpc<{ role: string; content: string }[]>("internal_chat_history", {
    p_conversation: conversationId,
    p_limit: 16,
  });

  const messages: any[] = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: message }];
  const queries: { purpose?: string; query: string; rows?: number; error?: string }[] = [];
  let answer = "";

  try {
    for (let step = 0; step < 10; step++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, max_tokens: 2000, system: systemPrompt(schema), tools: TOOLS, messages }),
      });
      if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const out = await res.json();
      messages.push({ role: "assistant", content: out.content });

      const toolUses = (out.content ?? []).filter((b: any) => b.type === "tool_use");
      if (out.stop_reason !== "tool_use" || !toolUses.length) {
        answer = (out.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
        break;
      }

      const results = [];
      for (const tu of toolUses) {
        const q = String(tu.input?.query ?? "");
        const { data, error } = await admin.rpc("ai_run_query", { q });
        if (error) {
          queries.push({ purpose: tu.input?.purpose, query: q, error: error.message });
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `SQL-fout: ${error.message}` });
        } else {
          const rows = Array.isArray(data) ? data.length : 0;
          queries.push({ purpose: tu.input?.purpose, query: q, rows });
          let text = JSON.stringify(data);
          if (text.length > 30000) text = text.slice(0, 30000) + "…(afgekapt, aggregeer verder)";
          results.push({ type: "tool_result", tool_use_id: tu.id, content: text });
        }
      }
      messages.push({ role: "user", content: results });
    }
    if (!answer) answer = "Ik kon geen volledig antwoord vormen binnen het maximum aantal stappen. Probeer je vraag specifieker te maken.";
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }

  await rpc("internal_chat_add", { p_conversation: conversationId, p_role: "user", p_content: message, p_meta: null });
  await rpc("internal_chat_add", {
    p_conversation: conversationId, p_role: "assistant", p_content: answer, p_meta: { queries, model },
  });

  return json({ conversation_id: conversationId, answer, queries });
});
