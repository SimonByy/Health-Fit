// Tijdlijn van de dag: ontwaken, maaltijden, trainingen, water/cafeïne/gewicht, slapen.
// Interactief: tik op een moment om het te openen (geplande maaltijd aanpassen, training een uur geven, log wissen),
// of op "+" om iets toe te voegen op een tijdstip (eten, water, cafeïne, gewicht, training, notitie).
import { pkv, openAddFood } from "./food.js";

const ICON = { wake: "☀️", food: "🍽️", mplan: "🍽️", workout: "🏋️", plan: "🗓️", sleep: "🌙", entry: "•" };
const ENTRY_ICON = { dietary_water: "💧", dietary_caffeine: "☕", weight_body_mass: "⚖️" };
const MEAL_AT = { Ontbijt: "08:45", Lunch: "12:30", Snack: "16:00", Avondeten: "18:45", Laat: "21:30" };
const MEAL_LBL = { Laat: "Avondsnack" };
const hm = (iso) => (iso ? String(iso).slice(11, 16) : "");
const minutes = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fromMin = (x) => `${String(Math.floor(x / 60) % 24).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
// maaltijd die bij een uur hoort
export const mealAt = (t) => { const m = minutes(t); return m < 630 ? "Ontbijt" : m < 900 ? "Lunch" : m < 1050 ? "Snack" : m < 1260 ? "Avondeten" : "Laat"; };
// lokale datum + uur → ISO met de juiste Brusselse offset
function isoAt(day, t) {
  const guess = new Date(`${day}T${t}:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Brussels" }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (local - utc)).toISOString();
}

let LAST = null;
export async function renderTimeline(C, el, day) {
  LAST = { C, el, day };
  let D;
  try { D = await C.rpc("get_day_timeline", { p_day: day }); } catch { el.innerHTML = ""; return; }
  const now = new Date();
  const nowHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const isToday = day === C.today();
  const ev = (D.events || []).map((e, idx) => {
    let at = hm(e.at);
    if (e.kind === "food" && MEAL_AT[e.meal] && at < MEAL_AT[e.meal] && minutes(MEAL_AT[e.meal]) - minutes(at) > 90) at = MEAL_AT[e.meal];
    const nextDay = e.at && String(e.at).slice(0, 10) > day;
    const sport = e.kind === "workout" && /hardlop|run|loop|wandel|incline/i.test(e.title || "") ? "🏃" : null;
    return { ...e, idx, hm: at, sort: (nextDay ? 1440 : 0) + minutes(at), icon: sport || (e.kind === "entry" ? ENTRY_ICON[e.metric] : null) || ICON[e.kind] || "•" };
  }).sort((a, b) => a.sort - b.sort);
  const nowSort = minutes(nowHM);
  let nowPlaced = !isToday;
  const nowRow = `<li class="tl-now"><span class="tl-t">${nowHM}</span><span class="tl-dot"></span><span class="tl-b">Nu<button class="tl-plus" data-at="${nowHM}" aria-label="Iets toevoegen om ${nowHM}">＋</button></span></li>`;
  // "+"-knop in grote gaten (≥ 2 u), op het hele uur ertussen
  const gap = (a, b) => {
    if (b - a < 120 || a >= 1440) return "";
    const mid = Math.round((a + b) / 2 / 60) * 60;
    return `<li class="tl-gap"><span class="tl-t"></span><span></span><button class="tl-add" data-at="${fromMin(mid)}">＋ ${fromMin(mid)}</button></li>`;
  };
  let prev = ev.length ? Math.max(0, ev[0].sort - 1) : 420;
  const rows = ev.map((e) => {
    let pre;
    if (!nowPlaced && e.sort > nowSort) { nowPlaced = true; pre = gap(prev, nowSort) + nowRow + gap(nowSort, e.sort); }
    else pre = gap(prev, e.sort);
    prev = e.sort;
    const title = e.kind === "food" ? (MEAL_LBL[e.meal] || e.meal) : e.title;
    const right = e.kind === "food" || e.kind === "mplan" ? `<span class="tl-k">${C.fmt(e.kcal)} kcal</span>` : "";
    const sub = e.kind === "food" ? `${C.esc(e.sub || "")}<br>${pkv(e.protein, e.carbs, e.fat)}`
      : e.kind === "mplan" ? `${C.esc(e.sub || "")} · ${C.fmt(e.protein)} g eiwit · tik om aan te passen`
      : `${C.esc(e.sub || "")}${e.end ? ` · tot ${hm(e.end)}` : ""}`;
    const tap = ["food", "mplan", "plan", "entry", "workout", "sleep", "wake"].includes(e.kind);
    return `${pre}<li class="tl-${e.kind} ${e.planned || e.kind === "plan" ? "planned" : ""}">
      <span class="tl-t">${e.hm}</span><span class="tl-dot" aria-hidden="true">${e.icon}</span>
      ${tap ? `<button class="tl-b tl-tap" data-ev="${e.idx}">` : `<span class="tl-b">`}<b>${C.esc(title)}</b>${right}<small>${sub}</small>${tap ? "</button>" : "</span>"}</li>`;
  }).join("") + (!nowPlaced ? nowRow : "");
  el.innerHTML = `<section class="panel tl-panel"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2 class="tl-h">${isToday ? "Je dag" : "Tijdlijn"}</h2>
      <button class="btn small" id="tlAdd">＋ Toevoegen</button></div>
    ${ev.length ? `<ol class="tl">${rows}</ol>` : `<p class="small muted">Nog niets op deze dag. Tik op ＋ om iets toe te voegen.</p>`}</section>`;
  // Vandaag luistert hiernaar en tekent alles opnieuw (totalen, water, …); anders alleen de tijdlijn
  const reload = () => { const ev2 = new Event("hh-day-changed", { cancelable: true }); window.dispatchEvent(ev2); if (!ev2.defaultPrevented) renderTimeline(C, el, day); };
  el.querySelector("#tlAdd").onclick = () => addSheet(C, day, isToday ? nowHM : "12:00", reload);
  el.querySelectorAll("[data-at]").forEach((b) => (b.onclick = () => addSheet(C, day, b.dataset.at, reload)));
  el.querySelectorAll("[data-ev]").forEach((b) => (b.onclick = () => openEvent(C, day, (D.events || [])[Number(b.dataset.ev)], reload)));
}

