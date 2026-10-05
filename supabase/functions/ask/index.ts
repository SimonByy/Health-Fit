// AI-assistent over je eigen data.
// Tools: run_sql (read-only, rol ai_reader op schema ai), routines beheren, metingen loggen.
// Modi: chat (ingelogde eigenaar) en weekly_review (pg_cron via notify, x-cron-token).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info",
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

const DAYS = "days: lijst van weekdagen als getallen, 1=maandag … 7=zondag";
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
  {
    name: "create_routine",
    description:
      "Maak een terugkerende pushmelding (routine) aan, bv. elke maandag 08:00 'Log je gewicht'. " +
      "Gebruik url '/#/log/gewicht' voor gewicht loggen, '/#/dagboek' voor het dagboek, '/#/vandaag' als standaard. " +
      "kind 'weekly_review' = AI-weekoverzicht maken en melden.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Titel van de melding, kort (bv. 'Log je gewicht')." },
        body: { type: "string", description: "Tekst onder de titel." },
        days: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 }, description: DAYS },
        time: { type: "string", description: "Tijdstip HH:MM (Belgische tijd)." },
        url: { type: "string", description: "Scherm dat opent bij tikken." },
        kind: { type: "string", enum: ["notify", "weekly_review"] },
      },
      required: ["title", "days", "time"],
    },
  },
  {
    name: "list_routines",
    description: "Toon alle bestaande routines (meldingen) met id, titel, dagen, tijd en of ze actief zijn.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_routine",
    description: "Wijzig, pauzeer (active=false) of verwijder (archived=true) een bestaande routine. Haal eerst het id op via list_routines.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        days: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 }, description: DAYS },
        time: { type: "string", description: "HH:MM" },
        url: { type: "string" },
        active: { type: "boolean" },
        archived: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "log_measurement",
    description: "Log een meting die Simon vertelt: gewicht (kg), vetpercentage (%), water (mL) of cafeïne (mg). Alleen als hij dat expliciet zegt.",
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["weight_body_mass", "body_fat_percentage", "dietary_water", "dietary_caffeine"] },
        value: { type: "number" },
        timestamp: { type: "string", description: "Optioneel ISO-tijdstip; standaard nu." },
      },
      required: ["metric", "value"],
    },
  },
];

