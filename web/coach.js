// Coach: trainingsplan dat Claude elke zondag maakt (gym + zone 2), ook in Google Calendar.
// Vandaag-kaart en weekoverzicht in Training, met afvinken (gedaan / overgeslagen).
let C;
const ICON = {};
const WD = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const hm = (t) => (t ? String(t).slice(0, 5) : "");
const wd = (iso) => WD[new Date(iso + "T12:00:00Z").getUTCDay()];

function item(s, today) {
  const st = s.status;
  return `<div class="coach-item ${st}" data-id="${s.id}">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap;gap:8px">
      <span><b>${C.esc(s.title.replace(/^[^\p{L}\d]+/u, ""))}</b>
        ${today ? "" : `<span class="small muted"> · ${wd(s.day)}</span>`}</span>
      <span class="small">${st === "gedaan" ? "✓" : st === "overgeslagen" ? "✕" : ""}</span>
    </div>
    ${s.details ? `<details><summary class="small muted">Oefeningen en doelen</summary>
      <ul class="mp-ul small">${s.details.split(/\s·\s|\n/).filter(Boolean).map((x) => `<li>${C.esc(x)}</li>`).join("")}</ul></details>` : ""}
    ${st === "gepland" && today && (s.kind === "z2" || s.category === "cardio") && /run-walk|joggen|interval/i.test(`${s.title} ${s.details || ""}`) ? `<a class="small" href="#/timer" style="display:inline-block;margin-top:6px">Intervaltimer openen ›</a>` : ""}
    ${st === "gepland" && s.day <= C.today() ? `<div class="row" style="gap:8px;margin-top:6px">
      <button class="btn secondary" data-st="gedaan">✓ Gedaan</button>
      <button class="btn ghost" data-st="overgeslagen">Overgeslagen</button></div>` : ""}
    ${s.note ? `<p class="small muted" style="margin:4px 0 0">${C.esc(s.note)}</p>` : ""}
  </div>`;
}

function bind(el, rerender) {
  el.querySelectorAll("[data-st]").forEach((b) => (b.onclick = async () => {
    const id = Number(b.closest("[data-id]").dataset.id);
    const st = b.dataset.st;
    const note = st === "overgeslagen" ? (prompt("Waarom? (optioneel, helpt je coach)") || "") : "";
    try { await C.rpc("set_coach_status", { p_id: id, p_status: st, p_note: note || null }); C.toast(st === "gedaan" ? "Goed gedaan" : "Genoteerd"); rerender(); }
    catch (e) { C.toast(e.message, 4000); }
  }));
}

// Herstel-advies voor de training van vandaag: readiness + spierbelasting van de spieren die vandaag aan de beurt zijn
const KIND_MUSCLES = { push: ["chest", "shoulders", "triceps"], pull: ["upper_back", "lats", "biceps"], legs: ["quadriceps", "hamstrings", "glutes"],
  lower: ["quadriceps", "hamstrings", "glutes"], upper: ["chest", "upper_back", "lats", "shoulders"] };
const MNL = { chest: "borst", shoulders: "schouders", triceps: "triceps", upper_back: "rug", lats: "rug", biceps: "biceps", quadriceps: "benen", hamstrings: "hamstrings", glutes: "bilspieren" };
async function readinessAdvice(list) {
  const plan = list.filter((s) => s.status === "gepland");
  if (!plan.length) return "";
  const [r, fat] = await Promise.all([C.rpc("get_readiness", { p_day: C.today() }).catch(() => null), C.rpc("get_muscle_fatigue").catch(() => [])]);
  const nz = (v) => (v == null || v === "" ? NaN : Number(v));
  const score = r ? nz(r.score_now ?? r.score) : NaN;
  const bb = r ? nz(r.bb_now ?? r.bb_wake) : NaN;
  const by = Object.fromEntries((fat || []).map((x) => [x.muscle, Number(x.pct) || 0]));
  const kinds = plan.map((s) => s.kind).filter((k) => KIND_MUSCLES[k]);
  const loaded = [...new Set(kinds.flatMap((k) => KIND_MUSCLES[k]).filter((m) => by[m] >= 55).map((m) => MNL[m]))];
  const cardio = plan.some((s) => s.kind === "z2" || s.category === "cardio");
  const low = (!isNaN(score) && score < 40) || (!isNaN(bb) && bb < 25);
  const high = !isNaN(score) && score >= 75 && !loaded.length;
  if (!low && !loaded.length && !high) return "";
  let tone = "ok", txt;
  if (low && loaded.length) { tone = "bad"; txt = `Weinig hersteld (readiness ${isNaN(score) ? "?" : score}) en je ${loaded.join(", ")} ${loaded.length > 1 ? "zijn" : "is"} nog belast. Ruil vandaag voor rust of een rustige wandeling, of doe de helft van je sets.`; }
  else if (low) { tone = "warn"; txt = `Readiness ${isNaN(score) ? "laag" : score}${!isNaN(bb) ? `, Body Battery ${bb}` : ""}: train lichter. ${kinds.length ? "Eén set minder per oefening en blijf 2–3 herhalingen van falen." : ""}${cardio ? " Houd de cardio echt rustig (zone 2)." : ""}`; }
  else if (loaded.length) { tone = "warn"; txt = `Je ${loaded.join(", ")} ${loaded.length > 1 ? "zijn" : "is"} nog belast van vorige trainingen. Begin lichter en kijk na de eerste sets hoe het gaat.`; }
  else { txt = `Goed hersteld (readiness ${score}). Een goede dag om een set zwaarder te gaan.`; }
  return `<p class="ready-tip rt-${tone} small">${C.esc(txt)}</p>`;
}

