// Trainingsplanner
// - Doelen: altijd zichtbaar bovenaan, met aftelling.
// - Vast weekschema: per weekdag wat je meestal doet (routine, cardio met eigen soort/duur/intensiteit, of rust).
//   Elke week wordt daar automatisch mee ingevuld; aanpassingen voor één week overschrijven het schema niet.
// - Past zich aan: een training die je echt deed (Garmin, Hevy, logger) vinkt de sessie af, ook als je ze een dag
//   eerder of later deed; wat je miste kan je met één tik inhalen of overslaan.
import * as RP from "./runplan.js";
let C, TARGETS = {};
const WDL = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
const WDS = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const CARDIO = [["lopen", "Lopen"], ["loopband", "Loopband"], ["fietsen", "Fietsen"], ["zwemmen", "Zwemmen"], ["roeien", "Roeien"], ["wandelen", "Stevig wandelen"], ["crosstrainer", "Crosstrainer"]];
const INTENS = [["zone 2", "Zone 2"], ["intervallen", "Intervallen"], ["tempo", "Tempo"], ["lang", "Lange duur"], ["rustig", "Herstel"]];
const GOALKIND = [["uithouding", "Uithouding"], ["kracht", "Sterker worden"], ["spier", "Spiermassa"], ["vet", "Vet verliezen"], ["anders", "Ander doel"]];
const label = (arr, k) => (arr.find((x) => x[0] === k) || [k, k])[1];
const monday = (iso) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
const catOf = (s) => s.category || (s.kind === "z2" ? "cardio" : s.kind === "rust" ? "rust" : "kracht");
const clean = (t) => String(t || "").replace(/^[^\p{L}\d]+/u, "");
const slotTitle = (x, R) => x.cat === "cardio" ? `${label(CARDIO, x.cardio_type)} · ${x.intensity || "zone 2"}`
  : ((R.routines || []).find((r) => r.id === x.routine_id)?.name || x.title || "Krachttraining");
const slotDetails = (x, R) => {
  if (x.cat === "cardio") return x.intensity === "intervallen" ? "Opwarmen 10 min · 6× 2 min stevig + 2 min rustig · Afkoelen 5 min"
    : x.intensity === "tempo" ? "10 min inlopen · 15–20 min stevig maar gecontroleerd · uitlopen"
    : x.intensity === "lang" ? "Rustig tempo, je kan nog praten · langer dan je andere sessies"
    : x.intensity === "rustig" ? "Heel rustig, voor herstel" : "Rustig tempo, je kan nog praten · zone 2";
  if (x.routine_id && TARGETS[x.routine_id]) return TARGETS[x.routine_id];
  const r = (R.routines || []).find((y) => y.id === x.routine_id);
  return r ? (r.exercises || []).map((e) => `${e.title}${e.sets ? ` ${e.sets} sets` : ""}`).join(" · ") : null;
};
const sig = (cat, title, dur) => `${cat}|${clean(title)}|${dur || ""}`;

async function loadPrefs() {
  const p = (await C.rpc("get_setting", { p_key: "training_prefs" }).catch(() => null)) || {};
  p.goals ||= [];
  p.template ||= Array.from({ length: 7 }, () => []);
  return p;
}
const savePrefs = (p) => C.rpc("set_setting", { p_key: "training_prefs", p_value: p });

