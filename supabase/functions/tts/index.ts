// Voorlezen met een Gemini-stem (gratis laag) in plaats van de iPhone-stem. Per gebruiker, met diens eigen Gemini-sleutel.
// POST {text, voice?}            (ingelogde gebruiker, of service-sleutel + user_id) -> {url}   audio (WAV) via een tijdelijke link
// POST {briefing_day, user_id}   (databank met x-cron-token) -> maakt de audio van de opgeslagen briefing vooraf klaar
// POST {voice, save: true}       (gebruiker)            -> standaardstem bewaren
// Elke tekst wordt maar één keer omgezet: de audio wordt bewaard (bucket tts) en daarna hergebruikt.
import { createClient } from "npm:@supabase/supabase-js@2";
import { AsyncLocalStorage } from "node:async_hooks";

const ENV_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const VOICES = ["Sulafat", "Achird", "Charon", "Kore", "Puck", "Aoede", "Algieba", "Gacrux", "Iapetus", "Schedar", "Vindemiatrix", "Orus"];
const STYLE = "Vlaams-Nederlands, warm en rustig, als een persoonlijke coach die 's ochtends kort bijpraat; natuurlijk tempo";

// Per gebruiker: de databank leest de gebruiker uit de header x-hh-user (alleen geldig met de service-sleutel).
// elk verzoek krijgt een eigen object, zodat gelijktijdige verzoeken van verschillende gebruikers niet mengen
const als = new AsyncLocalStorage<{ db: any; key: string }>();
const st = () => als.getStore()!;
const userDb = (uid: string) => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false }, global: { headers: { "x-hh-user": uid } } });
async function useUser(uid: string) {
  const s = st(); s.db = userDb(uid);
  const legacy = (await admin.rpc("internal_legacy_user")).data;
  s.key = (await s.db.rpc("internal_get_secret", { p_name: "gemini_api_key" })).data || (uid === legacy ? ENV_KEY : "");
}
async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await st().db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

// Zelfde opschoning als in de app: geen markdown, emoji of links voorlezen
function plain(s: string) {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[*_#>`|]/g, "")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ").trim().slice(0, 4000);
}

async function sha(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function b64bytes(b64: string) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Ruwe PCM (16-bit mono) in een WAV-container steken
function wav(pcm: Uint8Array, rate = 24000) {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt ");
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  w(36, "data"); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h.buffer), 0); out.set(pcm, 44);
  return out;
}

async function synth(text: string, voice: string): Promise<{ audio: Uint8Array; model: string }> {
  const tries: { model: string; body: unknown }[] = [
    ...["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"].map((model) => ({ model, body: {
      contents: [{ role: "user", parts: [{ text, speech_metadata: { style: STYLE } }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { voice } } },
    } })),
    { model: "gemini-3.1-flash-tts-preview", body: {
      contents: [{ parts: [{ text: `Lees voor in het Vlaams-Nederlands, warm en rustig: ${text}` }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    } },
  ];
  const errs: string[] = [];
  for (const t of tries) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/${t.model}:generateContent`, {
        method: "POST", signal: AbortSignal.timeout(90000),
        headers: { "content-type": "application/json", "x-goog-api-key": st().key }, body: JSON.stringify(t.body),
      });
    } catch (e) { errs.push(`${t.model}: ${e}`); continue; }
    try { await rpc("internal_ai_usage_add", { p_model: t.model, p_limited: res.status === 429 }); } catch { /* tellen mag niets breken */ }
    if (!res.ok) { errs.push(`${t.model} ${res.status}: ${(await res.text()).slice(0, 200)}`); continue; }
    const out = await res.json();
    const part = (out.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
    if (!part) { errs.push(`${t.model}: geen audio`); continue; }
    let audio = b64bytes(part.inlineData.data);
    const isWav = audio[0] === 0x52 && audio[1] === 0x49 && audio[2] === 0x46 && audio[3] === 0x46;
    if (!isWav) audio = wav(audio, Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1]) || 24000);
    return { audio, model: t.model };
  }
  throw new Error(errs.join(" | "));
}

async function getVoice(want?: string) {
  if (want && VOICES.includes(want)) return want;
  const v = await rpc<any>("internal_get_setting", { p_key: "tts_voice" }).catch(() => null);
  const s = typeof v === "string" ? v : v?.voice;
  return VOICES.includes(s) ? s : "Sulafat";
}

// Audio maken of uit de bewaarde audio halen; geeft het pad terug
async function audioFor(raw: string, want?: string) {
  const text = plain(raw);
  if (!text) throw new Error("Geen tekst");
  const voice = await getVoice(want);
  const path = `${voice}/${await sha(text)}.wav`;
  const { data: hit } = await admin.storage.from("tts").createSignedUrl(path, 3600);
  if (hit?.signedUrl) return { path, url: hit.signedUrl, cached: true, voice };
  const { audio, model } = await synth(text, voice);
  const { error } = await admin.storage.from("tts").upload(path, audio, { contentType: "audio/wav", upsert: true });
  if (error) throw new Error(`Opslaan: ${error.message}`);
  const { data } = await admin.storage.from("tts").createSignedUrl(path, 3600);
  return { path, url: data?.signedUrl, cached: false, voice, model };
}

Deno.serve((req) => als.run({ db: admin, key: "" }, () => handle(req)));
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Ongeldige body" }, 400); }

  // Vooraf klaarzetten door de databank (met cron-token en gebruiker)
  if (body.briefing_day || body.reply_id) {
    const cron = (await admin.rpc("internal_get_secret", { p_name: "cron_token" })).data;
    if (!cron || req.headers.get("x-cron-token") !== cron || !body.user_id) return json({ error: "Geen toegang" }, 401);
    await useUser(String(body.user_id));
    if (!st().key) return json({ ok: false, error: "Geen Gemini-sleutel" });
    const work = (async () => {
      try {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.briefing_day ?? "")) ? body.briefing_day : null;
        const t = await rpc<string | null>("internal_tts_text", { p_day: day, p_reply: body.reply_id ? Number(body.reply_id) : null });
        if (!t) return { ok: false, error: "Niet gevonden" };
        const r = await audioFor(t);
        return { ok: true, cached: r.cached, voice: r.voice, model: (r as any).model };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    })();
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil && !body.wait) { rt.waitUntil(work.then((r) => console.log(JSON.stringify(r)))); return json({ accepted: true }, 202); }
    return json(await work);
  }

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet ingelogd" }, 401);
  // andere edge functions (bv. de iPhone-opdracht) mogen met de service-sleutel, voor een opgegeven gebruiker
  if (jwt === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    if (!body.user_id) return json({ error: "user_id ontbreekt" }, 400);
    await useUser(String(body.user_id));
  } else {
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u.user || !(await admin.rpc("internal_is_owner", { p_uid: u.user.id })).data) return json({ error: "Geen toegang" }, 403);
    await useUser(u.user.id);
  }
  if (!st().key && !body.list && !body.save) return json({ error: "Vul eerst je eigen gratis Gemini-sleutel in bij Instellingen." }, 400);

  if (body.list) return json({ voices: VOICES, voice: await getVoice() });
  if (body.save) {
    if (!VOICES.includes(body.voice)) return json({ error: "Onbekende stem" }, 400);
    await rpc("internal_tts_voice_save", { p_voice: body.voice });
    return json({ ok: true, voice: body.voice });
  }
  try {
    const r = await audioFor(String(body.text ?? ""), body.voice);
    return json({ url: r.url, cached: r.cached, voice: r.voice });
  } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
}
