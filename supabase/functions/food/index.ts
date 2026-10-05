// Zoeken in Open Food Facts (publieke, gratis voedingsdatabank).
// Proxy omdat de zoek-API geen CORS toelaat; barcodes kan de app ook rechtstreeks opvragen.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const UA = "HealthHub/1.0 (persoonlijke app; https://health-hub-simon.vercel.app)";
const FIELDS = "code,product_name,product_name_nl,brands,nutriments,serving_size,serving_quantity,image_small_url";

const num = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
function normalize(p: any) {
  if (!p) return null;
  const n = p.nutriments || {};
  let kcal = num(n["energy-kcal_100g"]);
  if (kcal === null && num(n["energy_100g"]) !== null) kcal = num(n["energy_100g"])! / 4.184;
  let sodium = num(n["sodium_100g"]);
  if (sodium === null && num(n["salt_100g"]) !== null) sodium = num(n["salt_100g"])! / 2.5;
  const brand = Array.isArray(p.brands) ? p.brands.join(", ") : p.brands;
  return {
    barcode: p.code ? String(p.code) : null,
    name: p.product_name_nl || p.product_name || "Onbekend product",
    brand: brand || null,
    per100: {
      kcal, protein: num(n["proteins_100g"]), carbs: num(n["carbohydrates_100g"]), fat: num(n["fat_100g"]),
      fiber: num(n["fiber_100g"]), sugar: num(n["sugars_100g"]), sodium_mg: sodium === null ? null : sodium * 1000,
    },
    serving_g: num(p.serving_quantity),
    serving_label: p.serving_size || null,
    image: p.image_small_url || null,
    source: "off",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const { data } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
  if (!data.user) return json({ error: "Niet ingelogd" }, 401);
  const { data: owner } = await admin.rpc("internal_is_owner", { p_uid: data.user.id });
  if (!owner) return json({ error: "Geen toegang" }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { /* leeg */ }
  try {
    if (body.barcode) {
      const code = String(body.barcode).replace(/\D/g, "");
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${FIELDS}`, { headers: { "User-Agent": UA } });
      const out = await r.json();
      return json({ product: out.status === 1 ? normalize(out.product) : null });
    }
    const q = String(body.q || "").trim();
    if (q.length < 2) return json({ products: [] });
    const r = await fetch(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&page_size=25&langs=nl,en,fr&fields=${FIELDS}`,
      { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`Open Food Facts ${r.status}`);
    const out = await r.json();
    const products = (out.hits || []).map(normalize).filter((p: any) => p && p.per100.kcal !== null);
    return json({ products });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
