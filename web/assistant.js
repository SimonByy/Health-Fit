// AI-coach: vast bolletje rechtsonder op elk scherm, opent een chat over je data en je app.
// Gesprekken blijven bewaard (app.chat_messages); via "Gesprekken" open je een oud gesprek opnieuw.
let C = null;
let conv = null;          // huidig gesprek
let busy = false;
const $ = (s, el = document) => el.querySelector(s);
const LS = "hh_conv";

const SUGGESTIONS = [
  "Hoe sliep ik deze week vergeleken met vorige week?",
  "Haal ik genoeg eiwit op dagen dat ik train?",
  "Hoe ging mijn laatste run? Bleef ik in zone 2?",
  "Wat staat er morgen op mijn menu en klopt dat met mijn doelen?",
  "Zet donderdagavond iets anders op mijn menu",
  "Vat mijn laatste 7 dagen samen: wat ging goed, wat kan beter?",
  "Herinner me elke avond om 21u30 aan mijn dagboek",
];

const ICON_AI = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 2.5l1.9 5.1 5.1 1.9-5.1 1.9L12 16.5l-1.9-5.1L5 9.5l5.1-1.9L12 2.5Zm6.5 11l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4ZM6 15l.7 1.8 1.8.7-1.8.7L6 20l-.7-1.8-1.8-.7 1.8-.7L6 15Z"/></svg>`;

function msgHtml(m) {
  if (m.role === "user") return `<div class="msg user">${C.esc(m.content)}</div>`;
  const qs = m.meta?.queries || [];
  const did = qs.filter((q) => q.tool === "app_write" && !q.error).length;
  return `<div class="msg assistant">${C.md(m.content || "")}${qs.length ? `
    <details class="sources"><summary>${did ? `${did} wijziging${did > 1 ? "en" : ""} in je app · ` : ""}${qs.length} opzoeking${qs.length > 1 ? "en" : ""}</summary>
      <ul>${qs.map((q) => `<li>${C.esc(q.summary || q.purpose || q.tool)}${q.error ? ` <span class="warn">(fout)</span>` : q.rows != null ? ` (${q.rows} rijen)` : ""}</li>`).join("")}</ul>
    </details>` : ""}</div>`;
}

function emptyHtml() {
  return `<div class="ai-empty">
    <div class="ai-orb" aria-hidden="true">${ICON_AI}</div>
    <h3>Vraag het je coach</h3>
    <p class="small muted">Over je slaap, voeding, trainingen en menu. Hij kan ook dingen voor je aanpassen: je menu, een recept, een herinnering.</p>
    <div class="chips">${SUGGESTIONS.map((s) => `<button class="chip" data-q="${C.esc(s)}">${C.esc(s)}</button>`).join("")}</div></div>`;
}

export function mountAssistant(ctx) {
  C = ctx;
  if ($("#aiFab")) return;
  document.body.insertAdjacentHTML("beforeend", `<button class="ai-fab" id="aiFab" aria-label="Vraag het je AI-coach">${ICON_AI}</button>`);
  $("#aiFab").onclick = () => openAssistant(ctx);
}

