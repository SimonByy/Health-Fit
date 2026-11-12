// Endpoint voor iPhone-opdrachten (Opdrachten-app). Beveiligd met een geheime sleutel (?k=...), alleen de sha256 staat in app.settings.
// GET  ?a=briefing&k=...        -> platte tekst van de briefing van vandaag
// GET  ?a=log&q=kwark&k=...     -> logt 1 portie van een vast product en geeft een zin terug
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const text = (t: string, s = 200) => new Response(t, { status: s, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const k = u.searchParams.get("k") || req.headers.get("x-key") || "";
  const { data: ok } = await admin.rpc("internal_shortcut_key_ok", { p_key: k });
  if (!ok) return text("Geen toegang", 401);
  const a = u.searchParams.get("a") || "briefing";
  try {
    if (a === "briefing") {
      const { data, error } = await admin.rpc("internal_briefing_text", {});
      if (error) throw error;
      return text(data || "Goeiemorgen Simon. Je briefing is nog niet klaar. Over een paar minuten krijg je een melding.");
    }
    if (a === "log") {
      const q = (u.searchParams.get("q") || "").trim();
      if (!q) return text("Zeg welk product", 400);
      const meal = u.searchParams.get("meal") || null;
      const { data, error } = await admin.rpc("internal_log_quick", { p_query: q.slice(0, 60), p_meal: meal });
      if (error) throw error;
      return text(data?.message || "Gelogd", data?.ok ? 200 : 404);
    }
    return text("Onbekende actie", 400);
  } catch (e) {
    return text("Er ging iets mis: " + String((e as Error).message || e).slice(0, 200), 500);
  }
});
