// Krachttraining loggen in Health Hub (zoals Hevy):
// schema's, vorige waarden, settypes, records, rusttimer met pushmelding.
let C; // gedeelde helpers uit app.js
const KEY = "hh_active_workout";

export const MUSCLES = {
  chest: "Borst", lats: "Lats", upper_back: "Bovenrug", lower_back: "Onderrug", traps: "Trapezius",
  shoulders: "Schouders", biceps: "Biceps", triceps: "Triceps", forearms: "Onderarmen",
  quadriceps: "Quadriceps", hamstrings: "Hamstrings", glutes: "Bilspieren", calves: "Kuiten",
  abductors: "Abductoren", adductors: "Adductoren", abdominals: "Buikspieren", full_body: "Volledig lichaam", cardio: "Cardio", other: "Andere",
};

const BUILTIN = [
  ["Bench Press (Barbell)", "chest"], ["Incline Bench Press (Dumbbell)", "chest"], ["Bench Press (Dumbbell)", "chest"],
  ["Chest Fly (Machine)", "chest"], ["Chest Press (Machine)", "chest"], ["Cable Fly Crossovers", "chest"], ["Push Up", "chest"],
  ["Dips", "triceps"], ["Pull Up", "lats"], ["Chin Up", "lats"], ["Lat Pulldown (Cable)", "lats"], ["Seated Cable Row - V Grip (Cable)", "upper_back"],
  ["Bent Over Row (Barbell)", "upper_back"], ["Dumbbell Row", "upper_back"], ["Iso-Lateral Row (Machine)", "upper_back"],
  ["T Bar Row", "upper_back"], ["Face Pull", "shoulders"], ["Overhead Press (Barbell)", "shoulders"],
  ["Shoulder Press (Dumbbell)", "shoulders"], ["Shoulder Press (Machine)", "shoulders"], ["Lateral Raise (Dumbbell)", "shoulders"],
  ["Lateral Raise (Cable)", "shoulders"], ["Rear Delt Reverse Fly (Machine)", "shoulders"], ["Shrug (Dumbbell)", "traps"],
  ["Bicep Curl (Barbell)", "biceps"], ["Bicep Curl (Dumbbell)", "biceps"], ["Hammer Curl (Dumbbell)", "biceps"],
  ["Preacher Curl (Machine)", "biceps"], ["Bicep Curl (Cable)", "biceps"], ["Triceps Pushdown", "triceps"],
  ["Single Arm Triceps Pushdown (Cable)", "triceps"], ["Triceps Extension (Cable)", "triceps"], ["Skullcrusher (Barbell)", "triceps"],
  ["Overhead Triceps Extension (Cable)", "triceps"], ["Squat (Barbell)", "quadriceps"], ["Front Squat", "quadriceps"],
  ["Leg Press (Machine)", "quadriceps"], ["Hack Squat (Machine)", "quadriceps"], ["Leg Extension (Machine)", "quadriceps"],
  ["Bulgarian Split Squat", "quadriceps"], ["Lunge (Dumbbell)", "quadriceps"], ["Romanian Deadlift (Barbell)", "hamstrings"],
  ["Deadlift (Barbell)", "lower_back"], ["Seated Leg Curl (Machine)", "hamstrings"], ["Lying Leg Curl (Machine)", "hamstrings"],
  ["Hip Thrust (Barbell)", "glutes"], ["Hip Abduction (Machine)", "abductors"], ["Hip Adduction (Machine)", "adductors"],
  ["Standing Calf Raise (Machine)", "calves"], ["Seated Calf Raise", "calves"], ["Crunch", "abdominals"],
  ["Cable Crunch", "abdominals"], ["Hanging Leg Raise", "abdominals"], ["Plank", "abdominals"], ["Back Extension", "lower_back"],
];
const REST_OPTIONS = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300];
const SET_TYPES = { warmup: "W", normal: "", failure: "F", dropset: "D" };

// ---------------- opslag van de lopende training ----------------
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
const save = (w) => { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* privé-modus */ } };
const clear = () => { try { localStorage.removeItem(KEY); } catch { /* */ } };
export const activeWorkout = load;