// acts = { html, bind }: de trainingen die vandaag al binnenkwamen (Hevy, Garmin, Apple Gezondheid)
export async function renderCoachToday(ctx, el, acts = {}) {
  C = ctx;
  const list = (await C.rpc("get_coach_week", { p_from: C.today() }).catch(() => [])).filter((s) => s.day === C.today() && s.kind !== "rust");
  const done = list.length ? list.every((s) => s.status !== "gepland") : !!acts.html;
  const what = list.length ? list.map((s) => C.esc(s.title.replace(/^[^\p{L}\d]+/u, ""))).join(" + ") : acts.html ? "gedaan" : "rustdag";
  el.innerHTML = `<details class="set-group today-train" ${done || !list.length ? "" : "open"}><summary><span>Training vandaag <span class="muted small">· ${what}${done && list.length ? " ✓" : ""}</span></span></summary>
    <div class="set-body"><div class="ready-advice"></div>${list.map((s) => item(s, true)).join("")}
      ${acts.html ? `<h4 class="sub-h" style="margin:${list.length ? "12px" : "0"} 0 4px">Geregistreerd</h4>${acts.html}` : ""}
      ${!list.length && !acts.html ? `<p class="muted small" style="margin:0">Niets gepland en nog niets geregistreerd. <a href="#/planner">Planner openen</a></p>` : ""}
    </div></details>`;
  bind(el, () => renderCoachToday(ctx, el, acts));
  acts.bind?.(el);
  readinessAdvice(list).then((h) => { const b = el.querySelector(".ready-advice"); if (b) b.innerHTML = h; }).catch(() => {});
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

// ---------- Weekagenda (Training) ----------
const SHORT = (s) => {
  if (s.kind === "z2") { const m = /(\d+)\s*min/.exec(s.title); return `${/incline|wandel/i.test(s.title) ? "Walk" : "Run"}${m ? " " + m[1] + "′" : ""}`; }
  return s.title.replace(/^[^\p{L}]+/u, "").split(/\s|·/)[0];
};
const KIND_CLS = (k) => (k === "z2" ? "z2" : k === "rust" ? "rest" : "gym");
const monday = (iso) => { const d = new Date(iso + "T12:00:00Z"); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); };

