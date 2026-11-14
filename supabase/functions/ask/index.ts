// AI-assistent over je eigen data.
// Tools: run_sql (read-only, rol ai_reader op schema ai), routines beheren, metingen loggen.
// Modi: chat (ingelogde gebruiker) en weekly_review (pg_cron via notify, x-cron-token + user_id). Altijd per gebruiker.
import { createClient } from "npm:@supabase/supabase-js@2";
import { AsyncLocalStorage } from "node:async_hooks";
import { geminiLoop } from "./gemini.ts";
const ENV_GEMINI = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

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

// Elk verzoek draait voor één gebruiker: de databank leest die uit de header x-hh-user (alleen geldig met de service-sleutel).
type Ctx = { db: any; uid: string; key: string; name: string; legacy: boolean; goals: any };
const als = new AsyncLocalStorage<Ctx>();
const store = () => als.getStore();
const GEMINIK = () => store()?.key || "";
const N = () => store()?.name || "de gebruiker";
let LEGACY: string | null = null;
async function makeCtx(uid: string): Promise<Ctx> {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false }, global: { headers: { "x-hh-user": uid } } });
  const one = async (fn: string, args: any) => { const { data } = await db.rpc(fn, args); return data; };
  LEGACY ??= (await admin.rpc("internal_legacy_user")).data;
  const legacy = uid === LEGACY;
  const key = (await one("internal_get_secret", { p_name: "gemini_api_key" })) || (legacy ? ENV_GEMINI : "");
  const prof = await one("internal_agent_read", { q: "select display_name from app.profiles" });
  const goals = await one("internal_get_setting", { p_key: "goals" });
  return { db, uid, key, legacy, goals: goals || {}, name: legacy ? "Simon" : (prof?.[0]?.display_name || "de gebruiker") };
}
function goalLine() {
  const c = store(); const g = c?.goals || {};
  if (c?.legacy) return "- Doelen: 2000 kcal, 150 g eiwit, max 50 g vet; zone 2 = 138–152 bpm; halve marathon zomer 2027.";
  return `- Doelen (app.settings 'goals'): ${g.kcal_in ?? "?"} kcal, ${g.protein_g ?? "?"} g eiwit, max ${g.fat_g ?? "?"} g vet, ${g.steps ?? "?"} stappen.`;
}