const uuid = () => crypto.randomUUID();
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const restLabel = (s) => (s ? (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`) : "Uit");
const e1rm = (kg, reps) => (kg > 0 && reps >= 1 && reps <= 15 ? kg * (1 + reps / 30) : null);

let ctxCache = {};

// ---------------- progressie: voorstel voor vandaag ----------------
// Dubbele progressie: eerst herhalingen opbouwen binnen je bereik, dan zwaarder.
export function repRange(c) {
  if (c?.pref?.rep_min && c?.pref?.rep_max) return { min: c.pref.rep_min, max: c.pref.rep_max, own: true };
  const t = c?.typical;
  if (t?.rep_min && t?.rep_max) {
    const min = Math.max(1, Math.round(t.rep_min));
    return { min, max: Math.max(Math.round(t.rep_max), min + 2), own: false };
  }
  return { min: 8, max: 12, own: false };
}
export const incrementFor = (title, c) => Number(c?.pref?.increment_kg) || (/dumbbell/i.test(title) ? 2 : 2.5);
const roundKg = (v) => Math.round(v * 4) / 4;

export function suggestion(title) {
  const c = ctxCache[title];
  const work = (c?.last || []).filter((x) => x.type !== "warmup" && Number(x.reps) > 0);
  if (!work.length) return null;
  const { min, max } = repRange(c);
  const inc = incrementFor(title, c);
  const top = Math.max(...work.map((x) => Number(x.kg) || 0));
  if (top <= 0) { // lichaamsgewicht
    const reps = Math.min(...work.map((x) => Number(x.reps))) + 1;
    return { kg: null, reps, why: "1 herhaling meer dan je zwakste set vorige keer" };
  }
  const atTop = work.filter((x) => Number(x.kg) === top).map((x) => Number(x.reps));
  if (atTop.every((r) => r >= max)) return { kg: roundKg(top + inc), reps: min, why: `alle sets haalden ${max}+ → ${C.fmt(inc, 1)} kg zwaarder` };
  if (atTop.every((r) => r < min - 2)) return { kg: roundKg(Math.max(0, top - inc)), reps: min, why: `ver onder ${min} herhalingen → iets lichter` };
  if (atTop.every((r) => r < min)) return { kg: top, reps: min, why: `zelfde gewicht, mik op ${min} herhalingen` };
  return { kg: top, reps: Math.min(max, Math.min(...atTop) + 1), why: "zelfde gewicht, 1 herhaling meer" };
}
async function loadContext(titles) {
  const need = titles.filter((t) => !(t in ctxCache));
  if (need.length) Object.assign(ctxCache, await C.rpc("get_exercise_context", { p_titles: need }));
}

function newExercise(title, muscle, rest_s = 90, nSets = 3) {
  const last = ctxCache[title]?.last?.filter((s) => s.type !== "warmup") || [];
  const sets = [];
  for (let i = 0; i < Math.max(nSets, 1); i++) sets.push({ type: "normal", kg: "", reps: "", done: false });
  return { key: uuid(), title, muscle, rest_s, notes: "", sets, _lastCount: last.length };
}

// ---------------- start ----------------
export async function startWorkout(ctx, { template = null, repeatOf = null } = {}) {
  C = ctx;
  if (load() && !confirm("Er loopt al een training. Die vervangen?")) { location.hash = "#/workout"; return; }
  const w = { id: "hh-" + uuid(), title: "Training", start: Date.now(), exercises: [], template_id: null, timer: null };
  let list = [];
  if (template) {
    w.title = template.name;
    w.template_id = template.id;
    list = template.exercises || [];
    C.rpc("save_template", { p: { id: template.id, touch: true } }).catch(() => {});
  } else if (repeatOf) {
    const d = await C.rpc("get_hevy_workout", { p_id: repeatOf });
    w.title = d.workout?.title || "Training";
    list = (d.exercises || []).map((e) => ({ title: e.exercise, muscle: e.muscle, sets: (e.sets || []).filter((s) => s.type !== "warmup").length || 3 }));
  }
  ctxCache = {};
  if (list.length) await loadContext(list.map((e) => e.title));
  w.exercises = list.map((e) => newExercise(e.title, e.muscle, e.rest_s ?? 90, e.sets || 3));
  save(w);
  location.hash = "#/workout";
}

// ---------------- actieve training ----------------
let tick = null;
export async function renderWorkout(ctx) {
  C = ctx;
  const w = load();
  const view = C.view;
  clearInterval(tick);
  if (!w) {
    view.innerHTML = `<div class="empty"><strong>Geen actieve training.</strong>Start er een vanuit het tabblad Training.</div>`;
    return;
  }
  await loadContext(w.exercises.map((e) => e.title));
  draw();
  tick = setInterval(() => {
    const el = document.getElementById("wElapsed");
    if (!el) return clearInterval(tick);
    el.textContent = fmtDur(Date.now() - w.start);
    updateTimer();
  }, 1000);

  function persist() { save(w); }

  function stats() {
    let vol = 0, sets = 0;
    for (const e of w.exercises) for (const s of e.sets) if (s.done) { sets++; if (s.type !== "warmup") vol += (Number(s.kg) || 0) * (Number(s.reps) || 0); }
    return { vol, sets };
  }

  function setRow(e, s, i) {
    const last = (ctxCache[e.title]?.last || []);
    const prevSet = s.type === "warmup" ? last.filter((x) => x.type === "warmup")[i] : last.filter((x) => x.type !== "warmup")[normalIndex(e, i)];
    const prev = prevSet ? (prevSet.kg != null ? `${C.fmt(prevSet.kg, 1)} × ${prevSet.reps ?? "–"}` : prevSet.duration_s ? `${prevSet.duration_s}s` : "–") : "–";
    const n = s.type === "normal" ? normalIndex(e, i) + 1 : SET_TYPES[s.type];
    const best = ctxCache[e.title]?.best_1rm;
    const cur = e1rm(Number(s.kg), Number(s.reps));
    const pr = s.done && s.type !== "warmup" && cur && best && cur > best;
    const sug = s.type !== "warmup" ? suggestion(e.title) : null;
    const phKg = sug ? (sug.kg != null ? C.fmt(sug.kg, 2) : "kg") : prevSet?.kg != null ? C.fmt(prevSet.kg, 1) : "kg";
    const phReps = sug ? sug.reps : prevSet?.reps ?? "reps";
    return `<div class="wset ${s.done ? "done" : ""} t-${s.type}" data-e="${e.key}" data-i="${i}">
      <select class="wtype" aria-label="Settype">
        <option value="normal" ${s.type === "normal" ? "selected" : ""}>${s.type === "normal" ? n : "Normaal"}</option>
        <option value="warmup" ${s.type === "warmup" ? "selected" : ""}>${s.type === "warmup" ? "W" : "Opwarmset (W)"}</option>
        <option value="failure" ${s.type === "failure" ? "selected" : ""}>${s.type === "failure" ? "F" : "Tot falen (F)"}</option>
        <option value="dropset" ${s.type === "dropset" ? "selected" : ""}>${s.type === "dropset" ? "D" : "Dropset (D)"}</option>
        <option value="__del">Set verwijderen</option>
      </select>
      <button class="wprev" type="button" title="Vorige waarden overnemen" data-kg="${prevSet?.kg ?? ""}" data-reps="${prevSet?.reps ?? ""}">${C.esc(prev)}</button>
      <input class="input wkg" inputmode="decimal" placeholder="${C.esc(phKg)}" value="${C.esc(s.kg)}" aria-label="Gewicht in kg">
      <input class="input wreps" inputmode="numeric" placeholder="${C.esc(phReps)}" value="${C.esc(s.reps)}" aria-label="Herhalingen">
      <button class="wcheck" type="button" aria-pressed="${s.done}" aria-label="Set voltooid">${pr ? "🏆" : "✓"}</button>
    </div>`;
  }

  function sugLine(title) {
    const sg = suggestion(title);
    const rr = repRange(ctxCache[title]);
    return `<button class="wsug" type="button" data-pref="${C.esc(title)}" title="Bereik en stapgrootte aanpassen">
      ${sg ? `🎯 <b>${sg.kg != null ? C.fmt(sg.kg, 2) + " kg × " : ""}${sg.reps}</b> <span>${C.esc(sg.why)}</span>` : `🎯 <span>Eerste keer: kies een gewicht waarmee je ${rr.min}–${rr.max} herhalingen haalt</span>`}
      <span class="wsug-r">bereik ${rr.min}–${rr.max}${rr.own ? "" : " (auto)"} ✎</span></button>`;
  }

  function normalIndex(e, i) {
    let n = 0;
    for (let k = 0; k < i; k++) if (e.sets[k].type !== "warmup") n++;
    return n;
  }

  function exCard(e, idx) {
    const c = ctxCache[e.title] || {};
    return `<section class="panel wex" data-e="${e.key}">
      <div class="wex-head">
        <div><h3>${C.esc(e.title)}</h3>
          <div class="m small muted">${C.esc(MUSCLES[c.muscle || e.muscle] || c.muscle || e.muscle || "")}${c.best_1rm ? ` · record 1RM ≈ ${C.fmt(c.best_1rm, 1)} kg` : ""}</div>
          ${sugLine(e.title)}
          ${/barbell|smith|ez bar|t bar|landmine/i.test(e.title) ? `<button class="linkbtn wplates" type="button" data-t="${C.esc(e.title)}">🏋 Schijven berekenen</button>` : ""}</div>
        <select class="input wrest" aria-label="Rusttijd" title="Rusttijd">${REST_OPTIONS.map((r) => `<option value="${r}" ${r === e.rest_s ? "selected" : ""}>⏱ ${restLabel(r)}</option>`).join("")}</select>
      </div>
      <input class="input wnotes" placeholder="Notitie" value="${C.esc(e.notes)}" aria-label="Notitie">
      <div class="wset whead"><span>Set</span><span>Vorige</span><span>kg</span><span>Reps</span><span>✓</span></div>
      ${e.sets.map((s, i) => setRow(e, s, i)).join("")}
      <div class="row" style="margin-top:8px;justify-content:space-between">
        <button class="btn secondary wadd" type="button">+ Set</button>
        <span>
          ${idx > 0 ? `<button class="icon-btn wup" type="button" aria-label="Omhoog">↑</button>` : ""}
          ${idx < w.exercises.length - 1 ? `<button class="icon-btn wdown" type="button" aria-label="Omlaag">↓</button>` : ""}
          <button class="icon-btn wdel" type="button" aria-label="Oefening verwijderen">✕</button>
        </span>
      </div>
    </section>`;
  }

  function draw() {
    const st = stats();
    view.innerHTML = `
      <section class="panel whero">
        <input class="input wtitle" value="${C.esc(w.title)}" aria-label="Naam van de training">
        <div class="wstats">
          <div><b id="wElapsed">${fmtDur(Date.now() - w.start)}</b><span>duur</span></div>
          <div><b>${C.fmt(st.vol)}</b><span>kg volume</span></div>
          <div><b>${st.sets}</b><span>sets</span></div>
        </div>
        <div class="row">
          <button class="btn" id="wFinish" style="flex:1">Afronden</button>
          <button class="btn ghost" id="wCancel">Annuleren</button>
        </div>
      </section>
      <div id="wList">${w.exercises.map(exCard).join("")}</div>
      <button class="btn secondary" id="wAddEx" style="width:100%;margin:4px 0 90px">+ Oefening toevoegen</button>
      <div class="rest-bar" id="restBar" hidden>
        <div class="rest-fill" id="restFill"></div>
        <button class="icon-btn" id="rMinus" aria-label="15 seconden minder">−15</button>
        <div class="rest-mid"><b id="restTime">0:00</b><span>rust</span></div>
        <button class="icon-btn" id="rPlus" aria-label="15 seconden meer">+15</button>
        <button class="btn secondary" id="rSkip">Overslaan</button>
      </div>`;
    bind();
    updateTimer();
  }

  function findEx(el) { return w.exercises.find((e) => e.key === el.closest("[data-e]")?.dataset.e); }

  function bind() {
    view.querySelector(".wtitle").onchange = (ev) => { w.title = ev.target.value.trim() || "Training"; persist(); };
    document.getElementById("wCancel").onclick = async () => {
      if (!confirm("Training annuleren? Niets wordt opgeslagen.")) return;
      await cancelTimer();
      clear();
      location.hash = "#/training";
    };
    document.getElementById("wFinish").onclick = finish;
    document.getElementById("wAddEx").onclick = () => openPicker(async (title, muscle) => {
      await loadContext([title]);
      w.exercises.push(newExercise(title, muscle, 90, 3));
      persist(); draw();
      view.querySelector(`[data-e="${w.exercises.at(-1).key}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const list = document.getElementById("wList");
    list.addEventListener("change", (ev) => {
      const e = findEx(ev.target); if (!e) return;
      const row = ev.target.closest(".wset"); const i = row ? Number(row.dataset.i) : -1;
      if (ev.target.classList.contains("wtype")) {
        if (ev.target.value === "__del") e.sets.splice(i, 1);
        else e.sets[i].type = ev.target.value;
        persist(); draw(); return;
      }
      if (ev.target.classList.contains("wrest")) { e.rest_s = Number(ev.target.value); persist(); return; }
      if (ev.target.classList.contains("wnotes")) { e.notes = ev.target.value; persist(); return; }
    });
    list.addEventListener("input", (ev) => {
      const e = findEx(ev.target); const row = ev.target.closest(".wset"); if (!e || !row) return;
      const s = e.sets[Number(row.dataset.i)];
      if (ev.target.classList.contains("wkg")) s.kg = ev.target.value.replace(",", ".");
      if (ev.target.classList.contains("wreps")) s.reps = ev.target.value.replace(/\D/g, "");
      persist();
    });
    list.addEventListener("click", (ev) => {
      const pl = ev.target.closest(".wplates");
      if (pl) { const sg = suggestion(pl.dataset.t); openPlates(C, sg?.kg || "", /smith/i.test(pl.dataset.t) ? 0 : 20); return; }
      const sp = ev.target.closest(".wsug");
      if (sp) { editExercisePref(C, sp.dataset.pref, () => { draw(); }); return; }
      const e = findEx(ev.target); if (!e) return;
      const row = ev.target.closest(".wset");
      const t = ev.target.closest("button");
      if (!t) return;
      if (t.classList.contains("wcheck") && row) {
        const i = Number(row.dataset.i);
        const s = e.sets[i];
        if (!s.done) {
          if (s.kg === "") s.kg = row.querySelector(".wkg").placeholder.replace(",", ".").replace(/[^\d.]/g, "");
          if (s.reps === "") s.reps = row.querySelector(".wreps").placeholder.replace(/\D/g, "");
          if (s.reps === "" && s.kg === "") { C.toast("Vul gewicht en/of herhalingen in"); return; }
          s.done = true;
          unlockAudio();
          const next = e.sets[i + 1] ? `${e.title}: set ${i + 2}` : (w.exercises[w.exercises.indexOf(e) + 1]?.title || "Afronden");
          if (e.rest_s) startTimer(e.rest_s, next);
        } else s.done = false;
        persist(); draw(); return;
      }
      if (t.classList.contains("wprev") && row) {
        const i = Number(row.dataset.i);
        if (t.dataset.kg !== "") e.sets[i].kg = t.dataset.kg;
        if (t.dataset.reps !== "") e.sets[i].reps = t.dataset.reps;
        persist(); draw(); return;
      }
      if (t.classList.contains("wadd")) {
        const last = e.sets.at(-1);
        e.sets.push({ type: "normal", kg: last?.kg ?? "", reps: last?.reps ?? "", done: false });
        persist(); draw(); return;
      }
      const idx = w.exercises.indexOf(e);
      if (t.classList.contains("wdel")) { if (confirm(`${e.title} verwijderen?`)) { w.exercises.splice(idx, 1); persist(); draw(); } return; }
      if (t.classList.contains("wup")) { w.exercises.splice(idx - 1, 0, w.exercises.splice(idx, 1)[0]); persist(); draw(); return; }
      if (t.classList.contains("wdown")) { w.exercises.splice(idx + 1, 0, w.exercises.splice(idx, 1)[0]); persist(); draw(); }
    });
    document.getElementById("rMinus").onclick = () => adjustTimer(-15);
    document.getElementById("rPlus").onclick = () => adjustTimer(15);
    document.getElementById("rSkip").onclick = () => cancelTimer(true);
  }

  // ---------- rusttimer ----------
  async function startTimer(secs, next) {
    w.timer = { id: null, due: Date.now() + secs * 1000, total: secs, rang: false };
    persist(); updateTimer();
    try {
      const t = await C.invoke("rest-timer", { action: "start", seconds: secs, title: "Rust voorbij 💪", body: `Volgende: ${next}` });
      if (w.timer) { w.timer.id = t.id; persist(); }
    } catch { /* geen push, timer in de app werkt nog */ }
  }
  async function adjustTimer(d) {
    if (!w.timer) return;
    w.timer.due = Math.max(Date.now(), w.timer.due + d * 1000);
    w.timer.total = Math.max(1, w.timer.total + d);
    persist(); updateTimer();
    if (w.timer.id) C.rpc("rest_timer_adjust", { p_id: w.timer.id, p_delta: d }).catch(() => {});
  }
  async function cancelTimer(redraw) {
    const id = w.timer?.id;
    w.timer = null; persist();
    if (redraw) updateTimer();
    if (id) await C.rpc("rest_timer_cancel", { p_id: id }).catch(() => {});
  }
  function updateTimer() {
    const bar = document.getElementById("restBar");
    if (!bar) return;
    if (!w.timer) { bar.hidden = true; return; }
    const rem = w.timer.due - Date.now();
    if (rem <= 0) {
      if (!w.timer.rang) { w.timer.rang = true; persist(); ring(); }
      bar.hidden = true;
      w.timer = null; persist();
      return;
    }
    bar.hidden = false;
    document.getElementById("restTime").textContent = fmtDur(rem);
    document.getElementById("restFill").style.width = `${Math.min(100, (1 - rem / (w.timer.total * 1000)) * 100)}%`;
  }

  // ---------- afronden ----------
  async function finish() {
    const exercises = w.exercises
      .map((e) => ({ title: e.title, muscle: e.muscle || null, notes: e.notes || null,
        sets: e.sets.filter((s) => s.done).map((s, i) => ({ index: i, type: s.type,
          weight_kg: s.kg === "" ? null : Number(s.kg), reps: s.reps === "" ? null : Number(s.reps) })) }))
      .filter((e) => e.sets.length);
    if (!exercises.length) { C.toast("Vink minstens één set af voor je afrondt"); return; }
    const open = w.exercises.reduce((n, e) => n + e.sets.filter((s) => !s.done).length, 0);
    if (open && !confirm(`${open} set(s) niet afgevinkt. Die worden niet opgeslagen. Afronden?`)) return;
    const btn = document.getElementById("wFinish"); btn.disabled = true; btn.textContent = "Opslaan…";
    try {
      await cancelTimer();
      const res = await C.rpc("save_workout", { p: { id: w.id, title: w.title, description: null,
        start_time: new Date(w.start).toISOString(), end_time: new Date().toISOString(), exercises } });
      const done = { ...w, exercises: w.exercises.map((e) => ({ ...e, sets: e.sets.filter((s) => s.done) })).filter((e) => e.sets.length) };
      clear();
      ctxCache = {};
      showSummary(res, done);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Afronden";
      C.toast(e.message, 6000);
    }
  }

  function showSummary(res, done) {
    clearInterval(tick);
    const s = res.summary || {};
    const rec = res.records || [];
    view.innerHTML = `
      <section class="panel whero">
        <h3 style="font-family:var(--font-num);font-size:26px;margin:0 0 6px">Goed gedaan! 💪</h3>
        <div class="wstats">
          <div><b>${C.fmt(s.duration_min)}</b><span>minuten</span></div>
          <div><b>${C.fmt(s.volume_kg)}</b><span>kg volume</span></div>
          <div><b>${C.fmt(s.working_sets)}</b><span>werksets</span></div>
        </div>
      </section>
      ${rec.length ? `<section class="panel"><h3>🏆 Nieuwe records</h3>
        ${rec.map((r) => `<div class="meal"><span><b>${C.esc(r.exercise)}</b><br><span class="small muted">${C.esc(r.kind)}</span></span>
          <span class="k">${C.fmt(r.value, 1)} kg<br><span class="small muted">was ${C.fmt(r.previous, 1)}</span></span></div>`).join("")}</section>` : ""}
      <section class="panel">
        <h3>Als schema bewaren</h3>
        <p class="hint">Start deze training later opnieuw met dezelfde oefeningen.</p>
        <div class="row"><input class="input" id="tplName" value="${C.esc(done.title)}" aria-label="Naam van het schema">
          <button class="btn secondary" id="tplSave">${done.template_id ? "Schema bijwerken" : "Bewaren"}</button></div>
      </section>
      <a class="btn" href="#/training" style="display:block;text-align:center;text-decoration:none">Klaar</a>`;
    document.getElementById("tplSave").onclick = async () => {
      const exercises = done.exercises.map((e) => ({ title: e.title, muscle: e.muscle, rest_s: e.rest_s,
        sets: e.sets.filter((x) => x.type !== "warmup").length || e.sets.length }));
      await C.rpc("save_template", { p: { id: done.template_id || undefined, name: document.getElementById("tplName").value, exercises } });
      C.toast("Schema bewaard");
    };
  }
}

// ---------------- geluid bij einde rust ----------------
let audioCtx = null;
function unlockAudio() {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch { /* */ }
}
function ring() {
  try {
    unlockAudio();
    const t = audioCtx.currentTime;
    [0, 0.25, 0.5].forEach((d) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.4, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.18);
      o.start(t + d); o.stop(t + d + 0.2);
    });
  } catch { /* */ }
  navigator.vibrate?.([200, 100, 200]);
  C?.toast("Rust voorbij, volgende set!", 3500);
}

