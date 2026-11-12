// Recept herkennen voor de mealprep: uit een foto (gerecht, receptkaart, screenshot),
// een link naar een receptensite of geplakte tekst. Geeft een recept per portie terug
// dat de app eerst toont; opslaan gebeurt pas als Simon bevestigt (RPC mp_save_recipe).
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

const DEPTS = ["Groenten & fruit", "Vlees & vis", "Zuivel & eieren", "Brood & wraps", "Houdbaar", "Ontbijt & sport", "Diepvries", "Overig"];
const TOOL = {
  name: "recipe",
  description: "Het recept, omgerekend naar één portie.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Korte Nederlandse naam van het gerecht." },
      meal_type: { type: "string", enum: ["ontbijt", "lunch", "snack", "avond"] },
      servings: { type: "integer", minimum: 1, maximum: 12, description: "Voor hoeveel porties je normaal kookt (bij mealprep meestal 2 of 3)." },
      ingredients: {
        type: "array",
        description: "Ingrediënten voor ÉÉN portie, in gram of ml waar dat kan.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Productnaam zoals bij Albert Heijn België, bv. 'Kipfilet', 'Basmatirijst (droog)'." },
            amount: { type: ["number", "null"], description: "Hoeveelheid per portie; null bij 'naar smaak'." },
            unit: { type: ["string", "null"], enum: ["g", "ml", "stuk", "teen", "el", "tl", null] },
            dept: { type: "string", enum: DEPTS },
            pantry: { type: "boolean", description: "true voor kruiden, olie, sauzen in kleine hoeveelheid die hij meestal al heeft." },
          },
          required: ["name", "amount", "unit", "dept", "pantry"],
        },
      },
      steps: { type: "array", items: { type: "string" }, description: "Bereiding in korte stappen, in je eigen woorden." },
      storage: { type: "string", description: "Hoe lang en hoe bewaren bij mealprep (koelkast 3 °C / diepvries)." },
      kcal: { type: "number", description: "Geschat per portie." },
      protein: { type: "number" },
      carbs: { type: "number" },
      fat: { type: "number" },
      notes: { type: "string", description: "Wat je aannam of niet zeker weet (1 à 2 zinnen)." },
    },
    required: ["name", "meal_type", "servings", "ingredients", "steps", "storage", "kcal", "protein", "carbs", "fat", "notes"],
  },
};

const SYSTEM = `Je zet recepten om voor Simons mealprep-app. Antwoord altijd met de tool "recipe", in het Nederlands.
- Reken alle hoeveelheden om naar ÉÉN portie. Gebruik gram of ml voor alles wat je weegt; droge rijst, pasta en noedels als droog gewicht.
- Gebruik productnamen zoals Albert Heijn België ze verkoopt en kies de juiste afdeling.
- Schat kcal, eiwit, koolhydraten en vet per portie met standaard voedingswaarden (NEVO, etiketten). Reken het echt uit per ingrediënt; rond af op hele getallen.
- Is de foto een bord eten zonder recept, maak dan een realistisch recept dat dat gerecht oplevert en zeg dat in notes.
- Schrijf de stappen in je eigen woorden, kort en concreet. Neem geen tekst letterlijk over.
- Bewaaradvies: bereid vlees/kip/vis 3 à 4 dagen in de koelkast, rijst 2 à 3 dagen; wat langer moet, invriezen.
- Simons doel: 2000 kcal, 150 g eiwit, 50 g vet per dag. Pas het recept niet aan, maar vermeld in notes kort als het erg vet of eiwitarm is.`;