// ---------- doelen (ook op het tabblad Training) ----------
function countdown(g) {
  if (!g.date) return "";
  const end = new Date((g.date.length === 7 ? g.date + "-01" : g.date) + "T12:00:00Z");
  const w = Math.round((end - new Date(C.today() + "T12:00:00Z")) / (7 * 864e5));
  const when = new Intl.DateTimeFormat("nl-BE", { month: "long", year: "numeric", timeZone: "UTC" }).format(end);
  return w > 0 ? `nog ${w} weken · ${when}` : w === 0 ? `deze week` : `${when} (voorbij)`;
}
export async function renderGoals(ctx, el, { compact = false } = {}) {
  C = ctx;
  const p = await loadPrefs();
  if (compact && !p.goals.length) { el.innerHTML = ""; return; }
  // Krachtdoel: oefening + doel-1RM; voortgang uit je records (geschatte 1RM)
  const recs = p.goals.some((g) => g.exercise) ? await C.rpc("get_records").catch(() => []) : [];
  const liftOf = (g) => (recs || []).find((r) => r.exercise === g.exercise);
  const progress = (g) => {
    if (!g.exercise || !g.target_kg) return "";
    const cur = Number(liftOf(g)?.best_1rm?.value) || 0, pct = Math.min(100, Math.round((cur / g.target_kg) * 100));
    return `<div class="goal-bar" role="img" aria-label="${pct}% van je doel"><i style="width:${pct}%"></i></div>
      <span class="small">${C.esc(clean(g.exercise))}: ${cur ? `${C.fmt(cur, 1)} kg` : "nog geen set"} van ${C.fmt(g.target_kg, 1)} kg 1RM${cur >= g.target_kg ? " · gehaald!" : cur ? ` · nog ${C.fmt(g.target_kg - cur, 1)} kg` : ""}</span>`;
  };
  el.innerHTML = `<section class="panel goals-card">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Mijn doelen</h3>
      ${compact ? `<a class="small muted" href="#/planner">Planner ›</a>` : `<button class="btn ghost small" id="gEdit">Bewerken</button>`}</div>
    ${p.goals.length ? `<div class="goal-list">${p.goals.map((g) => `<div class="goal"><b>${C.esc(g.title)}</b>
        <span class="small muted">${C.esc(label(GOALKIND, g.kind))}${g.date ? ` · ${C.esc(countdown(g))}` : ""}</span>${progress(g)}</div>`).join("")}</div>`
      : `<p class="small muted" style="margin:6px 0 0">Nog geen doelen. Voeg er een toe, bv. "Halve marathon" tegen juni 2027. Je coach plant er rekening mee.</p>`}
  </section>`;
  el.querySelector("#gEdit")?.addEventListener("click", () => editGoals(p, () => renderGoals(ctx, el)));
}
function editGoals(p, after) {
  const s = sheet("Doelen", `
    <div id="gl">${p.goals.map((g, i) => `<div class="pl-goal"><span><b>${C.esc(g.title)}</b><small>${C.esc(label(GOALKIND, g.kind))}${g.date ? ` · ${C.esc(g.date)}` : ""}</small></span>
      <button class="icon-btn" data-gdel="${i}" aria-label="Verwijderen">✕</button></div>`).join("") || `<p class="small muted">Nog geen doelen.</p>`}</div>
    <div class="pl-goalform">
      <input class="input" id="gT" placeholder="bv. Halve marathon in 2 uur" aria-label="Doel">
      <div class="row"><select class="input" id="gK" aria-label="Soort doel">${GOALKIND.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <input class="input" id="gD" type="month" aria-label="Tegen wanneer"></div>
      <div class="row" id="gLift" hidden><select class="input" id="gX" aria-label="Oefening"><option value="">Oefening (optioneel)</option></select>
        <input class="input" id="gKg" inputmode="decimal" placeholder="doel 1RM (kg)" aria-label="Doel 1RM in kg" style="max-width:150px"></div>
      <button class="btn" id="gAdd">Doel toevoegen</button>
    </div>`);
  const kSel = s.querySelector("#gK");
  const showLift = async () => {
    s.querySelector("#gLift").hidden = kSel.value !== "kracht";
    if (kSel.value === "kracht" && s.querySelector("#gX").options.length < 2) {
      const recs = await C.rpc("get_records").catch(() => []);
      s.querySelector("#gX").insertAdjacentHTML("beforeend", (recs || []).map((r) => `<option value="${C.esc(r.exercise)}">${C.esc(clean(r.exercise))} · nu ${C.fmt(r.best_1rm?.value, 1)} kg</option>`).join(""));
    }
  };
  kSel.onchange = showLift;
  s.querySelector("#gAdd").onclick = async () => {
    const t = s.querySelector("#gT").value.trim(); if (!t) return C.toast("Geef je doel een naam");
    const g = { title: t, kind: kSel.value, date: s.querySelector("#gD").value || null };
    const ex = s.querySelector("#gX").value, kg = Number(s.querySelector("#gKg").value.replace(",", "."));
    if (g.kind === "kracht" && ex && kg > 0) { g.exercise = ex; g.target_kg = kg; }
    p.goals.push(g);
    await savePrefs(p); s.remove(); C.toast("Doel toegevoegd"); after();
  };
  s.querySelectorAll("[data-gdel]").forEach((b) => (b.onclick = async () => {
    p.goals.splice(Number(b.dataset.gdel), 1); await savePrefs(p); s.remove(); after();
  }));
}