function sheet(title, body) {
  const s = document.createElement("div"); s.className = "sheet";
  s.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${title}"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${title}</h3>
    <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div><div style="margin-top:12px">${body}</div></div>`;
  document.body.appendChild(s);
  s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) s.remove(); });
  return s;
}

// ---------- iets toevoegen op een tijdstip ----------
function addSheet(C, day, at, reload) {
  const s = sheet("Toevoegen", `
    <div class="field"><label for="tlTime">Om</label><input class="input" id="tlTime" type="time" value="${at}" style="max-width:150px"></div>
    <div class="tl-kinds">
      <button data-k="food"><span>🍽️</span>Eten</button>
      <button data-k="water"><span>💧</span>Water</button>
      <button data-k="caf"><span>☕</span>Cafeïne</button>
      <button data-k="weight"><span>⚖️</span>Gewicht</button>
      <button data-k="train"><span>🏋️</span>Training plannen</button>
      <button data-k="note"><span>📝</span>Notitie</button>
    </div>
    <div id="tlForm"></div>`);
  const time = () => s.querySelector("#tlTime").value || at;
  const form = s.querySelector("#tlForm");
  const go = async (fn, msg) => { try { await fn(); s.remove(); C.toast(msg); reload(); } catch (e) { C.toast(e.message, 5000); } };
  s.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => {
    s.querySelectorAll("[data-k]").forEach((x) => x.classList.toggle("on", x === b));
    const k = b.dataset.k;
    if (k === "food") {
      // het gewone toevoegscherm, maar met dit uur: alles wat je logt komt op dat tijdstip in je tijdlijn
      const t = time(), meal = mealAt(t), ts = isoAt(day, t);
      const C2 = { ...C, rpc: (fn, a) => (fn === "log_food" && a?.p ? C.rpc(fn, { ...a, p: { ...a.p, at: ts } }) : C.rpc(fn, a)) };
      s.remove(); openAddFood(C2, { day, meal, after: reload });
      return;
    }
    if (k === "water" || k === "caf") {
      const opts = k === "water" ? [[250, "Glas 250 ml"], [500, "Fles 500 ml"], [750, "750 ml"]] : [[80, "Espresso 80 mg"], [95, "Koffie 95 mg"], [160, "Energiedrank 160 mg"], [200, "Pre-workout 200 mg"]];
      form.innerHTML = `<div class="chips" style="margin-top:12px">${opts.map(([v, l]) => `<button class="chip" data-v="${v}">${l}</button>`).join("")}</div>
        <div class="row" style="margin-top:8px"><input class="input" id="tlV" inputmode="numeric" placeholder="${k === "water" ? "ml" : "mg"}" style="max-width:120px"><button class="btn" id="tlOk">Toevoegen</button></div>`;
      const log = (v) => go(() => C.rpc("log_entry", { p_metric: k === "water" ? "dietary_water" : "dietary_caffeine", p_value: v, p_ts: isoAt(day, time()) }),
        `${v} ${k === "water" ? "ml water" : "mg cafeïne"} om ${time()}`);
      form.querySelectorAll("[data-v]").forEach((c) => (c.onclick = () => log(Number(c.dataset.v))));
      form.querySelector("#tlOk").onclick = () => { const v = Number(form.querySelector("#tlV").value); if (v > 0) log(v); };
    } else if (k === "weight") {
      form.innerHTML = `<div class="row" style="margin-top:12px"><input class="input" id="tlV" inputmode="decimal" placeholder="kg" style="max-width:120px"><button class="btn" id="tlOk">Opslaan</button></div>`;
      form.querySelector("#tlOk").onclick = () => { const v = Number(form.querySelector("#tlV").value.replace(",", ".")); if (v > 25 && v < 300) go(() => C.rpc("log_entry", { p_metric: "weight_body_mass", p_value: v, p_ts: isoAt(day, time()) }), `${v} kg om ${time()}`); else C.toast("Vul je gewicht in kg in"); };
    } else if (k === "train") {
      form.innerHTML = `<div class="seg" style="margin-top:12px" role="group"><button type="button" data-c="kracht" aria-pressed="true">Kracht</button><button type="button" data-c="cardio" aria-pressed="false">Cardio</button></div>
        <div id="tlR" class="field"><label for="tlRoutine">Routine</label><select class="input" id="tlRoutine"><option value="">Laden…</option></select></div>
        <div id="tlCd" class="field" hidden><label for="tlCt">Soort</label><select class="input" id="tlCt"><option value="lopen">Lopen</option><option value="loopband">Loopband</option><option value="fietsen">Fietsen</option><option value="zwemmen">Zwemmen</option><option value="wandelen">Stevig wandelen</option></select></div>
        <div class="field"><label for="tlDur">Duur (min)</label><input class="input" id="tlDur" type="number" min="5" max="300" step="5" value="60" style="max-width:120px"></div>
        <button class="btn" id="tlOk" style="width:100%">In je planning zetten</button>`;
      let cat = "kracht";
      C.rpc("get_workout_routines").then((R) => { form.querySelector("#tlRoutine").innerHTML = `<option value="">Zonder routine</option>${(R?.routines || []).map((r) => `<option value="${r.id}">${C.esc(r.name)}</option>`).join("")}`; form._R = R; }).catch(() => {});
      form.querySelectorAll("[data-c]").forEach((b2) => (b2.onclick = () => { cat = b2.dataset.c; form.querySelectorAll("[data-c]").forEach((y) => y.setAttribute("aria-pressed", String(y === b2)));
        form.querySelector("#tlR").hidden = cat !== "kracht"; form.querySelector("#tlCd").hidden = cat !== "cardio"; form.querySelector("#tlDur").value = cat === "cardio" ? 40 : 60; }));
      form.querySelector("#tlOk").onclick = () => go(async () => {
        const rid = form.querySelector("#tlRoutine").value, ct = form.querySelector("#tlCt").value;
        const title = cat === "kracht" ? ((form._R?.routines || []).find((r) => r.id === rid)?.name || "Krachttraining") : `${form.querySelector("#tlCt").selectedOptions[0].textContent} · zone 2`;
        const r = await C.rpc("save_coach_session", { p: { day, category: cat, title, routine_id: cat === "kracht" ? rid : "", cardio_type: cat === "cardio" ? ct : null,
          duration_min: Number(form.querySelector("#tlDur").value) || null, source: "user" } });
        if (r?.id) await C.rpc("coach_set_time", { p_id: r.id, p_time: time() });
      }, `Training gepland om ${time()}`);
    } else if (k === "note") {
      form.innerHTML = `<textarea class="input" id="tlN" rows="3" style="margin-top:12px;width:100%" placeholder="bv. hoofdpijn, slecht geslapen, 2 pintjes"></textarea><button class="btn" id="tlOk" style="width:100%;margin-top:8px">In je dagboek</button>`;
      form.querySelector("#tlOk").onclick = () => { const t = form.querySelector("#tlN").value.trim(); if (t) go(() => C.rpc("save_journal", { p_day: day, p_text: `${time()} · ${t}`, p_append: true }), "In je dagboek gezet"); };
    }
  }));
}

// ---------- een moment openen ----------
async function openEvent(C, day, e, reload) {
  if (!e) return;
  if (e.kind === "mplan") return (await import("./planitem.js")).openPlanItem(C, { id: e.item_id, day, slot: e.slot, recipe_id: e.recipe_id, portions: e.portions, eaten: false }, reload);
  if (e.kind === "food") { location.hash = "#/voeding"; return; }
  if (e.kind === "entry") {
    const s = sheet(C.esc(e.title), `<p style="margin:0 0 12px">${C.esc(e.sub)} om ${hm(e.at)}</p><button class="btn danger" id="tlDel" style="width:100%">Verwijderen</button>`);
    s.querySelector("#tlDel").onclick = async () => { try { await C.rpc("void_entry", { p_metric: e.metric, p_ts: e.ts }); s.remove(); C.toast("Verwijderd"); reload(); } catch (err) { C.toast(err.message, 5000); } };
    return;
  }
  if (e.kind === "plan") {
    const s = sheet(C.esc(e.title), `<div class="field"><label for="tlPt">Om</label><input class="input" id="tlPt" type="time" value="${hm(e.at)}" style="max-width:150px"></div>
      <div class="row"><button class="btn" id="tlPs">Uur opslaan</button><a class="btn secondary" href="#/planner" style="text-decoration:none">Planner</a></div>`);
    s.querySelector("#tlPs").onclick = async () => { try { await C.rpc("coach_set_time", { p_id: e.id, p_time: s.querySelector("#tlPt").value }); s.remove(); C.toast("Uur aangepast"); reload(); } catch (err) { C.toast(err.message, 5000); } };
    return;
  }
  if (e.kind === "workout") { location.hash = "#/training"; return; }
  if (e.kind === "sleep" || e.kind === "wake") { location.hash = "#/trends"; }
}
