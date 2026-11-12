// Voeding: één scherm om te zien waar je staat en in één tik te loggen.
// Bovenaan de brandstofmeter (kcal over + macro's), daaronder per maaltijd
// wat je at en de dingen die je daar meestal eet als knoppen.
import { MEALS, mealForNow, openQuickAdd, openAddFood, renderRecipes } from "./food.js";

let C;
const SHOWN = ["Ontbijt", "Lunch", "Snack", "Avondeten"];
const SLOT_OF = { Ontbijt: "ontbijt", Lunch: "lunch", Snack: "snack", Avondeten: "avond", Laat: "snack" };
const n = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export function gauge(ctx, { kcal, p, c, f, goals: g }, { compact = false } = {}) {
  C = ctx;
  const goal = n(g.kcal_in) || 2000;
  const eaten = n(kcal) || 0;
  const left = goal - eaten;
  const frac = Math.max(0, Math.min(1, eaten / goal));
  const R = 52, L = 2 * Math.PI * R;
  const over = left < 0;
  const macro = (cls, label, v, gl) => {
    const val = n(v) || 0, goalv = n(gl);
    const pct = goalv ? Math.min(100, (val / goalv) * 100) : 0;
    return `<div class="mrow ${cls}">
      <div class="mrow-h"><span>${label}</span><span><b>${C.fmt(val)}</b>${goalv ? ` / ${C.fmt(goalv)} g` : " g"}</span></div>
      <div class="mtrack"><i style="width:${pct}%"></i></div></div>`;
  };
  return `<section class="gauge ${compact ? "compact" : ""}">
    <div class="ring" role="img" aria-label="${C.fmt(eaten)} van ${C.fmt(goal)} kcal gegeten">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="${R}" class="ring-track"/>
        <circle cx="60" cy="60" r="${R}" class="ring-fill ${over ? "over" : ""}" stroke-dasharray="${L}" stroke-dashoffset="${L * (1 - frac)}" transform="rotate(-90 60 60)"/>
      </svg>
      <div class="ring-num"><b>${C.fmt(Math.abs(left))}</b><span>${over ? "kcal te veel" : "kcal over"}</span></div>
    </div>
    <div class="macros2">
      ${macro("prot", "Eiwit", p, g.protein_g)}
      ${macro("carb", "Koolhydraten", c, g.carbs_g)}
      ${macro("fat", "Vet", f, g.fat_g)}
      <div class="eaten small muted">${C.fmt(eaten)} van ${C.fmt(goal)} kcal gegeten</div>
    </div>
  </section>`;
}