// ---------- planner ----------
export async function renderPlanner(ctx, start) {
  C = ctx;
  const from = start || monday(C.today());
  const days = Array.from({ length: 7 }, (_, i) => C.addDays(from, i));
  const today = C.today();
  const premium = document.body.dataset.plan !== "free";
  const [p, R, stats] = await Promise.all([loadPrefs(), C.rpc("get_workout_routines").catch(() => ({ folders: [], routines: [] })),
    premium ? C.rpc("get_run_stats").catch(() => ({})) : {}]);
  TARGETS = premium ? p.targets || {} : {};
  const rp = premium && p.run_plan?.date && p.run_plan.date >= today ? p.run_plan : null;
  const plan = rp ? RP.buildRunPlan(rp, stats, today) : null;
  const pw = plan?.weeks.find((w) => w.start === from) || null;
  const isRun = (x) => x.cat === "cardio" && x.cardio_type === "lopen";
  let list = await C.rpc("get_coach_week", { p_from: from }).catch(() => []);
  const cal = from <= today ? await C.rpc("get_calendar", { p_from: from, p_to: days[6] < today ? days[6] : today }).catch(() => []) : [];
  const did = new Map((cal || []).map((c) => [c.day, c]));
  const hasDone = (d, cat) => { const c = did.get(d); return !!c && (cat === "kracht" ? c.strength > 0 : cat === "cardio" ? c.cardio > 0 : false); };

  // 1. Week invullen vanuit het vaste schema (alleen vandaag en later; eigen of coach-sessies gaan voor).
  //    Staat automatisch plannen uit (p.auto === false), dan plan je alles zelf en vult de app niets in.
  const auto = p.auto !== false;
  let changed = false;
  for (let i = 0; auto && i < 7; i++) {
    const d = days[i]; if (d < today) continue;
    const day = list.filter((s) => s.day === d);
    const isAuto = (s) => (s.source === "planner" || s.source === "runplan") && s.status === "gepland";
    const auto = day.filter(isAuto);
    const own = day.filter((s) => !isAuto(s));
    const runs = (pw?.sessions || []).filter((x) => x.dow === i).map((x) => ({ cat: "cardio", cardio_type: "lopen", intensity: x.type, duration: x.min,
      title: x.title, details: RP.sessionDetails(x, stats), runplan: true }));
    const want = own.length ? [] : [...(p.template[i] || []).filter((x) => !(rp && isRun(x))), ...runs];
    const have = auto.map((s) => sig(catOf(s), s.title, s.duration_min) + "|" + (s.details || "")).sort().join(";");
    const tOf = (x) => (x.runplan ? x.title : slotTitle(x, R));
    const need = want.map((x) => sig(x.cat, tOf(x), x.duration) + "|" + ((x.runplan ? x.details : slotDetails(x, R)) || "")).sort().join(";");
    if (have === need) continue;
    for (const s of auto) await C.rpc("save_coach_session", { p: { id: s.id, delete: true } });
    for (const x of want) await C.rpc("save_coach_session", { p: { day: d, category: x.cat, title: tOf(x), routine_id: x.routine_id || "",
      cardio_type: x.cat === "cardio" ? x.cardio_type : null, duration_min: x.duration || null, details: x.runplan ? x.details : slotDetails(x, R),
      source: x.runplan ? "runplan" : "planner" } });
    changed = true;
  }
  // 2. Echte trainingen herkennen: afvinken, ook als je een dag schoof
  const missed = [];
  for (const s of list.filter((x) => x.status === "gepland" && x.day <= today)) {
    const cat = catOf(s); if (cat === "rust") continue;
    if (hasDone(s.day, cat)) { await C.rpc("set_coach_status", { p_id: s.id, p_status: "gedaan", p_note: null }); changed = true; continue; }
    if (s.day === today) continue;
    const i = days.indexOf(s.day);
    const alt = [i - 1, i + 1, i + 2, i - 2].map((j) => days[j]).find((d) => d && d <= today && hasDone(d, cat)
      && !list.some((o) => o.day === d && catOf(o) === cat && o.id !== s.id));
    if (alt) {
      await C.rpc("save_coach_session", { p: { id: s.id, day: alt, category: cat, source: s.source || "user" } });
      await C.rpc("set_coach_status", { p_id: s.id, p_status: "gedaan", p_note: `gedaan op ${WDL[days.indexOf(alt)]}` }); changed = true;
    } else missed.push(s);
  }
  if (changed) list = await C.rpc("get_coach_week", { p_from: from }).catch(() => list);
  // Optioneel: je eigen agenda (Instellingen → Agenda koppelen). Drukke dagen tonen en niet kiezen om in te halen.
  const busyRows = await C.rpc("get_calendar_busy", { p_from: from, p_to: days[6] }).catch(() => []);
  const hm = (t) => new Date(t).toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" });
  const busyOf = (d) => {
    const r = (busyRows || []).filter((b) => b.day === d); if (!r.length) return null;
    const timed = r.filter((b) => !b.all_day);
    const min = timed.reduce((a, b) => a + (new Date(b.end) - new Date(b.start)) / 60000, 0);
    const late = timed.some((b) => Number(hm(b.end).slice(0, 2)) >= 19);
    return { r, timed, allDay: r.filter((b) => b.all_day), min, heavy: min >= 360 || late || r.some((b) => b.all_day) };
  };
  const freeDay = (cat) => days.find((d) => d >= today && !busyOf(d)?.heavy && !list.some((s) => s.day === d && catOf(s) === cat))
    || days.find((d) => d >= today && !list.some((s) => s.day === d && catOf(s) === cat));
  const busyHtml = (d) => {
    const b = busyOf(d); if (!b) return "";
    const span = b.timed.length ? `${hm(b.timed[0].start)}–${hm(b.timed.reduce((m, x) => (x.end > m ? x.end : m), b.timed[0].end))}` : "";
    const head = [b.allDay.map((x) => x.title).join(", "), span, b.timed.length ? `${b.timed.length} afspra${b.timed.length === 1 ? "ak" : "ken"}` : ""].filter(Boolean).join(" · ");
    return `<details class="pl-busy ${b.heavy ? "heavy" : ""}"><summary>${b.heavy ? "Drukke dag · " : "Agenda · "}${C.esc(head)}</summary>
      <ul>${b.r.map((x) => `<li>${x.all_day ? "hele dag" : `${hm(x.start)}–${hm(x.end)}`} ${C.esc(x.title || "Bezet")}</li>`).join("")}</ul>
      ${b.heavy && list.some((s) => s.day === d && s.status === "gepland" && catOf(s) !== "rust") ? `<p class="small muted">Tip: maak het korter of schuif het naar een rustigere dag.</p>` : ""}</details>`;
  };

  const fmtRange = new Intl.DateTimeFormat("nl-BE", { day: "numeric", month: "short", timeZone: "UTC" }).formatRange(new Date(from + "T12:00:00Z"), new Date(days[6] + "T12:00:00Z"));
  const kracht = list.filter((s) => catOf(s) === "kracht"), cardio = list.filter((s) => catOf(s) === "cardio");
  const doneN = (a) => a.filter((s) => s.status === "gedaan").length;
  const sessRow = (s) => `<div class="pl-sess ${catOf(s)} ${s.status}" data-id="${s.id}">
      <span class="pl-k"></span>
      <span class="pl-t"><b>${C.esc(clean(s.title))}</b><small>${[s.duration_min ? `${s.duration_min} min` : "", s.status === "gedaan" ? (s.note && /^gedaan op/.test(s.note) ? s.note : "gedaan") : s.status === "overgeslagen" ? "overgeslagen" : "", s.source === "planner" ? "" : s.source === "runplan" ? "loopplan" : s.source === "user" ? "aangepast" : "coach"].filter(Boolean).join(" · ")}</small></span>
      ${s.routine_id && s.day === today && s.status === "gepland" ? `<button class="btn small" data-go="${s.id}">Start</button>` : ""}
      <button class="icon-btn" data-edit="${s.id}" aria-label="Aanpassen">⋯</button></div>`;

  C.view.innerHTML = `
    <div id="plGoals"></div>
    <section class="panel pl-head">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap">
        <button class="wnav" data-w="-7" aria-label="Vorige week">‹</button>
        <div style="text-align:center"><h2 style="margin:0">Deze week</h2><span class="small muted">${C.esc(fmtRange)}</span></div>
        <button class="wnav" data-w="7" aria-label="Volgende week">›</button>
      </div>
      <div class="pl-sum"><span><b>${doneN(kracht)}/${kracht.length}</b> kracht</span><span><b>${doneN(cardio)}/${cardio.length}</b> cardio</span></div>
    </section>
    ${missed.map((s) => { const fd = freeDay(catOf(s)); return `<div class="panel pl-missed" data-id="${s.id}">
      <span><b>${C.esc(clean(s.title))}</b> van ${WDL[days.indexOf(s.day)]} is nog niet gedaan.</span>
      <div class="row">${fd ? `<button class="btn small" data-move="${s.id}" data-to="${fd}">Inhalen op ${WDL[days.indexOf(fd)]}</button>` : ""}
        <button class="btn ghost small" data-skip="${s.id}">Overslaan</button></div></div>`; }).join("")}
    <div class="pl-week">${days.map((d, i) => {
      const items = list.filter((s) => s.day === d);
      return `<section class="pl-day ${d === today ? "today" : ""} ${d < today ? "past" : ""}">
        <header><b>${WDL[i]}</b> <span class="muted small">${new Date(d + "T12:00:00Z").getUTCDate()}</span></header>
        ${busyHtml(d)}
        ${items.map(sessRow).join("") || `<p class="small muted pl-empty">${[hasDone(d, "kracht") ? "krachttraining gedaan ✓" : "", hasDone(d, "cardio") ? "cardio gedaan ✓" : ""].filter(Boolean).join(" · ") || "rust"}</p>`}
        ${d >= today ? `<button class="pl-add" data-add="${d}">+ sessie deze week</button>` : ""}
      </section>`;
    }).join("")}</div>

    <section class="panel">
      <label class="row" style="justify-content:space-between;flex-wrap:nowrap;gap:12px;cursor:pointer">
        <span><b>Automatisch plannen</b><br><span class="small muted">${auto ? "De app vult elke week in met je vaste weekschema" + (premium ? " en loopplan" : "") + "." : "Uit: je plant zelf met “+ sessie”. Je trainingen worden nog altijd afgevinkt."}</span></span>
        <input type="checkbox" id="plAuto" ${auto ? "checked" : ""} style="width:22px;height:22px;flex:none" aria-label="Automatisch plannen"></label>
    </section>
    ${auto ? `<div id="runPlanBox" data-premium></div>
    <section class="panel">
      <h3 style="margin:0 0 4px">Vast weekschema</h3>
      <p class="small muted" style="margin:0 0 10px">Wat je de meeste weken doet. Elke week wordt hier automatisch mee ingevuld. Cardio kan per dag anders zijn.</p>
      <div class="tpl-rows">${WDL.map((w, i) => `<button class="tpl-row" data-tday="${i}"><span class="tpl-d">${WDS[i]}</span>
        <span class="tpl-s">${(p.template[i] || []).map((x) => `<span class="tpl-chip ${x.cat}">${C.esc(slotTitle(x, R))}${x.duration ? ` · ${x.duration}′` : ""}</span>`).join("") || `<span class="muted small">rust</span>`}</span>
        <span aria-hidden="true">›</span></button>`).join("")}</div>
    </section>` : ""}`;

  renderGoals(ctx, C.view.querySelector("#plGoals"));
  if (premium && auto) renderRunPlan(p, rp, plan, stats, from, () => renderPlanner(ctx, from));
  const rerender = () => renderPlanner(ctx, from);
  C.view.querySelector("#plAuto").onchange = async (e) => {
    const on = e.target.checked;
    if (!on) {
      const fut = list.filter((s) => s.day >= today && s.status === "gepland" && (s.source === "planner" || s.source === "runplan"));
      if (fut.length && confirm(`De ${fut.length} automatisch geplande sessie(s) vanaf vandaag ook weghalen? (Annuleren = laten staan)`))
        for (const s of fut) await C.rpc("save_coach_session", { p: { id: s.id, delete: true } });
      // laten staan = ze worden gewone sessies die je zelf beheert
      else for (const s of fut) await C.rpc("save_coach_session", { p: { id: s.id, day: s.day, category: catOf(s), source: "user" } });
    }
    p.auto = on; await savePrefs(p);
    C.toast(on ? "Automatisch plannen staat aan" : "Je plant nu zelf"); rerender();
  };
  C.view.querySelectorAll(".wnav").forEach((b) => (b.onclick = () => renderPlanner(ctx, C.addDays(from, Number(b.dataset.w)))));
  C.view.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editSession(list.find((s) => String(s.id) === b.dataset.edit), days, R, rerender)));
  C.view.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => editSession({ day: b.dataset.add }, days, R, rerender)));
  C.view.querySelectorAll("[data-go]").forEach((b) => (b.onclick = async () => {
    const s = list.find((x) => String(x.id) === b.dataset.go);
    const tpl = (R.routines || []).find((r) => r.id === s.routine_id);
    (await import("./workout.js")).startWorkout(C, tpl ? { template: tpl } : {});
  }));
  C.view.querySelectorAll("[data-move]").forEach((b) => (b.onclick = async () => {
    const s = list.find((x) => String(x.id) === b.dataset.move);
    await C.rpc("save_coach_session", { p: { id: s.id, day: b.dataset.to, category: catOf(s), source: "user" } }); C.toast("Verplaatst"); rerender();
  }));
  C.view.querySelectorAll("[data-skip]").forEach((b) => (b.onclick = async () => {
    await C.rpc("set_coach_status", { p_id: Number(b.dataset.skip), p_status: "overgeslagen", p_note: null }); rerender();
  }));
  C.view.querySelectorAll("[data-tday]").forEach((b) => (b.onclick = () => editTemplateDay(p, Number(b.dataset.tday), R, rerender)));
}