function systemPrompt(schema: string) {
  const now = new Date();
  const today = now.toLocaleDateString("nl-BE", { timeZone: "Europe/Brussels", weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = now.toLocaleTimeString("nl-BE", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit" });
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(now);
  return `Je bent de persoonlijke health- & fitness-analist in Simon's eigen app. Je antwoordt in het Nederlands, direct en beknopt.

Nu: ${today} (${iso}), ${time}, tijdzone Europe/Brussels.

DATABRONNEN: Apple Health (inclusief data van zijn wearable, nu een Garmin: stappen, hartslag, HRV, slaap, workouts), voeding via Apple Health (alleen calorieën en macro's), zelf gelogd water/cafeïne/gewicht, Hevy-krachttraining (per set, indien geïmporteerd) en zijn dagboek (ai.journal).

WERKWIJZE
- Gebruik run_sql om echte cijfers op te halen voor je antwoordt. Verzin nooit getallen.
- Begin voor algemene vragen bij ai.daily_summary. Combineer views waar nodig.
- Houd queries efficiënt: filter op day, aggregeer, gebruik limit.
- Ontbreekt data, zeg dat eerlijk en vermeld welke.
- Geef concrete getallen met eenheid; vergelijk met gemiddelde of trend als dat helpt.
- Correlatie is geen oorzaak; wees eerlijk over onzekerheid bij weinig datapunten.
- Je bent geen arts: bij medisch klinkende vragen geef je de data en raad je een professional aan.
- Routines: vraagt Simon om een herinnering/melding, maak die met create_routine en bevestig dag(en) en uur. Wijzigen/stoppen via list_routines + update_routine.
- Opmaak: korte alinea's of een kleine lijst/tabel in Markdown. Geen SQL tonen tenzij gevraagd.

BESCHIKBARE VIEWS (schema ai):
${schema}`;
}

const REVIEW_PROMPT = `Maak mijn weekoverzicht van de afgelopen week (maandag t.e.m. zondag, de volledige week vóór vandaag).
Vergelijk met de week daarvoor. Structuur (Markdown, max. ~220 woorden):
**Wat ging goed** (2-4 punten), **Wat kan beter** (2-4 punten), **Opvallende veranderingen** (slaap, rusthartslag, HRV, gewicht, stappen, voeding, water, training — alleen wat echt verschilt, met cijfers), en eindig met **Focus deze week**: één concreet, haalbaar voornemen.
Gebruik ook het dagboek als er iets in staat. Ontbreekt data, vermeld dat kort.`;

async function runTool(name: string, input: any) {
  switch (name) {
    case "run_sql": {
      const { data, error } = await admin.rpc("ai_run_query", { q: String(input?.query ?? "") });
      if (error) throw new Error(`SQL-fout: ${error.message}`);
      return data;
    }
    case "create_routine":
      return await rpc("internal_save_routine", { p: { ...input, id: undefined } });
    case "list_routines":
      return await rpc("internal_list_routines");
    case "update_routine":
      return await rpc("internal_save_routine", { p: input });
    case "log_measurement":
      return await rpc("internal_log_entry", { p_metric: input.metric, p_value: input.value, p_ts: input.timestamp ?? null });
    default:
      throw new Error(`Onbekende tool ${name}`);
  }
}

async function converse(apiKey: string, model: string, schema: string, messages: any[]) {
  const actions: { tool: string; purpose?: string; rows?: number; error?: string; summary?: string }[] = [];
  for (let step = 0; step < 10; step++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 2000, system: systemPrompt(schema), tools: TOOLS, messages }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const out = await res.json();
    messages.push({ role: "assistant", content: out.content });
    const uses = (out.content ?? []).filter((b: any) => b.type === "tool_use");
    if (out.stop_reason !== "tool_use" || !uses.length) {
      const text = (out.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return { answer: text, actions };
    }
    const results = [];
    for (const tu of uses) {
      try {
        const data = await runTool(tu.name, tu.input);
        const rows = Array.isArray(data) ? data.length : undefined;
        actions.push({
          tool: tu.name,
          purpose: tu.input?.purpose,
          rows,
          summary: tu.name === "create_routine" || tu.name === "update_routine"
            ? `Routine: ${(data as any)?.title} (${(data as any)?.time_local?.slice(0, 5)})`
            : tu.name === "log_measurement" ? `Gelogd: ${tu.input.value} ${(data as any)?.unit ?? ""}` : undefined,
        });
        let text = JSON.stringify(data);
        if (text.length > 30000) text = text.slice(0, 30000) + "…(afgekapt, aggregeer verder)";
        results.push({ type: "tool_result", tool_use_id: tu.id, content: text });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        actions.push({ tool: tu.name, purpose: tu.input?.purpose, error: msg });
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: msg });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { answer: "Ik kon geen volledig antwoord vormen binnen het maximum aantal stappen. Probeer je vraag specifieker te maken.", actions };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Gebruik POST" }, 405);

  let body: { message?: string; conversation_id?: string; mode?: string };
  try { body = await req.json(); } catch { return json({ error: "Ongeldige body" }, 400); }

  // --- auth ---
  const cron = req.headers.get("x-cron-token");
  let isCron = false;
  if (cron) {
    const expected = await rpc<string>("internal_get_secret", { p_name: "cron_token" });
    if (!expected || cron !== expected) return json({ error: "Geen toegang" }, 401);
    isCron = true;
  } else {
    const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Niet ingelogd" }, 401);
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u.user) return json({ error: "Niet ingelogd" }, 401);
    if (!(await rpc<boolean>("internal_is_owner", { p_uid: u.user.id }))) return json({ error: "Geen toegang" }, 403);
  }

  const apiKey = await rpc<string | null>("internal_get_secret", { p_name: "anthropic_api_key" });
  if (!apiKey) return json({ error: "Geen Claude API-key ingesteld (Instellingen in de app)" }, 400);
  const model = ((await rpc<string | null>("internal_get_setting", { p_key: "ai_model" })) as string) || "claude-sonnet-5-5";
  const schema = await rpc<string>("ai_schema_doc");

  // --- weekoverzicht ---
  if (body.mode === "weekly_review") {
    try {
      const { answer, actions } = await converse(apiKey, model, schema, [{ role: "user", content: REVIEW_PROMPT }]);
      const id = await rpc<number>("internal_add_insight", { p_kind: "weekly_review", p_title: "Weekoverzicht", p_content: answer });
      return json({ ok: true, id, answer, actions });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }
  if (isCron) return json({ error: "Onbekende modus" }, 400);

  // --- chat ---
  const message = (body.message ?? "").trim();
  if (!message) return json({ error: "Lege vraag" }, 400);
  const conversationId = body.conversation_id || crypto.randomUUID();
  const history = await rpc<{ role: string; content: string }[]>("internal_chat_history", { p_conversation: conversationId, p_limit: 16 });
  const messages: any[] = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: message }];

  let result;
  try {
    result = await converse(apiKey, model, schema, messages);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }

  await rpc("internal_chat_add", { p_conversation: conversationId, p_role: "user", p_content: message, p_meta: null });
  await rpc("internal_chat_add", {
    p_conversation: conversationId, p_role: "assistant", p_content: result.answer, p_meta: { queries: result.actions, model },
  });
  return json({ conversation_id: conversationId, answer: result.answer, queries: result.actions });
});