async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (store()?.db ?? admin).rpc(fn, args);
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
    name: "app_read",
    description: "Eén read-only SELECT op de app-tabellen (schema app): menu (app.mp_weeks, app.mp_week_items, app.mp_recipes), boodschappen (app.store_products), coachplanning (app.coach_sessions), trainingsfeedback (app.coach_feedback), briefing (app.briefings), voedingslog (app.food_log), app.foods, app.settings (goals, mealprep). Max 200 rijen.",
    input_schema: { type: "object", properties: { query: { type: "string" }, purpose: { type: "string" } }, required: ["query"] },
  },
  {
    name: "app_write",
    description: "Eén INSERT of UPDATE om iets in de app te doen wat de gebruiker vraagt: menu aanpassen (app.mp_week_items: day, slot, recipe_id, portions), recept maken/aanpassen (app.mp_recipes), coachplanning (app.coach_sessions: status, note), of select public.log_food('{...}'::jsonb) / public.log_entry(metric, waarde, tijd) / public.save_food(...). Nooit DELETE. Alleen als hij het expliciet vraagt.",
    input_schema: { type: "object", properties: { statement: { type: "string" }, purpose: { type: "string" } }, required: ["statement"] },
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
    description: "Log een meting die de gebruiker vertelt: gewicht (kg), vetpercentage (%), water (mL), cafeïne (mg) of een lichaamsomtrek in cm (taille, borst, bovenarm, dij, heup). Alleen als hij dat expliciet zegt.",
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["weight_body_mass", "body_fat_percentage", "dietary_water", "dietary_caffeine", "waist_circumference", "chest_circumference", "arm_circumference", "thigh_circumference", "hip_circumference"] },
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
  return `Je bent de persoonlijke health- & fitness-analist in de app van ${N()}. Je antwoordt in het Nederlands, direct en beknopt.

Nu: ${today} (${iso}), ${time}, tijdzone Europe/Brussels.

DATABRONNEN: Garmin rechtstreeks (dagelijks gesynct: stappen, energie, rusthartslag, nachtelijke HRV, slaap met fasen, cardio-activiteiten, en herstel in ai.recovery_daily: slaapscore, Body Battery, stress, intensiteitsminuten), Apple Health (export, oudere historiek), voeding (via Apple Health en in de app gelogd per maaltijd: ai.daily_summary / ai.nutrition_by_meal), zelf gelogd water/cafeïne/gewicht/lichaamsmaten (ai.body_measurements), krachttraining per set (Hevy-import en in de app gelogd: ai.strength_sets, ai.muscle_sets_weekly), gewichtstrend en echt onderhoud (ai.weight_trend, ai.energy_balance), gewoontes/supplementen (ai.habits_daily) en zijn dagboek (ai.journal).

WERKWIJZE
- Gebruik run_sql om echte cijfers op te halen voor je antwoordt. Verzin nooit getallen.
- Begin voor algemene vragen bij ai.daily_summary. Combineer views waar nodig.
- Houd queries efficiënt: filter op day, aggregeer, gebruik limit.
- Ontbreekt data, zeg dat eerlijk en vermeld welke.
- Geef concrete getallen met eenheid; vergelijk met gemiddelde of trend als dat helpt.
- Correlatie is geen oorzaak; wees eerlijk over onzekerheid bij weinig datapunten.
- Je bent geen arts: bij medisch klinkende vragen geef je de data en raad je een professional aan.
- Gewicht: gebruik trend_kg (ai.weight_trend) voor veranderingen, niet losse wegingen. Vragen over onderhoud/TDEE/hoeveel eten: ai.energy_balance.
- Routines: vraagt ${N()} om een herinnering/melding, maak die met create_routine en bevestig dag(en) en uur. Wijzigen/stoppen via list_routines + update_routine.
- Je bent ook zijn coach in de app: menu, recepten, boodschappen, trainingsplanning en feedback lees je met app_read; wijzigen doe je met app_write, maar alleen wat hij expliciet vraagt. Menu-regels: hele porties voor pudding/eiwitreep/Upfront (portion_step), dagdoel rond het kcal-doel en minstens het eiwitdoel, nooit verwijderen, geen verzonnen voedingswaarden. Lees app.settings 'mealprep' voor menuwijzigingen.
${goalLine()}
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
      const { data, error } = await (store()?.db ?? admin).rpc("ai_run_query", { q: String(input?.query ?? "") });
      if (error) throw new Error(`SQL-fout: ${error.message}`);
      return data;
    }
    case "app_read":
      return await rpc("internal_agent_read", { q: String(input?.query ?? "") });
    case "app_write":
      return await rpc("internal_agent_write", { q: String(input?.statement ?? "") });
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

// Gemini (gratis laag) als die sleutel er is; anders Claude
async function converseGemini(schema: string, messages: any[]) {
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1).filter((m) => typeof m.content === "string")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const { text, actions } = await geminiLoop({ apiKey: GEMINIK(), model: GEMINI_MODEL, system: systemPrompt(schema), tools,
    track: (m: string, l: boolean) => rpc("internal_ai_usage_add", { p_model: m, p_limited: l }),
    run: (n, a) => runTool(n, a), userParts: [{ text: String(last.content) }], history });
  return { answer: text, actions };
}

async function converse(apiKey: string, model: string, schema: string, messages: any[]) {
  let fallback = false;
  if (GEMINIK()) {
    try { return await converseGemini(schema, messages); }
    catch (e) {
      // Alle Gemini-modellen op of overbelast: terugvallen op Claude als er een sleutel is
      console.log("Gemini faalde, terugval op Claude:", e instanceof Error ? e.message : String(e));
      apiKey = (await rpc<string | null>("internal_get_secret", { p_name: "anthropic_api_key" }).catch(() => null)) || "";
      if (!apiKey) throw new Error("Gemini is even overbelast of je dagquotum is op. Probeer het later opnieuw.");
      model = ((await rpc<string | null>("internal_get_setting", { p_key: "ai_model" }).catch(() => null)) as string) || "claude-sonnet-5-5";
      messages.splice(0, messages.length, ...messages.filter((m) => typeof m.content === "string"));
      fallback = true;
    }
  }
  const actions: { tool: string; purpose?: string; rows?: number; error?: string; summary?: string }[] = [];
  for (let step = 0; step < 10; step++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 2000, system: systemPrompt(schema), tools: TOOLS, messages }),
    });
    if (!res.ok) {
      const why = (await res.text()).slice(0, 300);
      if (fallback) { console.log("Claude-terugval faalde:", res.status, why); throw new Error("Gemini is even overbelast of je dagquotum is op. Probeer het later opnieuw."); }
      throw new Error(`Claude API ${res.status}: ${why}`);
    }
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

  let body: { message?: string; conversation_id?: string; mode?: string; meal?: string; day?: string };
  try { body = await req.json(); } catch { return json({ error: "Ongeldige body" }, 400); }

  // --- auth ---
  const cron = req.headers.get("x-cron-token");
  let isCron = false;
  let uid = "";
  if (cron) {
    const expected = await rpc<string>("internal_get_secret", { p_name: "cron_token" });
    if (!expected || cron !== expected) return json({ error: "Geen toegang" }, 401);
    isCron = true;
    uid = String((body as any).user_id ?? "") || ((await admin.rpc("internal_legacy_user")).data as string);
  } else {
    const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Niet ingelogd" }, 401);
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u.user) return json({ error: "Niet ingelogd" }, 401);
    if (!(await rpc<boolean>("internal_is_owner", { p_uid: u.user.id }))) return json({ error: "Geen toegang" }, 403);
    uid = u.user.id;
  }
  return await als.run(await makeCtx(uid), () => handle(body, isCron));
});

async function handle(body: any, isCron: boolean): Promise<Response> {
  if (!GEMINIK() && !(await rpc<string | null>("internal_get_secret", { p_name: "anthropic_api_key" }).catch(() => null)))
    return json({ error: "Vul eerst je eigen gratis Gemini-sleutel in bij Instellingen (aistudio.google.com/apikey)." }, 400);

  const apiKey = GEMINIK() ? "" : await rpc<string | null>("internal_get_secret", { p_name: "anthropic_api_key" });
  if (!GEMINIK() && !apiKey) return json({ error: "Geen AI-sleutel ingesteld" }, 400);
  const model = GEMINIK() ? GEMINI_MODEL : ((await rpc<string | null>("internal_get_setting", { p_key: "ai_model" })) as string) || "claude-sonnet-5-5";
  const schema = await rpc<string>("ai_schema_doc");

  // --- "Wat past erbij?": één snelle Gemini-oproep, kiest uit zijn eigen producten (echte waarden) ---
  if (body.mode === "pair") {
    if (!GEMINIK()) return json({ error: "Geen AI-sleutel" }, 400);
    const b: any = body;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day ?? "") ? b.day : new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });
    const meal = String(b.meal ?? "Avondeten").slice(0, 20).replace(/'/g, "");
    const ctx = await rpc<any>("internal_agent_read", { q: `select
      (select jsonb_agg(jsonb_build_object('naam', name, 'gram', grams, 'kcal', kcal, 'p', protein)) from app.food_log where day = '${day}' and meal = '${meal}' and not voided and not coalesce(skipped, false)) as maaltijd,
      (select jsonb_build_object('kcal', round(sum(kcal)), 'p', round(sum(protein)), 'c', round(sum(carbs)), 'f', round(sum(fat))) from app.food_log where day = '${day}' and not voided and not coalesce(skipped, false)) as vandaag,
      (select value from app.settings where key = 'goals') as doelen,
      (select jsonb_agg(jsonb_build_object('id', id, 'naam', name, 'merk', brand, 'per100', per100, 'portie_g', serving_g) order by use_count desc nulls last)
         from (select * from app.foods where not coalesce(archived, false) and recipe is null and per100 ? 'kcal' order by use_count desc nulls last limit 80) f) as producten` });
    const c = ctx?.[0] ?? {};
    if (!c.maaltijd) return json({ ideas: [] });
    const sys = `Je stelt voor wat lekker past bij een maaltijd van ${N()} (fitness, ${meal.toLowerCase()}). Kies ALLEEN uit de lijst 'producten' (gebruik hun id), 2 of 3 ideeën die smaakmatig echt passen bij wat hij al heeft (bv. bij scampi: rijst of pasta, groenten, een saus), met een realistische hoeveelheid in gram die in zijn resterende budget past (doelen min vandaag). Antwoord met ALLEEN JSON: {"ideas":[{"id":"<uuid uit de lijst>","gram":<getal>,"waarom":"<max 6 woorden>"}]}`;
    try {
      const { text } = await geminiLoop({ apiKey: GEMINIK(), model: GEMINI_MODEL, system: sys, tools: [], json: true, maxSteps: 2,
        deadline: Date.now() + 40000, run: async () => null,
        track: (m: string, l: boolean) => rpc("internal_ai_usage_add", { p_model: m, p_limited: l }),
        userParts: [{ text: JSON.stringify(c).slice(0, 25000) }] });
      const out = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      const byId = new Map((c.producten ?? []).map((f: any) => [f.id, f]));
      const ideas = (out.ideas ?? []).map((i: any) => {
        const f: any = byId.get(i.id); const g = Math.max(5, Math.min(600, Math.round(Number(i.gram) || f?.portie_g || 100)));
        if (!f) return null;
        const v = (k: string) => Math.round(((Number(f.per100?.[k]) || 0) * g) / 10) / 10;
        return { food_id: f.id, name: f.naam, grams: g, kcal: Math.round((Number(f.per100?.kcal) || 0) * g / 100), protein: v("protein"), carbs: v("carbs"), fat: v("fat"), why: String(i.waarom ?? "").slice(0, 60) };
      }).filter(Boolean).slice(0, 3);
      return json({ ideas });
    } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
  }

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
}