function sheet(title, body) {
  const s = document.createElement("div");
  s.className = "sheet";
  s.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${title}">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${title}</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div><div style="margin-top:10px">${body}</div></div>`;
  document.body.appendChild(s);
  s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) s.remove(); });
  return s;
}

// formulier voor één sessie (kracht of cardio); gedeeld door schema en week
function slotForm(x, R) {
  const cat = x.cat || "kracht";
  return `<div class="seg" style="margin-bottom:10px" role="group">${[["kracht", "Kracht"], ["cardio", "Cardio"]].map(([k, l]) => `<button type="button" data-cat="${k}" aria-pressed="${cat === k}">${l}</button>`).join("")}</div>
    <div data-k ${cat === "kracht" ? "" : "hidden"}><div class="field"><label>Routine</label><select class="input" data-f="routine">
      <option value="">Zonder routine</option>${(R.routines || []).map((r) => `<option value="${r.id}" ${r.id === x.routine_id ? "selected" : ""}>${C.esc(r.name)}</option>`).join("")}</select></div></div>
    <div data-c ${cat === "cardio" ? "" : "hidden"}>
      <div class="field"><label>Soort</label><select class="input" data-f="type">${CARDIO.map(([k, l]) => `<option value="${k}" ${k === x.cardio_type ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label>Intensiteit</label><select class="input" data-f="int">${INTENS.map(([k, l]) => `<option value="${k}" ${k === (x.intensity || "zone 2") ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label>Duur (min)</label><input class="input" data-f="dur" type="number" min="5" max="300" step="5" value="${x.duration || (cat === "cardio" ? 40 : 75)}"></div>`;
}
function bindSlotForm(root) {
  let cat = root.querySelector('[data-cat][aria-pressed="true"]')?.dataset.cat || "kracht";
  root.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => {
    cat = b.dataset.cat; root.querySelectorAll("[data-cat]").forEach((y) => y.setAttribute("aria-pressed", String(y === b)));
    root.querySelector("[data-k]").hidden = cat !== "kracht"; root.querySelector("[data-c]").hidden = cat !== "cardio";
    root.querySelector('[data-f="dur"]').value = cat === "cardio" ? 40 : 75;
  }));
  return () => ({ cat, routine_id: cat === "kracht" ? root.querySelector('[data-f="routine"]').value || null : null,
    cardio_type: cat === "cardio" ? root.querySelector('[data-f="type"]').value : null,
    intensity: cat === "cardio" ? root.querySelector('[data-f="int"]').value : null,
    duration: Number(root.querySelector('[data-f="dur"]').value) || null });
}

function editTemplateDay(p, i, R, after) {
  const slots = [...(p.template[i] || [])];
  const s = sheet(`Elke ${WDL[i]}`, `<div id="tSlots"></div>
    <details class="tpl-add" ${slots.length ? "" : "open"}><summary class="btn secondary" style="display:block;text-align:center">+ Sessie toevoegen</summary>
      <div class="tpl-form" style="margin-top:10px">${slotForm({}, R)}<button class="btn" id="tAdd">Toevoegen</button></div></details>
    <div class="row" style="margin-top:12px"><button class="btn" id="tSave">Opslaan</button><button class="btn ghost" id="tRest">Rustdag</button></div>
    <p class="small muted" style="margin:8px 0 0">Geldt voor deze week (vanaf vandaag) en alle volgende weken.</p>`);
  const draw = () => {
    s.querySelector("#tSlots").innerHTML = slots.map((x, j) => `<div class="pl-sess ${x.cat}"><span class="pl-k"></span>
      <span class="pl-t"><b>${C.esc(slotTitle(x, R))}</b><small>${x.duration ? `${x.duration} min` : ""}</small></span>
      <button class="icon-btn" data-rm="${j}" aria-label="Verwijderen">✕</button></div>`).join("") || `<p class="small muted">Rustdag.</p>`;
    s.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { slots.splice(Number(b.dataset.rm), 1); draw(); }));
  };
  draw();
  const read = bindSlotForm(s.querySelector(".tpl-form"));
  s.querySelector("#tAdd").onclick = () => { const x = read(); x.title = slotTitle(x, R); slots.push(x); draw(); s.querySelector(".tpl-add").open = false; };
  const save = async (v) => { p.template[i] = v; await savePrefs(p); s.remove(); C.toast("Weekschema opgeslagen"); after(); };
  s.querySelector("#tSave").onclick = () => save(slots);
  s.querySelector("#tRest").onclick = () => save([]);
}