// ---- link: JSON-LD Recipe uit de pagina halen, anders leesbare tekst ----
function findRecipe(node: any): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  const t = node["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return node;
  return findRecipe(node["@graph"]) || null;
}
async function fromUrl(url: string): Promise<string> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Alleen http(s)-links");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname)) throw new Error("Ongeldige link");
  const res = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (HealthHub recipe import)", "Accept": "text/html" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`De pagina gaf ${res.status}`);
  const html = (await res.text()).slice(0, 1_500_000);
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const r = findRecipe(JSON.parse(m[1].trim()));
      if (r) {
        const pick = { name: r.name, recipeYield: r.recipeYield, recipeIngredient: r.recipeIngredient,
          recipeInstructions: r.recipeInstructions, nutrition: r.nutrition };
        return `Recept van ${u.hostname} (gestructureerde data):\n${JSON.stringify(pick).slice(0, 20000)}`;
      }
    } catch { /* ongeldige JSON-LD */ }
  }
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return `Tekst van ${u.hostname}:\n${text.slice(0, 15000)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Gebruik POST" }, 405);

  // --- auth: ingelogde eigenaar (of cron-token voor tests) ---
  const cron = req.headers.get("x-cron-token");
  if (cron) {
    const expected = await rpc<string>("internal_get_secret", { p_name: "cron_token" });
    if (!expected || cron !== expected) return json({ error: "Geen toegang" }, 401);
  } else {
    const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Niet ingelogd" }, 401);
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u.user) return json({ error: "Niet ingelogd" }, 401);
    if (!(await rpc<boolean>("internal_is_owner", { p_uid: u.user.id }))) return json({ error: "Geen toegang" }, 403);
  }

  let body: { image?: string; media_type?: string; text?: string; url?: string };
  try { body = await req.json(); } catch { return json({ error: "Ongeldige body" }, 400); }
  const apiKey = await rpc<string | null>("internal_get_secret", { p_name: "anthropic_api_key" });
  if (!apiKey) return json({ error: "Geen Claude API-key ingesteld (Instellingen in de app)" }, 400);
  const model = ((await rpc<string | null>("internal_get_setting", { p_key: "ai_model" })) as string) || "claude-sonnet-5-5";

  const content: any[] = [];
  try {
    if (body.image) {
      if (body.image.length > 7_000_000) return json({ error: "Foto te groot" }, 413);
      const mt = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(body.media_type || "") ? body.media_type : "image/jpeg";
      content.push({ type: "image", source: { type: "base64", media_type: mt, data: body.image } });
    }
    const t = (body.text || "").trim();
    const url = body.url || (/^https?:\/\/\S+$/.test(t) ? t : "");
    if (url) content.push({ type: "text", text: await fromUrl(url) });
    else if (t) content.push({ type: "text", text: `Simon schreef:\n${t.slice(0, 8000)}` });
    if (!content.length) return json({ error: "Geef een foto, link of tekst" }, 400);
    content.push({ type: "text", text: "Zet dit om naar een recept voor de mealprep-app." });
  } catch (e) {
    return json({ error: "Link openen mislukt: " + (e instanceof Error ? e.message : String(e)) }, 400);
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2500, system: SYSTEM, tools: [TOOL], tool_choice: { type: "tool", name: "recipe" },
      messages: [{ role: "user", content }] }),
  });
  if (!res.ok) return json({ error: `Claude API ${res.status}: ${(await res.text()).slice(0, 300)}` }, 502);
  const out = await res.json();
  const tu = (out.content ?? []).find((b: any) => b.type === "tool_use");
  if (!tu) return json({ error: "Geen recept herkend" }, 422);
  const r = tu.input;
  r.ingredients = (r.ingredients || []).filter((i: any) => i && i.name).map((i: any) => ({
    name: String(i.name).slice(0, 80), amount: typeof i.amount === "number" ? Math.round(i.amount * 10) / 10 : null,
    unit: i.unit || null, dept: DEPTS.includes(i.dept) ? i.dept : "Overig", pantry: !!i.pantry,
  }));
  return json({ recipe: { ...r, source_url: body.url || (/^https?:\/\//.test((body.text || "").trim()) ? body.text!.trim() : null) }, model });
});
