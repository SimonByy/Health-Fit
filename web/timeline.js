// Tijdlijn van de dag: ontwaken, maaltijden, trainingen, slapen
import { pkv } from "./food.js";

const ICON = { wake: "☀️", food: "🍽️", workout: "🏋️", plan: "🗓️", sleep: "🌙" };
const MEAL_AT = { Ontbijt: "08:45", Lunch: "12:30", Snack: "16:00", Avondeten: "18:45", Laat: "21:30" };
const MEAL_LBL = { Laat: "Avondsnack" };
const hm = (iso) => (iso ? String(iso).slice(11, 16) : "");

export async function renderTimeline(C, el, day) {
  let D;
  try { D = await C.rpc("get_day_timeline", { p_day: day }); } catch { el.innerHTML = ""; return; }
  const now = new Date();
  const nowHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const isToday = day === C.today();
  const ev = (D.events || []).map((e) => {
    let at = hm(e.at);
    // maaltijden die vooraf gelogd zijn (bv. avondeten om 12u al ingevuld): toon ze op hun gewone uur
    if (e.kind === "food" && MEAL_AT[e.meal] && at < MEAL_AT[e.meal] && minutes(MEAL_AT[e.meal]) - minutes(at) > 90) at = MEAL_AT[e.meal];
    const nextDay = e.at && String(e.at).slice(0, 10) > day;
    const sport = e.kind === "workout" && /hardlop|run|loop|wandel|incline/i.test(e.title || "") ? "🏃" : null;
    return { ...e, hm: at, sort: (nextDay ? 1440 : 0) + minutes(at), icon: sport || ICON[e.kind] || "•" };
  }).sort((a, b) => a.sort - b.sort);
  if (!ev.length) { el.innerHTML = ""; return; }
  const nowSort = minutes(nowHM);
  let nowPlaced = !isToday;
  const rows = ev.map((e) => {
    let marker = "";
    if (!nowPlaced && e.sort > nowSort) { nowPlaced = true; marker = `<li class="tl-now"><span class="tl-t">${nowHM}</span><span class="tl-dot"></span><span class="tl-b">Nu</span></li>`; }
    const title = e.kind === "food" ? (MEAL_LBL[e.meal] || e.meal) : e.title;
    const right = e.kind === "food" ? `<span class="tl-k">${C.fmt(e.kcal)} kcal</span>` : "";
    const sub = e.kind === "food" ? `${C.esc(e.sub || "")}<br>${pkv(e.protein, e.carbs, e.fat)}`
      : `${C.esc(e.sub || "")}${e.end ? ` · tot ${hm(e.end)}` : ""}`;
    return `${marker}<li class="tl-${e.kind} ${e.planned || e.kind === "plan" ? "planned" : ""}">
      <span class="tl-t">${e.hm}</span><span class="tl-dot" aria-hidden="true">${e.icon}</span>
      <span class="tl-b"><b>${C.esc(title)}</b>${right}<small>${sub}</small></span></li>`;
  }).join("") + (!nowPlaced ? `<li class="tl-now"><span class="tl-t">${nowHM}</span><span class="tl-dot"></span><span class="tl-b">Nu</span></li>` : "");
  el.innerHTML = `<section class="panel tl-panel"><h2 class="tl-h">${isToday ? "Je dag" : "Tijdlijn"}</h2><ol class="tl">${rows}</ol></section>`;
}
function minutes(s) { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); }