// ---------------- oefening kiezen ----------------
let libCache = null;
export async function openPicker(onPick) {
  if (!libCache) libCache = await C.rpc("get_exercise_library").catch(() => []);
  const seen = new Set(libCache.map((x) => x.title.toLowerCase()));
  const all = [...libCache.map((x) => ({ title: x.title, muscle: x.muscle, sessions: x.sessions })),
    ...BUILTIN.filter(([t]) => !seen.has(t.toLowerCase())).map(([title, muscle]) => ({ title, muscle, sessions: 0 }))];
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Oefening kiezen">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Oefening toevoegen</h3><button class="icon-btn" id="pkClose" aria-label="Sluiten">✕</button></div>
      <input class="input" id="pkQ" placeholder="Zoek oefening…" autocomplete="off" style="margin:10px 0">
      <div class="chips" id="pkMuscles" style="margin-bottom:8px"><button class="chip on" data-m="">Alles</button>${Object.entries(MUSCLES).slice(0, 14).map(([k, v]) => `<button class="chip" data-m="${k}">${v}</button>`).join("")}</div>
      <div id="pkList" class="pk-list"></div>
    </div>`;
  document.body.appendChild(sheet);
  let muscle = "";
  const close = () => sheet.remove();
  const q = sheet.querySelector("#pkQ");
  const render = () => {
    const term = q.value.trim().toLowerCase();
    const items = all.filter((x) => (!term || x.title.toLowerCase().includes(term)) && (!muscle || x.muscle === muscle)).slice(0, 80);
    sheet.querySelector("#pkList").innerHTML = items.map((x) => `<button class="pk-item" data-t="${C.esc(x.title)}" data-m="${x.muscle || ""}">
        <span><b>${C.esc(x.title)}</b><br><span class="small muted">${x.muscle ? C.esc(MUSCLES[x.muscle] || x.muscle) : "Spiergroep onbekend"}${x.sessions ? ` · ${x.sessions}× gedaan` : ""}</span></span><span>+</span></button>`).join("")
      + (term ? `<div class="pk-new"><b>Nieuwe oefening: "${C.esc(q.value.trim())}"</b>
          <div class="row" style="margin-top:6px"><select class="input" id="pkNewM">${Object.entries(MUSCLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          <button class="btn" id="pkNew">Toevoegen</button></div></div>` : "");
    sheet.querySelector("#pkNew")?.addEventListener("click", () => { close(); onPick(q.value.trim(), sheet.querySelector("#pkNewM")?.value || "other"); });
  };
  render();
  q.addEventListener("input", render);
  sheet.querySelector("#pkMuscles").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    muscle = b.dataset.m;
    sheet.querySelectorAll("#pkMuscles .chip").forEach((c) => c.classList.toggle("on", c === b));
    render();
  });
  sheet.querySelector("#pkList").addEventListener("click", (e) => {
    const b = e.target.closest(".pk-item"); if (!b) return;
    close(); onPick(b.dataset.t, b.dataset.m || null);
  });
  sheet.querySelector("#pkClose").onclick = close;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  q.focus();
}

// ---------------- schema's beheren ----------------
export async function editTemplate(ctx, tpl, after) {
  C = ctx;
  const t = tpl ? JSON.parse(JSON.stringify(tpl)) : { name: "", exercises: [] };
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  const draw = () => {
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Schema">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">${tpl ? "Schema bewerken" : "Nieuw schema"}</h3><button class="icon-btn" id="tClose" aria-label="Sluiten">✕</button></div>
      <div class="field"><label for="tName">Naam</label><input class="input" id="tName" value="${C.esc(t.name)}" placeholder="bv. Push A"></div>
      ${t.exercises.map((e, i) => `<div class="tpl-ex" data-i="${i}">
          <span><b>${C.esc(e.title)}</b><br><span class="small muted">${C.esc(MUSCLES[e.muscle] || e.muscle || "")}</span></span>
          <label class="small">Sets <input class="input tsets" inputmode="numeric" value="${e.sets || 3}" style="width:56px"></label>
          <select class="input trest" aria-label="Rusttijd">${REST_OPTIONS.map((r) => `<option value="${r}" ${r === (e.rest_s ?? 90) ? "selected" : ""}>⏱ ${restLabel(r)}</option>`).join("")}</select>
          <button class="icon-btn tdel" aria-label="Verwijderen">✕</button></div>`).join("") || `<p class="muted small">Nog geen oefeningen.</p>`}
      <button class="btn secondary" id="tAdd" style="width:100%;margin:8px 0">+ Oefening</button>
      <div class="row">
        <button class="btn" id="tSave" style="flex:1">Opslaan</button>
        ${tpl ? `<button class="btn ghost" id="tArch">Verwijderen</button>` : ""}
      </div></div>`;
    sheet.querySelector("#tClose").onclick = close;
    sheet.querySelector("#tName").oninput = (e) => (t.name = e.target.value);
    sheet.querySelectorAll(".tpl-ex").forEach((row) => {
      const e = t.exercises[Number(row.dataset.i)];
      row.querySelector(".tsets").oninput = (ev) => (e.sets = Math.max(1, Number(ev.target.value) || 1));
      row.querySelector(".trest").onchange = (ev) => (e.rest_s = Number(ev.target.value));
      row.querySelector(".tdel").onclick = () => { t.exercises.splice(Number(row.dataset.i), 1); draw(); };
    });
    sheet.querySelector("#tAdd").onclick = () => openPicker((title, muscle) => { t.exercises.push({ title, muscle, sets: 3, rest_s: 90 }); draw(); });
    sheet.querySelector("#tSave").onclick = async () => {
      if (!t.name.trim()) return C.toast("Geef het schema een naam");
      await C.rpc("save_template", { p: { id: tpl?.id, name: t.name, exercises: t.exercises } });
      close(); C.toast("Schema opgeslagen"); after?.();
    };
    sheet.querySelector("#tArch")?.addEventListener("click", async () => {
      if (!confirm("Schema verwijderen?")) return;
      await C.rpc("save_template", { p: { id: tpl.id, archived: true } });
      close(); after?.();
    });
  };
  draw();
}

// ---------------- instellingen per oefening (bereik, stap, spiergroep) ----------------
export async function editExercisePref(ctx, title, after) {
  C = ctx;
  if (!ctxCache[title]) Object.assign(ctxCache, await C.rpc("get_exercise_context", { p_titles: [title] }));
  const c = ctxCache[title] || {};
  const rr = repRange(c);
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Oefening instellen">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${C.esc(title)}</h3><button class="icon-btn" id="eClose" aria-label="Sluiten">✕</button></div>
    <p class="hint" style="margin-top:8px">Het voorstel volgt <b>dubbele progressie</b>: blijf op hetzelfde gewicht tot al je werksets het maximum halen, ga dan ${C.fmt(incrementFor(title, c), 1)} kg zwaarder en begin opnieuw aan het minimum.${rr.own ? "" : " Nu is het bereik afgeleid uit je laatste trainingen."}</p>
    <div class="grid2">
      <div class="field"><label for="eMin">Min. herhalingen</label><input class="input" id="eMin" inputmode="numeric" value="${rr.min}"></div>
      <div class="field"><label for="eMax">Max. herhalingen</label><input class="input" id="eMax" inputmode="numeric" value="${rr.max}"></div>
      <div class="field"><label for="eInc">Stap (kg)</label><input class="input" id="eInc" inputmode="decimal" value="${incrementFor(title, c)}"></div>
      <div class="field"><label for="eMus">Spiergroep</label><select class="input" id="eMus">${Object.entries(MUSCLES).map(([k, v]) => `<option value="${k}" ${k === c.muscle ? "selected" : ""}>${v}</option>`).join("")}</select></div>
    </div>
    <button class="btn" id="eSave" style="width:100%;margin-top:8px">Opslaan</button></div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet._close = close;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  sheet.querySelector("#eClose").onclick = close;
  sheet.querySelector("#eSave").onclick = async () => {
    const v = (id) => Number(String(sheet.querySelector("#" + id).value).replace(",", "."));
    const p = { title, rep_min: Math.round(v("eMin")), rep_max: Math.round(v("eMax")), increment_kg: v("eInc"), muscle: sheet.querySelector("#eMus").value };
    if (!(p.rep_min > 0 && p.rep_max >= p.rep_min)) return C.toast("Controleer het herhalingsbereik");
    if (!(p.increment_kg > 0)) return C.toast("Stap moet groter dan 0 zijn");
    try {
      const r = await C.rpc("set_exercise_pref", { p });
      ctxCache[title] = { ...c, pref: r, muscle: r.muscle || c.muscle };
      libCache = null;
      close(); C.toast("Opgeslagen"); after?.();
    } catch (e) { C.toast(e.message, 5000); }
  };
}

// ---------------- schijvencalculator ----------------
const PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
export function platesFor(total, bar) {
  let side = (total - bar) / 2;
  if (!(side > 0)) return { plates: [], rest: 0 };
  const out = [];
  for (const p of PLATES) while (side >= p - 1e-9) { out.push(p); side = Math.round((side - p) * 100) / 100; }
  return { plates: out, rest: side };
}
export function openPlates(ctx, kg, bar = 20) {
  C = ctx;
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Schijvencalculator">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Schijven per kant</h3><button class="icon-btn" id="pClose" aria-label="Sluiten">✕</button></div>
    <div class="grid2" style="margin-top:6px">
      <div class="field"><label for="pKg">Totaal (kg)</label><input class="input" id="pKg" inputmode="decimal" value="${kg}"></div>
      <div class="field"><label for="pBar">Stang</label><select class="input" id="pBar">${[[20, "Olympisch 20 kg"], [15, "15 kg"], [10, "EZ / 10 kg"], [0, "Smith / geen"]].map(([v, l]) => `<option value="${v}" ${v === bar ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    </div>
    <div id="pOut" class="plates-out"></div></div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet._close = close;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  sheet.querySelector("#pClose").onclick = close;
  const draw = () => {
    const total = Number(String(sheet.querySelector("#pKg").value).replace(",", ".")) || 0;
    const b = Number(sheet.querySelector("#pBar").value);
    const { plates, rest } = platesFor(total, b);
    sheet.querySelector("#pOut").innerHTML = !total ? `<p class="muted small">Vul een gewicht in.</p>`
      : total < b ? `<p class="small warn">Lichter dan de stang (${b} kg).</p>`
      : `<div class="plates">${plates.map((p) => `<span class="plate p${String(p).replace(".", "_")}">${C.fmt(p, 2)}</span>`).join("") || `<span class="muted">alleen de stang</span>`}</div>
         ${rest > 0 ? `<p class="small warn">Niet exact te laden: ${C.fmt(rest, 2)} kg per kant blijft over.</p>` : `<p class="small muted">${C.fmt(b, 1)} kg stang + 2 × ${C.fmt(plates.reduce((a, x) => a + x, 0), 2)} kg</p>`}`;
  };
  sheet.querySelector("#pKg").oninput = draw;
  sheet.querySelector("#pBar").onchange = draw;
  draw();
}
