// Coach: trainingsplan dat Claude elke zondag maakt (gym + zone 2), ook in Google Calendar.
// Vandaag-kaart en weekoverzicht in Training, met afvinken (gedaan / overgeslagen).
let C;
const ICON = { push: "🏋️", pull: "🏋️", legs: "🏋️", upper: "🏋️", lower: "🏋️", z2: "🏃", rust: "😴", anders: "•" };
const WD = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const hm = (t) => (t ? String(t).slice(0, 5) : "");
const wd = (iso) => WD[new Date(iso + "T12:00:00Z").getUTCDay()];

function item(s, today) {
  const st = s.status;
  return `<div class="coach-item ${st}" data-id="${s.id}">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap;gap:8px">
      <span><b>${ICON[s.kind] || "•"} ${C.esc(s.title)}</b>
        <span class="small muted"> · ${today ? "" : wd(s.day) + " "}${hm(s.start_local)}${s.end_local ? "–" + hm(s.end_local) : ""}</span></span>
      <span class="small">${st === "gedaan" ? "✓" : st === "overgeslagen" ? "✕" : ""}</span>
    </div>
    ${s.details ? `<details ${today ? "open" : ""}><summary class="small muted">Doelen en uitleg</summary>
      <ul class="mp-ul small">${s.details.split(/\s·\s|\n/).filter(Boolean).map((x) => `<li>${C.esc(x)}</li>`).join("")}</ul></details>` : ""}
    ${st === "gepland" && s.day <= C.today() ? `<div class="row" style="gap:8px;margin-top:6px">
      <button class="btn secondary" data-st="gedaan">✓ Gedaan</button>
      <button class="btn ghost" data-st="overgeslagen">Overgeslagen</button></div>` : ""}
    ${s.note ? `<p class="small muted" style="margin:4px 0 0">📝 ${C.esc(s.note)}</p>` : ""}
  </div>`;
}

function bind(el, rerender) {
  el.querySelectorAll("[data-st]").forEach((b) => (b.onclick = async () => {
    const id = Number(b.closest("[data-id]").dataset.id);
    const st = b.dataset.st;
    const note = st === "overgeslagen" ? (prompt("Waarom? (optioneel, helpt je coach)") || "") : "";
    try { await C.rpc("set_coach_status", { p_id: id, p_status: st, p_note: note || null }); C.toast(st === "gedaan" ? "Sterk! 💪" : "Genoteerd"); rerender(); }
    catch (e) { C.toast(e.message, 4000); }
  }));
}

export async function renderCoachToday(ctx, el) {
  C = ctx;
  const list = (await C.rpc("get_coach_week", { p_from: C.today() }).catch(() => [])).filter((s) => s.day === C.today());
  if (!list.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<section class="panel"><h3 style="margin:0 0 6px">Training vandaag</h3>${list.map((s) => item(s, true)).join("")}</section>`;
  bind(el, () => renderCoachToday(ctx, el));
}

export async function renderCoachWeek(ctx, el) {
  C = ctx;
  const list = await C.rpc("get_coach_week", { p_from: C.today() }).catch(() => []);
  if (!list.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<section class="panel"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Plan van je coach</h3>
      <span class="small muted">ook in je agenda</span></div>${list.map((s) => item(s, false)).join("")}
      <p class="small muted" style="margin:8px 0 0">Elke zondagavond past je coach het plan aan op basis van Hevy, Garmin en je agenda.</p></section>`;
  bind(el, () => renderCoachWeek(ctx, el));
}