export async function renderCoachCalendar(ctx, el, start) {
  C = ctx;
  const from = start || monday(C.today());
  const days = Array.from({ length: 7 }, (_, i) => C.addDays(from, i));
  // Naast het plan ook wat je echt deed: een dag met een training is geen "rust"
  const [list, cal] = await Promise.all([
    C.rpc("get_coach_week", { p_from: from }).catch(() => []),
    from <= C.today() ? C.rpc("get_calendar", { p_from: from, p_to: days[6] < C.today() ? days[6] : C.today() }).catch(() => []) : [],
  ]);
  const done = new Map((cal || []).map((c) => [c.day, c]));
  const doneMark = (d) => {
    const c = done.get(d); if (!c || d > C.today()) return "";
    const what = [c.strength > 0 ? "Kracht" : "", c.cardio > 0 ? "Cardio" : ""].filter(Boolean);
    return what.length ? `<span class="wdone">${what.join(" + ")} ✓</span>` : "";
  };
  const fmtRange = (a, b) => new Intl.DateTimeFormat("nl-BE", { day: "numeric", month: "short", timeZone: "UTC" }).formatRange(new Date(a + "T12:00:00Z"), new Date(b + "T12:00:00Z"));
  el.innerHTML = `<section class="wcal">
    <header><button class="wnav" data-w="-7" aria-label="Vorige week">‹</button>
      <div><h2>Weekplan</h2><span>${C.esc(fmtRange(days[0], days[6]))}</span></div>
      <button class="wnav" data-w="7" aria-label="Volgende week">›</button></header>
    <div class="wgrid">${days.map((d) => {
      const items = list.filter((s) => s.day === d);
      const dn = new Date(d + "T12:00:00Z");
      return `<div class="wday ${d === C.today() ? "today" : ""} ${d < C.today() ? "past" : ""}">
        <span class="wd">${["zo", "ma", "di", "wo", "do", "vr", "za"][dn.getUTCDay()]}</span><span class="dn">${dn.getUTCDate()}</span>
        ${items.map((s) => `<button class="wpill ${KIND_CLS(s.kind)} ${s.status}" data-id="${s.id}">${C.esc(SHORT(s))}${s.status === "gedaan" ? " ✓" : ""}</button>`).join("") || doneMark(d) || `<span class="wrest">rust</span>`}
      </div>`;
    }).join("")}</div>
    <a class="btn secondary" href="#/planner" style="display:block;text-align:center;text-decoration:none;margin-top:10px">${list.length ? "Planner openen" : "Week plannen"}</a>
  </section>`;
  el.querySelectorAll(".wnav").forEach((b) => (b.onclick = () => renderCoachCalendar(ctx, el, C.addDays(from, Number(b.dataset.w)))));
  el.querySelectorAll(".wpill").forEach((b) => (b.onclick = () => openSession(list.find((s) => String(s.id) === b.dataset.id), () => renderCoachCalendar(ctx, el, from))));
}

function openSession(s, rerender) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const dn = new Date(s.day + "T12:00:00Z");
  const when = new Intl.DateTimeFormat("nl-BE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(dn);
  const parts = (s.details || "").split(/\s·\s|\n/).filter(Boolean);
  const isGym = s.kind !== "z2" && s.kind !== "rust";
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${C.esc(s.title)}">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span class="sess-kicker ${KIND_CLS(s.kind)}">${s.kind === "z2" ? "Zone 2" : "Kracht"}</span>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <h2 class="sess-title">${C.esc(s.title.replace(/^[^\p{L}]+/u, ""))}</h2>
    <p class="sess-when">${C.esc(when)}${s.status !== "gepland" ? ` · <b>${C.esc(s.status)}</b>` : ""}</p>
    ${parts.length ? `<div class="sess-list">${parts.map((p) => {
      const m = isGym ? /^(.*?)\s+([\d.,]+(?:\s*×.*)?)$/.exec(p) : null;
      return m ? `<div class="sess-row"><span>${C.esc(m[1])}</span><b>${C.esc(m[2])}</b></div>` : `<div class="sess-row"><span>${C.esc(p)}</span></div>`;
    }).join("")}</div>` : ""}
    <p class="small muted" style="margin:12px 0 0">${isGym ? "Doel per oefening: gewicht × reps voor je 2 werksets." : "Hartslag tussen 138 en 152: daar draait het om, niet om het tempo."} Staat ook op je Garmin en in je agenda.</p>
    ${s.note ? `<p class="small" style="margin:8px 0 0">${C.esc(s.note)}</p>` : ""}
    ${s.status === "gepland" && s.day <= C.today() ? `<div class="row" style="gap:8px;margin-top:14px">
      <button class="btn" data-st="gedaan" style="flex:1">✓ Gedaan</button>
      <button class="btn ghost" data-st="overgeslagen" style="flex:1">Overgeslagen</button></div>` : ""}
  </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("[data-close]")) close(); });
  sheet.querySelectorAll("[data-st]").forEach((b) => (b.onclick = async () => {
    const st = b.dataset.st;
    const note = st === "overgeslagen" ? (prompt("Waarom? (optioneel, helpt je coach)") || "") : "";
    try { await C.rpc("set_coach_status", { p_id: s.id, p_status: st, p_note: note || null }); C.toast(st === "gedaan" ? "Goed gedaan" : "Genoteerd"); close(); rerender(); }
    catch (e) { C.toast(e.message, 4000); }
  }));
}