function editSession(sess, days, R, after) {
  const x = { cat: sess.id ? catOf(sess) : "kracht", routine_id: sess.routine_id, cardio_type: sess.cardio_type, duration: sess.duration_min,
    intensity: (INTENS.find(([k]) => (sess.title || "").includes(k)) || [])[0] };
  const s = sheet(sess.id ? C.esc(clean(sess.title)) : "Sessie toevoegen", `
    <div class="field"><label for="eDay">Dag</label><select class="input" id="eDay">${days.map((d, i) => `<option value="${d}" ${d === sess.day ? "selected" : ""}>${WDL[i]} ${new Date(d + "T12:00:00Z").getUTCDate()}</option>`).join("")}</select></div>
    <div class="tpl-form">${slotForm(x, R)}</div>
    ${sess.id && sess.status === "gepland" && sess.day <= C.today() ? `<div class="row" style="margin:6px 0"><button class="btn secondary" id="eDone">Gedaan</button><button class="btn ghost" id="eSkip">Overgeslagen</button></div>` : ""}
    <div class="row" style="margin-top:10px"><button class="btn" id="eSave">Opslaan</button>${sess.id ? `<button class="btn danger" id="eDel">Verwijderen</button>` : ""}</div>
    <p class="small muted" style="margin:8px 0 0">Alleen voor deze week. Je vaste weekschema verander je onderaan de planner.</p>`);
  const read = bindSlotForm(s.querySelector(".tpl-form"));
  s.querySelector("#eSave").onclick = async () => {
    const v = read();
    const p = { id: sess.id || undefined, day: s.querySelector("#eDay").value, category: v.cat, title: slotTitle(v, R), duration_min: v.duration,
      routine_id: v.routine_id || "", cardio_type: v.cardio_type, details: slotDetails(v, R), source: "user" };
    try { await C.rpc("save_coach_session", { p }); s.remove(); C.toast("Opgeslagen"); after(); } catch (e) { C.toast(e.message, 5000); }
  };
  const st = async (v) => { await C.rpc("set_coach_status", { p_id: sess.id, p_status: v, p_note: null }); s.remove(); after(); };
  s.querySelector("#eDone")?.addEventListener("click", () => st("gedaan"));
  s.querySelector("#eSkip")?.addEventListener("click", () => st("overgeslagen"));
  s.querySelector("#eDel")?.addEventListener("click", async () => {
    if (!confirm("Deze sessie verwijderen voor deze week?")) return;
    await C.rpc("save_coach_session", { p: { id: sess.id, delete: true } });
    // een sessie uit het schema weghalen = bewust rust die dag (anders vult het schema ze opnieuw in)
    if (sess.source === "planner") await C.rpc("save_coach_session", { p: { day: sess.day, category: "rust", title: "Rust", source: "user" } });
    s.remove(); after();
  });
}

