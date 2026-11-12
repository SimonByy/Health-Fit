// Ochtendbriefing: Claude schrijft elke ochtend een korte briefing (leven, training, voeding, school)
// die eindigt met een vraag. Om 09:00 komt er een melding; tikken opent deze pagina.
// Je laat ze voorlezen, antwoordt met je stem of door te typen en Claude antwoordt terug.
let C;
let B = null;
let speaking = false;

const $ = (s, r = document) => r.querySelector(s);
const plain = (s) => String(s || "")
  .replace(/```[\s\S]*?```/g, "")
  .replace(/[*_#>`|]/g, "")
  .replace(/\[(.*?)\]\(.*?\)/g, "$1")
  .replace(/\n{2,}/g, ". ")
  .replace(/\s+/g, " ").trim();

function pickVoice() {
  const vs = speechSynthesis.getVoices();
  return vs.find((v) => v.lang === "nl-BE") || vs.find((v) => v.lang?.startsWith("nl")) || null;
}

function speak(text, btn) {
  if (!("speechSynthesis" in window)) { C.toast("Voorlezen wordt niet ondersteund in deze browser"); return; }
  speechSynthesis.cancel();
  if (speaking) { speaking = false; setBtn(btn, false); return; }
  // iOS leest lange teksten soms niet volledig: in zinnen opdelen
  const parts = plain(text).match(/[^.!?]+[.!?]*/g) || [];
  const voice = pickVoice();
  speaking = true; setBtn(btn, true);
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    u.lang = "nl-BE"; if (voice) u.voice = voice; u.rate = 1.03;
    if (i === parts.length - 1) u.onend = () => { speaking = false; setBtn(btn, false); if (btn?.dataset.listen) startMic(); };
    speechSynthesis.speak(u);
  });
}
function setBtn(btn, on) { if (btn) btn.innerHTML = on ? "■ Stop" : btn.dataset.label; }

// ---------------------------------------------------------------- microfoon
let rec = null;
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ta = $("#bAns"); const mic = $("#bMic");
  if (!ta) return;
  if (!SR) { ta.focus(); return; }
  if (rec) { rec.stop(); return; }
  const base = ta.value ? ta.value.trim() + " " : "";
  rec = new SR(); rec.lang = "nl-BE"; rec.continuous = true; rec.interimResults = true;
  rec.onresult = (e) => {
    let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
    ta.value = base + t;
  };
  rec.onend = () => { rec = null; mic?.setAttribute("aria-pressed", "false"); if (mic) mic.querySelector("span:last-child").textContent = "Inspreken"; };
  rec.onerror = (e) => { if (e.error === "not-allowed") C.toast("Geef de app toegang tot je microfoon, of gebruik de microfoon van je toetsenbord.", 5000); };
  try { rec.start(); mic?.setAttribute("aria-pressed", "true"); if (mic) mic.querySelector("span:last-child").textContent = "Stop"; }
  catch { rec = null; ta.focus(); }
}

// ---------------------------------------------------------------- pagina
export async function renderBriefing(ctx) {
  C = ctx;
  B = await C.rpc("get_briefing", {});
  speaking = false;
  if (!B || !B.text) {
    C.view.innerHTML = `<section class="panel"><h3>Nog geen briefing vandaag</h3>
      <p class="hint">Claude maakt elke ochtend rond 08:45 je briefing klaar. Om 09:00 krijg je een melding.</p></section>`;
    return;
  }
  const chat = B.conversation_id ? await C.rpc("get_chat", { p_conversation: B.conversation_id }).catch(() => null) : null;
  // De eerste twee berichten zijn de briefing zelf; daarna volgt het gesprek
  const extra = (chat?.messages || []).filter((m) => !m.meta?.briefing).slice(1);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  C.view.innerHTML = `
    <section class="panel briefing">
      <div class="row" style="justify-content:space-between">
        <h3 style="margin:0">Goeiemorgen Simon</h3>
        <button class="btn" id="bPlay" data-label="▶ Voorlezen" data-listen="1">▶ Voorlezen</button>
      </div>
      <div class="md" style="margin-top:10px">${C.md(B.text)}</div>
    </section>
    <div class="chat" id="bChat">${extra.map((m) => `<div class="msg ${m.role}">${m.role === "user" ? C.esc(m.content) : C.md(m.content)}</div>`).join("")}</div>
    <section class="panel">
      <label for="bAns" class="small muted">Jouw antwoord</label>
      <textarea class="input" id="bAns" rows="3" placeholder="${SR ? "Tik op Inspreken of typ…" : "Typ, of gebruik de microfoon van je toetsenbord…"}" style="margin-top:6px"></textarea>
      <div class="row" style="margin-top:8px">
        ${SR ? `<button class="btn secondary mic" id="bMic" type="button" aria-pressed="false"><span class="dot"></span><span>Inspreken</span></button>` : ""}
        <button class="btn" id="bSend" style="flex:1">Antwoorden</button>
      </div>
      <p class="small muted" style="margin:8px 0 0">Na het voorlezen start de microfoon vanzelf. Je antwoord gaat ook in je dagboek.</p>
    </section>`;
  const play = $("#bPlay");
  play.onclick = () => speak(B.text, play);
  $("#bMic")?.addEventListener("click", startMic);
  $("#bSend").onclick = send;
  // Via de melding geopend? Meteen proberen voor te lezen (iOS vraagt soms toch een tik).
  if (/autoplay/.test(location.hash) || sessionStorage.getItem("hh_brief_played") !== B.day) {
    sessionStorage.setItem("hh_brief_played", B.day);
    setTimeout(() => { try { speak(B.text, play); } catch { /* tik nodig */ } }, 400);
  }
}

async function send() {
  const ta = $("#bAns"); const btn = $("#bSend");
  const msg = ta.value.trim(); if (!msg) return startMic();
  rec?.stop();
  btn.disabled = true;
  const box = $("#bChat");
  box.insertAdjacentHTML("beforeend", `<div class="msg user">${C.esc(msg)}</div><div class="thinking" id="bThink"><i></i>Even denken…</div>`);
  ta.value = "";
  // Altijd bewaren in het dagboek, zodat de briefing van morgen er rekening mee houdt
  C.rpc("save_journal", { p_day: C.today(), p_text: `Antwoord op ochtendbriefing: ${msg}`, p_append: true }).catch(() => {});
  try {
    const r = await C.invoke("ask", { message: msg, conversation_id: B.conversation_id });
    $("#bThink")?.remove();
    box.insertAdjacentHTML("beforeend", `<div class="msg assistant">${C.md(r.answer)}</div>`);
    speak(r.answer, null);
  } catch (e) {
    $("#bThink")?.remove();
    const credits = /credit balance|Plans & Billing/i.test(e.message);
    box.insertAdjacentHTML("beforeend", `<div class="msg assistant"><p>${credits
      ? "Bewaard in je dagboek. Live antwoorden lukt nu niet: het API-tegoed van je Claude-sleutel is op. Morgen houdt de briefing rekening met wat je zei."
      : `Bewaard in je dagboek. Antwoorden lukte niet: ${C.esc(e.message)}`}</p></div>`);
  } finally { btn.disabled = false; }
}