export async function openAssistant(ctx, opts = {}) {
  C = ctx || C;
  if ($("#aiSheet")) return;
  try { conv = localStorage.getItem(LS) || null; } catch { conv = null; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.body.insertAdjacentHTML("beforeend", `
    <div class="ai-sheet" id="aiSheet" role="dialog" aria-modal="true" aria-label="AI-coach">
      <header class="ai-head">
        <button class="icon-btn" id="aiList" aria-label="Gesprekken"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
        <h2 id="aiTitle">Coach</h2>
        <button class="icon-btn" id="aiNew" aria-label="Nieuw gesprek"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
        <button class="icon-btn" id="aiClose" aria-label="Sluiten"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </header>
      <div class="ai-body" id="aiBody"><div class="chat" id="aiChat"><div class="skeleton"></div></div></div>
      <form class="ai-comp" id="aiForm">
        ${SR ? `<button class="ai-mic" id="aiMic" type="button" aria-label="Inspreken" aria-pressed="false"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>` : ""}
        <textarea id="aiQ" rows="1" placeholder="Vraag of zeg iets…" aria-label="Bericht"></textarea>
        <button class="send" id="aiSend" aria-label="Verstuur"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </form>
    </div>`);
  document.body.classList.add("ai-open");
  const sheet = $("#aiSheet"), ta = $("#aiQ");
  const close = () => { rec?.stop(); sheet.remove(); document.body.classList.remove("ai-open"); window.removeEventListener("hashchange", close); };
  window.addEventListener("hashchange", close);
  $("#aiClose").onclick = close;
  $("#aiNew").onclick = () => { conv = null; try { localStorage.removeItem(LS); } catch { /* */ } showChat([]); ta.focus(); };
  $("#aiList").onclick = showList;
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#aiForm").requestSubmit(); } });
  $("#aiForm").onsubmit = (e) => { e.preventDefault(); const v = ta.value.trim(); if (v && !busy) { ta.value = ""; ta.style.height = "auto"; ask(v); } };
  $("#aiBody").addEventListener("click", async (e) => {
    const chip = e.target.closest(".chip"); if (chip) { ask(chip.dataset.q); return; }
    const open = e.target.closest("[data-conv]"); if (open) { conv = open.dataset.conv; try { localStorage.setItem(LS, conv); } catch { /* */ } loadChat(); return; }
    const del = e.target.closest("[data-hide]");
    if (del) { await C.rpc("chat_hide", { p_conversation: del.dataset.hide }).catch(() => {}); if (conv === del.dataset.hide) { conv = null; try { localStorage.removeItem(LS); } catch { /* */ } } showList(); }
    if (e.target.closest("a[href^='#/']")) close();
  });

  // inspreken
  let rec = null;
  $("#aiMic")?.addEventListener("click", () => {
    const mic = $("#aiMic");
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = "nl-BE"; rec.interimResults = true; rec.continuous = false;
    const base = ta.value ? ta.value + " " : "";
    rec.onresult = (ev) => { ta.value = base + [...ev.results].map((r) => r[0].transcript).join(" "); ta.dispatchEvent(new Event("input")); };
    rec.onerror = () => C.toast("Inspreken lukte niet. Gebruik het microfoontje van je toetsenbord.", 4000);
    rec.onend = () => { mic.classList.remove("on"); mic.setAttribute("aria-pressed", "false"); rec = null;
      const v = ta.value.trim(); if (v && !busy) { ta.value = ""; ta.style.height = "auto"; ask(v); } };
    mic.classList.add("on"); mic.setAttribute("aria-pressed", "true");
    try { rec.start(); } catch { rec = null; mic.classList.remove("on"); }
  });

  if (opts.question) { conv = null; showChat([]); ask(opts.question); } else loadChat();
}

async function loadChat() {
  $("#aiTitle").textContent = "Coach";
  $("#aiForm").hidden = false;
  if (!conv) return showChat([]);
  const chat = await C.rpc("get_chat", { p_conversation: conv }).catch(() => null);
  showChat(chat?.messages || []);
}

function showChat(msgs) {
  const box = $("#aiChat"); if (!box) return;
  $("#aiTitle").textContent = "Coach";
  $("#aiForm").hidden = false;
  box.innerHTML = msgs.length ? msgs.map(msgHtml).join("") : emptyHtml();
  if (busy) box.insertAdjacentHTML("beforeend", thinking());
  scrollEnd();
}

async function showList() {
  const box = $("#aiChat"); if (!box) return;
  $("#aiTitle").textContent = "Gesprekken";
  $("#aiForm").hidden = true;
  box.innerHTML = `<div class="skeleton"></div>`;
  const list = await C.rpc("get_chats", { p_limit: 40 }).catch(() => []);
  const when = (t) => { const d = new Date(t); const days = Math.floor((Date.now() - d) / 864e5);
    return days < 1 ? d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" }) : days < 7 ? d.toLocaleDateString("nl-BE", { weekday: "long" }) : d.toLocaleDateString("nl-BE", { day: "numeric", month: "short" }); };
  box.innerHTML = `<button class="btn" id="aiNew2" style="margin-bottom:12px">+ Nieuw gesprek</button>
    ${list.length ? `<div class="ai-list">${list.map((c) => `<div class="ai-conv${c.id === conv ? " on" : ""}">
      <button class="ai-conv-open" data-conv="${C.esc(c.id)}"><b>${C.esc(c.title || "Gesprek")}</b><span class="small muted">${C.esc(when(c.last_at))} · ${c.n} berichten</span></button>
      <button class="ai-conv-del" data-hide="${C.esc(c.id)}" aria-label="Gesprek verwijderen">×</button></div>`).join("")}</div>`
      : `<p class="muted small">Nog geen gesprekken.</p>`}`;
  $("#aiNew2").onclick = () => $("#aiNew").click();
}

const thinking = () => `<div class="thinking" id="aiThinking"><i></i>Even kijken in je data…</div>`;
function scrollEnd() { requestAnimationFrame(() => { const b = $("#aiBody"); if (b) b.scrollTop = b.scrollHeight; }); }

async function ask(q) {
  const box = $("#aiChat"); if (!box) return;
  if (box.querySelector(".ai-empty, .ai-list, #aiNew2")) { box.innerHTML = ""; $("#aiTitle").textContent = "Coach"; $("#aiForm").hidden = false; }
  box.insertAdjacentHTML("beforeend", msgHtml({ role: "user", content: q }) + thinking());
  busy = true; $("#aiSend").disabled = true;
  scrollEnd();
  const started = conv || crypto.randomUUID();
  try {
    const r = await C.invoke("ask", { message: q, conversation_id: started });
    conv = r.conversation_id || started;
    try { localStorage.setItem(LS, conv); } catch { /* */ }
    $("#aiThinking")?.remove();
    $("#aiChat")?.insertAdjacentHTML("beforeend", msgHtml({ role: "assistant", content: r.answer, meta: { queries: r.queries } }));
    // iets aangepast in de app? Het scherm eronder vernieuwen.
    if ((r.queries || []).some((x) => ["app_write", "log_measurement", "create_routine", "update_routine"].includes(x.tool) && !x.error)) C.refresh?.();
  } catch (e) {
    $("#aiThinking")?.remove();
    $("#aiChat")?.insertAdjacentHTML("beforeend", `<div class="msg assistant"><p class="warn">${C.esc(e.message)}</p><p class="small muted">Probeer het zo nog eens.</p></div>`);
  } finally {
    busy = false;
    const b = $("#aiSend"); if (b) b.disabled = false;
    scrollEnd();
  }
}
