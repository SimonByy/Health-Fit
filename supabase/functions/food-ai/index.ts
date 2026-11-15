// Eten beschrijven of fotograferen (Premium). Gemini splitst de maaltijd in onderdelen met grammen.
// Komt een onderdeel overeen met een product uit je eigen lijst, dan gebruiken we die echte voedingswaarden;
// anders is het een schatting (zo gemarkeerd). Niets wordt gelogd: de app toont het voorstel en jij bevestigt.
import { createClient } from "npm:@supabase/supabase-js@2";
import { geminiLoop } from "./gemini.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const admin = createClient(URL_, SR, { auth: { persistSession: false } });
const asUser = (uid: string) => createClient(URL_, SR, { auth: { persistSession: false }, global: { headers: { "x-hh-user": uid } } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
async function call<T = any>(db: any, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}
const num = (v: unknown) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));

const SYS = `Je helpt in een voedingsapp een maaltijd te loggen. Je krijgt een beschrijving en/of een foto. Nederlands.
Splits de maaltijd in losse onderdelen (bv. "rijst", "kipfilet", "saus") met een realistische hoeveelheid in gram (of ml voor dranken; reken 1 ml = 1 g).
Staat een onderdeel in de lijst "mijn_producten", gebruik dan exact dat id (food_id) en laat per100 leeg: die waarden zijn echt.
Anders: geef per100 (kcal, eiwit, kh, vet per 100 g) volgens gangbare voedingstabellen (NEVO/USDA) voor het onbereide of bereide product zoals het gegeten wordt.
Hoeveelheden: neem wat de gebruiker zegt; anders schat je op basis van de foto (bord ± 26 cm, vork, verpakking) of een gewone portie.
Antwoord met ALLEEN JSON: {"items":[{"name":"...","grams":<getal>,"food_id":<id of null>,"per100":{"kcal":..,"eiwit":..,"kh":..,"vet":..} of null,"zeker":"hoog|midden|laag"}],
"opmerking":"<één zin: wat je aannam of niet zeker weet>"}
Is het geen eten, geef {"items":[],"opmerking":"<waarom>"}.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST" }, 405);
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet ingelogd" }, 401);
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user || !(await call<boolean>(admin, "internal_is_owner", { p_uid: u.user.id }))) return json({ error: "Geen toegang" }, 403);
  const uid = u.user.id, db = asUser(uid);
  if (!(await call<boolean>(db, "internal_is_premium"))) return json({ error: "Premium-functie" }, 403);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Ongeldige aanvraag" }, 400); }
  const text = String(body.text || "").slice(0, 1000).trim();
  const img = typeof body.image === "string" ? body.image.replace(/^data:image\/\w+;base64,/, "") : "";
  if (!text && !img) return json({ error: "Beschrijf je eten of voeg een foto toe" }, 400);
  if (img.length > 2_800_000) return json({ error: "Foto te groot" }, 413);
  const q = await call<any>(db, "internal_ai_take", { p_feature: "food_ai" }).catch(() => ({ ok: true }));
  if (!q?.ok) return json({ error: "Je limiet voor eten analyseren is voor vandaag op. Morgen kan het weer." }, 429);
  const legacy = (await call<string>(admin, "internal_legacy_user")) === uid;
  const key = (await call<string | null>(db, "internal_get_secret", { p_name: "gemini_api_key" })) || (legacy ? Deno.env.get("GEMINI_API_KEY") ?? "" : "");
  if (!key) return json({ error: "Stel eerst je Gemini-sleutel in bij Instellingen → AI-coach." }, 400);

  const mine = ((await call<any[]>(db, "get_foods", { p_query: null, p_limit: 150 }).catch(() => [])) || []).filter((f) => f.per100?.kcal != null);
  const foods = mine.map((f) => ({ id: f.id, naam: f.name, merk: f.brand || undefined, portie_g: f.serving_g || undefined }));
  const byId = new Map(mine.map((f) => [String(f.id), f]));
  const parts: any[] = [{ text: JSON.stringify({ beschrijving: text || null, maaltijd: body.meal || null, mijn_producten: foods }) }];
  if (img) parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
  try {
    const { text: out } = await geminiLoop({ apiKey: key, model: MODEL, system: SYS, tools: [], json: true, maxSteps: 2, run: async () => null,
      deadline: Date.now() + 55000, callTimeout: 45000, track: (m: string, l: boolean) => call(db, "internal_ai_usage_add", { p_model: m, p_limited: l }), userParts: parts });
    const r = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const items = (r.items || []).slice(0, 15).map((it: any) => {
      const g = Math.max(1, Math.min(2000, Math.round(num(it.grams) || 0)));
      const own = it.food_id != null ? byId.get(String(it.food_id)) : null;
      if (own) return { name: own.name, grams: g, food_id: own.id, per100: own.per100, source: "eigen", zeker: it.zeker || "midden" };
      const p = it.per100 || {};
      const per100 = { kcal: num(p.kcal), protein: num(p.eiwit), carbs: num(p.kh), fat: num(p.vet) };
      if (per100.kcal == null) return null;
      return { name: String(it.name || "Onderdeel").slice(0, 80), grams: g, food_id: null, per100, source: "schatting", zeker: it.zeker || "midden" };
    }).filter(Boolean);
    return json({ items, note: String(r.opmerking || "").slice(0, 300) });
  } catch (e) {
    return json({ error: "Analyseren lukte niet: " + (e instanceof Error ? e.message : String(e)).slice(0, 200) }, 502);
  }
});