export async function renderNutrition(ctx, state) {
  C = ctx;
  const day = state.nutDay;
  const isToday = day === C.today();
  const [d, items, quick, menu, week] = await Promise.all([
    C.rpc("get_nutrition_day", { p_day: day }),
    C.rpc("get_food_log", { p_day: day }),
    C.rpc("get_quick_add").catch(() => ({})),
    isToday ? C.rpc("mp_get").then((m) => {
      const w = m.weeks?.find((x) => x.id === m.current_week_id);
      return (w?.items || []).filter((i) => i.day === day).map((i) => ({ ...i, r: m.recipes.find((r) => r.id === i.recipe_id) })).filter((i) => i.r);
    }).catch(() => []) : Promise.resolve([]),
    C.rpc("get_food_week", { p_days: 7 }).catch(() => null),
  ]);
  const by = Object.fromEntries((d.nutrients || []).map((x) => [x.metric, x]));
  const g = d.goals || {};
  const tot = { kcal: n(by.dietary_energy?.value), p: n(by.protein?.value), c: n(by.carbohydrates?.value), f: n(by.total_fat?.value), goals: g };
  const now = mealForNow();
  const meals = [...SHOWN, ...(items.some((i) => i.meal === "Laat") ? ["Laat"] : [])];

  // Suggesties per maaltijd: menu van vandaag, wat je daar vaak eet, vaste producten, recepten
  const suggest = (meal) => {
    const out = [], seen = new Set(items.filter((i) => i.meal === meal).map((i) => i.name));
    const push = (s) => { if (out.length < 4 && !seen.has(s.name)) { seen.add(s.name); out.push(s); } };
    menu.filter((i) => i.slot === SLOT_OF[meal]).forEach((i) => push({ kind: "menu", name: i.r.name, kcal: i.r.kcal * i.portions, x: i }));
    (quick.frequent?.[meal] || []).forEach((f) => push({ kind: "freq", name: f.name, kcal: f.kcal, x: f }));
    if (meal === "Snack" || meal === "Ontbijt") (quick.products || []).forEach((p) => push({ kind: "prod", name: p.name, kcal: (p.per100?.kcal || 0) * (p.serving_g || 100) / 100, x: p }));
    (quick.recipes || []).filter((r) => r.meal_type === SLOT_OF[meal]).forEach((r) => push({ kind: "rec", name: r.name, kcal: r.kcal, x: r }));
    return out;
  };
  const sugg = Object.fromEntries(meals.map((m) => [m, suggest(m)]));
  const short = (s) => s.replace(/^(AH|Upfront|Albert Heijn)\s+/i, "").replace(/\s*\(.*?\)\s*/g, " ").replace(/Proteïnereep/i, "Eiwitreep").trim();

  const mealCard = (m) => {
    const list = items.filter((i) => i.meal === m);
    const kc = list.reduce((s, i) => s + (Number(i.kcal) || 0), 0);
    return `<section class="mcard ${m === now && isToday ? "now" : ""}" data-meal="${m}">
      <header><h2>${m}</h2><span class="mk">${list.length ? `${C.fmt(kc)} kcal` : ""}</span>
        <button class="madd" data-add="${m}" aria-label="Iets toevoegen aan ${m.toLowerCase()}">+</button></header>
      ${list.map((i) => `<div class="mi" data-id="${i.id}">
          <span class="mi-t">${C.esc(i.name)}<small>${i.grams != null ? `${C.fmt(i.grams)} g · ` : ""}${C.fmt(i.protein)} g eiwit</small></span>
          <span class="mi-k">${C.fmt(i.kcal)}</span>
          <button class="mi-x" aria-label="${C.esc(i.name)} verwijderen">×</button></div>`).join("")}
      ${sugg[m].length ? `<div class="sugg">${sugg[m].map((s, k) => `<button class="sg" data-sg="${k}"><span>${C.esc(short(s.name))}</span><small>${C.fmt(s.kcal)}</small></button>`).join("")}</div>`
        : !list.length ? `<p class="mempty">Nog niets. Tik op + om iets toe te voegen.</p>` : ""}
    </section>`;
  };

  const wk = week?.days || [];
  C.view.innerHTML = `
    <div class="daynav">
      <button id="prev" aria-label="Vorige dag">‹</button>
      <span class="label">${isToday ? "Vandaag" : C.esc(new Intl.DateTimeFormat("nl-BE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(day + "T12:00:00Z")))}</span>
      <button id="next" aria-label="Volgende dag" ${isToday ? "disabled" : ""}>›</button>
    </div>
    ${gauge(C, tot)}
    ${meals.map(mealCard).join("")}
    <button class="btn secondary wide" id="search">Zoeken of barcode scannen</button>
    ${wk.length ? `<h2 class="section-title">Afgelopen 7 dagen</h2>
    <section class="panel weekfood">
      ${weekVerdict(wk.filter((x) => x.day !== C.today()), week.goals || g)}
      <div class="wkbars">${wk.map((x) => {
        const gk = n((week.goals || g).kcal_in) || 2000, gp = n((week.goals || g).protein_g) || 150;
        const h = x.kcal == null ? 0 : Math.min(100, (x.kcal / (gk * 1.25)) * 100);
        const pOk = x.protein != null && x.protein >= gp * 0.95;
        return `<div class="wkb" title="${C.esc(x.day)}"><div class="wkb-col"><i style="height:${h}%" class="${x.kcal == null ? "none" : Math.abs(x.kcal - gk) <= gk * 0.08 ? "ok" : x.kcal > gk ? "hi" : "lo"}"></i><em style="bottom:${(gk / (gk * 1.25)) * 100}%"></em></div>
          <span class="wkd">${["zo", "ma", "di", "wo", "do", "vr", "za"][new Date(x.day + "T12:00:00Z").getUTCDay()]}</span>
          <span class="wkp ${x.protein == null ? "" : pOk ? "ok" : "lo"}">${x.protein == null ? "–" : C.fmt(x.protein)}</span></div>`;
      }).join("")}</div>
      <p class="small muted" style="margin:6px 0 0">Balk = kcal (streep = doel). Getal = gram eiwit, groen als je je doel haalde. Vandaag telt nog niet mee in het gemiddelde.</p>
    </section>` : ""}
    <details class="panel"><summary>Mijn recepten</summary><div id="recipes" style="margin-top:8px"></div></details>
`;

  const reload = () => renderNutrition(ctx, state);
  C.view.querySelector("#prev").onclick = () => { state.nutDay = C.addDays(day, -1); reload(); };
  C.view.querySelector("#next").onclick = () => { if (!isToday) { state.nutDay = C.addDays(day, 1); reload(); } };
  C.view.querySelector("#search").onclick = () => openAddFood(C, { day, meal: isToday ? now : "Lunch", after: reload });
  C.view.querySelector("details.panel").addEventListener("toggle", (e) => {
    if (e.target.open && !e.target.dataset.loaded) { e.target.dataset.loaded = 1; renderRecipes(C, day, C.view.querySelector("#recipes"), reload); }
  });

  C.view.querySelectorAll(".mcard").forEach((card) => {
    const meal = card.dataset.meal;
    card.querySelector("[data-add]").onclick = () => openQuickAdd(C, { day, meal, after: reload });
    card.querySelectorAll(".sg").forEach((b) => (b.onclick = async () => {
      if (b.disabled) return;
      b.disabled = true; b.classList.add("busy");
      const s = sugg[meal][Number(b.dataset.sg)];
      try {
        let p;
        if (s.kind === "prod") p = { day, meal, grams: s.x.serving_g || 100, food: { id: s.x.id } };
        else if (s.kind === "freq") p = s.x.food_id && s.x.grams ? { day, meal, grams: s.x.grams, food: { id: s.x.food_id } }
          : { day, meal, name: s.x.name, kcal: s.x.kcal, protein: s.x.protein, carbs: s.x.carbs, fat: s.x.fat };
        else {
          const r = s.kind === "menu" ? s.x.r : s.x, q = s.kind === "menu" ? Number(s.x.portions) || 1 : 1;
          p = { day, meal, name: r.name, kcal: r.kcal * q, protein: r.protein * q, carbs: r.carbs * q, fat: r.fat * q };
        }
        const r = await C.rpc("log_food", { p });
        C.toast(`${short(s.name)} toegevoegd`, 5000, { label: "Ongedaan maken", run: async () => { await C.rpc("void_food_many", { p_ids: [r.id] }); reload(); } });
        reload();
      } catch (e) { b.disabled = false; b.classList.remove("busy"); C.toast(e.message, 4000); }
    }));
    card.querySelectorAll(".mi-x").forEach((b) => (b.onclick = async () => {
      const it = items.find((i) => i.id === b.closest(".mi").dataset.id);
      await C.rpc("void_food", { p_id: it.id });
      C.toast(`${it.name} verwijderd`, 5000, {
        label: "Ongedaan maken",
        run: async () => {
          const p = it.food_id && it.grams ? { day: it.day, meal: it.meal, grams: it.grams, food: { id: it.food_id } }
            : { day: it.day, meal: it.meal, name: it.name, kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat };
          await C.rpc("log_food", { p }); reload();
        },
      });
      reload();
    }));
  });
}

function weekVerdict(days, g) {
  const logged = days.filter((x) => n(x.kcal) != null && n(x.kcal) > 300);
  if (logged.length < 2) return `<p class="verdict">Log een paar dagen volledig, dan zie je hier hoe je week loopt.</p>`;
  const avg = (k) => logged.reduce((s, x) => s + n(x[k]), 0) / logged.length;
  const gk = n(g.kcal_in) || 2000, gp = n(g.protein_g) || 150;
  const pDays = logged.filter((x) => n(x.protein) >= gp * 0.95).length;
  const k = avg("kcal"), p = avg("protein");
  const kTxt = Math.abs(k - gk) <= gk * 0.07 ? "mooi rond je doel" : k > gk ? `${C.fmt(k - gk)} kcal boven je doel` : `${C.fmt(gk - k)} kcal onder je doel`;
  return `<p class="verdict"><b>${C.fmt(k)} kcal</b> per dag, ${kTxt}. Eiwit gemiddeld <b>${C.fmt(p)} g</b>, doel gehaald op ${pDays} van ${logged.length} gelogde dagen.</p>`;
}