// ---------- Loopplan (Premium) ----------
function renderRunPlan(p, rp, plan, stats, from, after) {
  const box = C.view.querySelector("#runPlanBox"); if (!box) return;
  const fmtD = (iso) => new Intl.DateTimeFormat("nl-BE", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(iso + "T12:00:00Z"));
  if (!rp) {
    box.innerHTML = `<section class="panel runplan"><h3 style="margin:0 0 4px">Loopplan naar een wedstrijd</h3>
      <p class="small muted" style="margin:0 0 10px">Een schema van nu tot je wedstrijd, opgebouwd vanuit je echte runs (${stats.avg_week_min_4w || 0} min per week, langste ${stats.longest_min_4w || 0} min). Je coach past het elke week aan op hoe je runs gingen.</p>
      <div class="field"><label for="rRace">Wedstrijd</label><select class="input" id="rRace">${RP.RACES.map(([k, l]) => `<option value="${k}" ${k === "hm" ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="rDate">Datum</label><input class="input" id="rDate" type="date" min="${C.addDays(C.today(), 21)}"></div>
      <div class="row"><label class="field" style="flex:1"><span class="small muted">Runs per week</span><select class="input" id="rN">${[2, 3, 4, 5].map((n) => `<option ${n === 3 ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="field" style="flex:1"><span class="small muted">Lange duurloop op</span><select class="input" id="rL">${RP.WDL.map((w, i) => `<option value="${i}" ${i === 6 ? "selected" : ""}>${w}</option>`).join("")}</select></label></div>
      <div class="field"><label for="rT">Doeltijd (optioneel)</label><input class="input" id="rT" placeholder="bv. 2:15:00"></div>
      <button class="btn" id="rMake">Maak mijn loopplan</button></section>`;
    box.querySelector("#rMake").onclick = async () => {
      const date = box.querySelector("#rDate").value; if (!date) return C.toast("Kies de datum van je wedstrijd");
      p.run_plan = { race: box.querySelector("#rRace").value, date, runs_per_week: Number(box.querySelector("#rN").value),
        long_day: Number(box.querySelector("#rL").value), target_time: box.querySelector("#rT").value.trim() || null, created: C.today(), adjust: {},
        base_week_min: stats.avg_week_min_4w || 0, base_long_min: stats.longest_min_4w || 0 };
      const race = RP.RACES.find((r) => r[0] === p.run_plan.race);
      if (!p.goals.some((g) => g.kind === "uithouding")) p.goals.push({ title: race[1], kind: "uithouding", date: date.slice(0, 7) });
      await savePrefs(p); C.toast("Loopplan gemaakt"); after();
    };
    return;
  }
  const cur = plan.weeks.find((w) => w.start === from) || plan.weeks[0];
  const max = Math.max(...plan.weeks.map((w) => w.total));
  box.innerHTML = `<section class="panel runplan">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${C.esc(plan.race[1])} · ${C.esc(fmtD(rp.date))}</h3>
      <button class="btn ghost small" id="rStop">Stoppen</button></div>
    <p class="small muted" style="margin:4px 0 8px">Week ${cur.i + 1} van ${plan.n} · ${C.esc(RP.PHASE_TXT[cur.phase])}${cur.recovery ? " Herstelweek: wat minder." : ""}</p>
    <div class="rp-bars" role="img" aria-label="Omvang per week tot de wedstrijd">${plan.weeks.map((w) => `<i class="${w.phase} ${w.i === cur.i ? "cur" : ""}" style="height:${Math.max(8, (w.total / max) * 100)}%" title="Week ${w.i + 1}: ${w.total} min"></i>`).join("")}</div>
    <div class="rp-legend small muted"><span class="basis">basis</span><span class="opbouw">opbouw</span><span class="piek">piek</span><span class="taper">taper</span></div>
    <h4 class="sub-h">Deze week · ${cur.total} min lopen</h4>
    ${cur.sessions.map((s, i) => `<div class="meal"><span><b>${C.esc(s.title)}</b><br><span class="small muted">${RP.WDL[s.dow]} · ${C.esc(RP.sessionDetails(s, stats))}</span></span><span class="k">${s.min}′<br><button class="link-btn inline small" data-fit="${i}" aria-label="${C.esc(s.title)} als Garmin-bestand">⌚ .FIT</button></span></div>`).join("")}
    <details class="small" style="margin-top:6px"><summary>Runs op je Garmin zetten</summary>
      <p style="margin:6px 0 0">Tik op ⌚ .FIT: je krijgt een Garmin-workout met de stappen en je hartslagzone, zodat je horloge je begeleidt. Sluit je horloge met een kabel aan op een computer en zet het bestand in de map <b>GARMIN/NewFiles</b>; na het loskoppelen staat de run bij Training → Workouts. Op een Mac heb je daarvoor het gratis OpenMTP nodig. Vanaf je iPhone kan het niet rechtstreeks: Garmin laat dat alleen toe voor goedgekeurde partners.</p></details>
    ${cur.note ? `<p class="small" style="margin:8px 0 0"><b>Coach:</b> ${C.esc(cur.note)}</p>` : ""}
    ${(() => {
      const pr = RP.predictRace(stats.runs, plan.race[2]); if (!pr) return "";
      const goal = RP.parseTime(rp.target_time);
      const rng = ([a, b]) => `${RP.fmtPace(a)}–${RP.fmtPace(b)}`;
      return `<h4 class="sub-h">Voorspelling</h4>
        <p style="margin:0">Als je vandaag een ${C.esc(plan.race[1].toLowerCase())} loopt: <b>± ${RP.fmtTime(pr.sec)}</b> (${RP.fmtPace(pr.sec / plan.race[2])} /km).</p>
        ${goal ? `<p class="small" style="margin:4px 0 0">Doeltijd ${RP.fmtTime(goal)} = ${RP.fmtPace(goal / plan.race[2])} /km · ${goal >= pr.sec ? "haalbaar met wat je nu loopt" : `nog ${RP.fmtTime(pr.sec - goal)} sneller dan nu`}.</p>` : ""}
        <p class="small muted" style="margin:4px 0 8px">Berekend uit je snelste recente run (${C.fmt(pr.from.km, 1)} km in ${C.fmt(pr.from.min)} min, ${C.esc(fmtD(pr.from.day))}). Alleen rustige runs of run-walks geven een voorzichtige schatting.</p>
        <div class="rp-paces small"><span><b>Rustig</b> ${rng(pr.paces.rustig)} /km</span><span><b>Tempo</b> ${rng(pr.paces.tempo)} /km</span><span><b>Interval</b> ${rng(pr.paces.interval)} /km</span></div>
        <p class="small muted" style="margin:6px 0 0">Richttempo's; je hartslagzones gaan voor bij de rustige runs.</p>`;
    })()}
    <details style="margin-top:10px"><summary class="small">Je runs van de laatste weken</summary>
      <table class="nutrients small">${(stats.runs || []).slice(0, 8).map((r) => `<tr><td>${C.esc(fmtD(r.day))}</td><td>${C.fmt(r.km, 1)} km · ${C.fmt(r.min)} min</td><td>${r.hr ? `${r.hr} bpm` : ""}</td></tr>`).join("") || "<tr><td>Nog geen runs.</td></tr>"}</table></details>
  </section>`;
  box.querySelectorAll("[data-fit]").forEach((b) => (b.onclick = async () => {
    const s = cur.sessions[Number(b.dataset.fit)];
    const F = await import("./fit.js");
    F.downloadFit(`${s.title} ${RP.WDL[s.dow].slice(0, 2)} ${s.min}min`, F.runSteps(s));
    C.toast("Garmin-bestand gedownload");
  }));
  box.querySelector("#rStop").onclick = async () => {
    if (!confirm("Loopplan stoppen? De geplande runs verdwijnen uit je komende dagen.")) return;
    delete p.run_plan; await savePrefs(p); after();
  };
}
