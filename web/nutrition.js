// Voeding: één scherm om te zien waar je staat en in één tik te loggen.
// Bovenaan de brandstofmeter (kcal over + macro's), daaronder per maaltijd
// wat je at en de dingen die je daar meestal eet als knoppen.
import { mealForNow, openAddFood, openEditFood, renderRecipes, pkv, MEALS } from "./food.js";
const OPEN_KEY = "hh_meal_closed";
const closedMeals = (() => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); } catch { return new Set(); } })();
const saveClosed = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...closedMeals])); } catch { /* */ } };
const sel = new Set();

let C;
const SHOWN = ["Ontbijt", "Lunch", "Snack", "Avondeten", "Laat"];
const LABEL = { Laat: "Avondsnack" };
const SLOT_OF = { Ontbijt: "ontbijt", Lunch: "lunch", Snack: "snack", Avondeten: "avond", Laat: "avondsnack" };
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
        <defs><linearGradient id="kcalGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--g1)"/><stop offset="1" stop-color="var(--g2)"/></linearGradient></defs>
        <circle cx="60" cy="60" r="${R}" class="ring-track"/>
        <circle cx="60" cy="60" r="${R}" class="ring-fill ${over ? "over" : ""}" stroke-dasharray="${L}" stroke-dashoffset="${L * (1 - frac)}" transform="rotate(-90 60 60)"/>
      </svg>
      <div class="ring-num"><b>${C.fmt(eaten)}</b><span class="rn-g">kcal</span></div>
    </div>
    <div class="macros2">
      ${macro("prot", "Eiwit", p, g.protein_g)}
      ${macro("carb", "Koolhydraten", c, g.carbs_g)}
      ${macro("fat", "Vet", f, g.fat_g)}
      <div class="left ${over ? "over" : ""}"><b>${C.fmt(Math.abs(left))}</b> ${over ? "kcal te veel" : "kcal te gaan"}</div>
    </div>
  </section>`;
}

export async function renderNutrition(ctx, state) {
  C = ctx;
  const day = state.nutDay;
  const isToday = day === C.today();
  const [d, items, quick, menu, week, pairs] = await Promise.all([
    C.rpc("get_nutrition_day", { p_day: day }),
    C.rpc("get_food_log", { p_day: day }),
    C.rpc("get_quick_add").catch(() => ({})),
    // geplande maaltijden uit het weekmenu voor deze dag (uit welke week ook)
    C.rpc("mp_get").then((m) => (m.weeks || []).flatMap((w) => (w.items || []).map((i) => ({ ...i, week_id: w.id }))).filter((i) => i.day === day)
      .map((i) => ({ ...i, r: m.recipes.find((r) => r.id === i.recipe_id) })).filter((i) => i.r)).catch(() => []),
    C.rpc("get_food_week", { p_days: 7 }).catch(() => null),
    C.rpc("get_day_pairs", { p_day: day }).catch(() => ({})),
  ]);
  const by = Object.fromEntries((d.nutrients || []).map((x) => [x.metric, x]));
  const g = d.goals || {};
  const tot = { kcal: n(by.dietary_energy?.value), p: n(by.protein?.value), c: n(by.carbohydrates?.value), f: n(by.total_fat?.value), goals: g };
  const now = mealForNow();
  const meals = SHOWN;

  // Suggesties per maaltijd: menu van vandaag, wat je daar vaak eet, vaste producten, recepten
  const suggest = (meal) => {
    const out = [], seen = new Set(items.filter((i) => i.meal === meal).map((i) => i.name));
    const push = (s) => { if (out.length < 4 && !seen.has(s.name)) { seen.add(s.name); out.push(s); } };
    (pairs?.[meal] || []).forEach((f) => push({ kind: "freq", pair: true, name: f.name, kcal: f.kcal, x: f }));
    (quick.frequent?.[meal] || []).forEach((f) => push({ kind: "freq", name: f.name, kcal: f.kcal, x: f }));
    if (meal === "Snack" || meal === "Laat") (quick.products || []).forEach((p) => push({ kind: "prod", name: p.name, kcal: (p.per100?.kcal || 0) * (p.serving_g || 100) / 100, x: p }));
    (quick.recipes || []).filter((r) => r.meal_type === SLOT_OF[meal]).forEach((r) => push({ kind: "rec", name: r.name, kcal: r.kcal, x: r }));
    return out;
  };
  const sugg = Object.fromEntries(meals.map((m) => [m, suggest(m)]));
  const short = (s) => s.replace(/^(AH|Upfront|Albert Heijn)\s+/i, "").replace(/\s*\(.*?\)\s*/g, " ").replace(/Proteïnereep/i, "Eiwitreep").trim();

  const planFor = (m) => menu.filter((i) => i.slot === SLOT_OF[m]);
  const planLogIds = new Set(menu.filter((i) => i.eaten && i.food_log_id).map((i) => i.food_log_id));
  const mealCard = (m) => {
    const all = items.filter((i) => i.meal === m);
    const list = all.filter((i) => !planLogIds.has(i.id));   // gelogd via het menu: staat al als afgevinkte planning
    const kc = all.filter((i) => !i.skipped).reduce((s, i) => s + (Number(i.kcal) || 0), 0);
    const plan = planFor(m);
    const shut = closedMeals.has(m);
    return `<section class="mcard ${m === now && isToday ? "now" : ""} ${shut ? "shut" : ""}" data-meal="${m}">
      <header><button class="mtoggle" type="button" aria-expanded="${!shut}"><span class="mchev" aria-hidden="true">›</span><h2>${LABEL[m] || m}</h2>
        <span class="mk">${all.length ? `${C.fmt(kc)} kcal${shut ? ` · ${all.length} ${all.length === 1 ? "item" : "items"}` : ""}` : ""}</span></button>
        <button class="madd" data-add="${m}" aria-label="Iets toevoegen aan ${(LABEL[m] || m).toLowerCase()}">+</button></header>
      <div class="mbody">
      ${plan.map((p) => { const q = Number(p.portions) || 1; return `<label class="mplan ${p.eaten ? "eaten" : ""}">
          <input type="checkbox" data-plan="${p.id}" ${p.eaten ? "checked" : ""}>
          <span class="mi-t">${C.esc(p.r.name)}<small>${p.eaten ? "gegeten · " : "gepland · "}${q !== 1 ? `${C.fmt(q, 2)} porties ` : ""}${pkv((Number(p.r.protein) || 0) * q, (Number(p.r.carbs) || 0) * q, (Number(p.r.fat) || 0) * q)}</small></span>
          <span class="mi-k">${C.fmt((Number(p.r.kcal) || 0) * q)}</span></label>`; }).join("")}
      ${list.map((i) => `<div class="mi selmode ${sel.has(i.id) ? "sel" : ""} ${i.skipped ? "skip" : ""}" data-id="${i.id}">
          <button class="mi-cb" type="button" role="checkbox" aria-checked="${sel.has(i.id)}" aria-label="${C.esc(i.name)} selecteren"></button>
          <button class="mi-t" type="button" aria-label="${C.esc(i.name)} aanpassen">${C.esc(i.name)}<small>${i.skipped ? "niet gegeten · " : ""}${i.grams != null ? `${C.fmt(i.grams)} g ` : ""}${pkv(i.protein, i.carbs, i.fat)}</small></button>
          <span class="mi-k">${C.fmt(i.kcal)}</span>
          </div>`).join("")}
      ${sugg[m].length && (!list.length || (isToday && m === now) || sugg[m].some((x) => x.pair)) ? `<div class="sugg">${sugg[m].some((x) => x.pair) && all.length ? `<span class="sugg-h">Vaak samen met wat je al at:</span>` : ""}${sugg[m].map((s, k) => `<button class="sg ${s.pair ? "pair" : ""}" data-sg="${k}"><span>${s.pair ? "＋ " : ""}${C.esc(short(s.name))}</span><small>${C.fmt(s.kcal)}</small></button>`).join("")}</div>`
        : !list.length && !plan.length ? `<p class="mempty">Nog niets. Tik op + om iets toe te voegen.</p>` : ""}
      </div>
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
    ${menu.length ? (() => { const e = menu.filter((i) => i.eaten).length; return `<div class="mp-planbar"><span class="small">Weekmenu: <b>${e} van ${menu.length}</b> gegeten</span>
      ${e < menu.length ? `<button class="chip" id="eatAll">✓ Rest afvinken</button>` : `<span class="small ok-badge">✓ alles gelogd</span>`}</div>`; })() : ""}
    ${meals.map(mealCard).join("")}
    <div class="selbar" id="selBar" hidden><span id="selN"></span>
      <button id="selSkip">Niet gegeten</button><button id="selEat" class="ok">✓ Gegeten</button>
      <button id="selCopy">Kopieer naar…</button><button id="selRecipe">Maak recept</button><button id="selDel" class="danger">Verwijder</button><button id="selClear" class="ghost" aria-label="Selectie wissen">✕</button></div>
    <button class="searchbar big" id="search"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Zoek iets om toe te voegen…</button>
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
  C.view.querySelector("#eatAll")?.addEventListener("click", async (ev) => {
    ev.currentTarget.disabled = true;
    try { const k = await C.rpc("mp_day_eaten", { p_week_id: menu[0].week_id, p_day: day, p_eaten: true }); C.toast(`${k} maaltijden uit je menu gelogd`); reload(); }
    catch (e) { C.toast(e.message, 5000); reload(); }
  });
  C.view.querySelector("#search").onclick = () => openAddFood(C, { day, meal: isToday ? now : "Lunch", after: reload });
  // ---- selecteren: kopiëren, recept/maaltijd maken, verwijderen ----
  const updSel = () => { const b = C.view.querySelector("#selN"); if (!b) return;
    b.textContent = `${sel.size} geselecteerd`;
    const ch = items.filter((i) => sel.has(i.id));
    C.view.querySelector("#selSkip").hidden = !ch.some((i) => !i.skipped);
    C.view.querySelector("#selEat").hidden = !ch.some((i) => i.skipped);
    C.view.querySelector("#selBar").hidden = !sel.size; };
  C.view.querySelector("#selClear").onclick = () => { sel.clear(); C.view.querySelectorAll(".mi.sel").forEach((r) => { r.classList.remove("sel"); r.querySelector(".mi-cb")?.setAttribute("aria-checked", "false"); }); updSel(); };
  updSel();
  const chosen = () => items.filter((i) => sel.has(i.id));
  C.view.querySelector("#selDel")?.addEventListener("click", async () => {
    const ids = [...sel]; if (!ids.length) return;
    await C.rpc("void_food_many", { p_ids: ids });
    const back = chosen();
    sel.clear(); reload();
    C.toast(`${ids.length} verwijderd`, 6000, { label: "Ongedaan maken", run: async () => {
      for (const it of back) {
        const p = it.food_id && it.grams ? { day: it.day, meal: it.meal, grams: it.grams, food: { id: it.food_id } }
          : { day: it.day, meal: it.meal, name: it.name, kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat };
        await C.rpc("log_food", { p });
      }
      reload(); } });
  });
  const setEaten = async (eaten) => {
    const ids = chosen().filter((i) => !!i.skipped === eaten).map((i) => i.id); if (!ids.length) return;
    try {
      await C.rpc("food_set_eaten", { p_ids: ids, p_eaten: eaten });
      sel.clear(); reload();
      C.toast(eaten ? `${ids.length} terug op gegeten` : `${ids.length} op niet gegeten (telt niet mee)`, 5000,
        { label: "Ongedaan maken", run: async () => { await C.rpc("food_set_eaten", { p_ids: ids, p_eaten: !eaten }); reload(); } });
    } catch (e) { C.toast(e.message, 5000); }
  };
  C.view.querySelector("#selSkip").onclick = () => setEaten(false);
  C.view.querySelector("#selEat").onclick = () => setEaten(true);
  C.view.querySelector("#selCopy")?.addEventListener("click", () => copySheet(chosen(), day, () => { sel.clear(); reload(); }));
  C.view.querySelector("#selRecipe")?.addEventListener("click", () => makeRecipe(chosen(), day, () => { sel.clear(); reload(); }));
  C.view.querySelector("details.panel").addEventListener("toggle", (e) => {
    if (e.target.open && !e.target.dataset.loaded) { e.target.dataset.loaded = 1; renderRecipes(C, day, C.view.querySelector("#recipes"), reload); }
  });

  C.view.querySelectorAll(".mcard").forEach((card) => {
    const meal = card.dataset.meal;
    card.querySelector("[data-add]").onclick = () => openAddFood(C, { day, meal, after: reload });
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
    card.querySelectorAll("[data-plan]").forEach((cb) => (cb.onchange = async () => {
      const p = menu.find((i) => i.id === Number(cb.dataset.plan));
      cb.disabled = true;
      try { await C.rpc("mp_item_eaten", { p_item_id: p.id, p_eaten: cb.checked }); reload(); }
      catch (e) { cb.checked = !cb.checked; cb.disabled = false; C.toast(e.message, 5000); }
    }));
    card.querySelector(".mtoggle").onclick = () => {
      const shut = !card.classList.contains("shut");
      card.classList.toggle("shut", shut); card.querySelector(".mtoggle").setAttribute("aria-expanded", String(!shut));
      shut ? closedMeals.add(meal) : closedMeals.delete(meal); saveClosed();
    };
    card.querySelectorAll(".mi .mi-cb").forEach((b) => (b.onclick = () => {
      const row = b.closest(".mi"), id = row.dataset.id;
      sel.has(id) ? sel.delete(id) : sel.add(id);
      row.classList.toggle("sel", sel.has(id)); b.setAttribute("aria-checked", String(sel.has(id))); updSel();
    }));
    card.querySelectorAll(".mi .mi-t").forEach((b) => (b.onclick = () => openEditFood(C, items.find((i) => i.id === b.closest(".mi").dataset.id), reload)));
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


// ---------- kopiëren naar een andere dag / maaltijd ----------
function copySheet(list, day, done) {
  if (!list.length) return;
  const sh = document.createElement("div"); sh.className = "sheet"; document.body.appendChild(sh);
  const close = () => sh.remove();
  sh.addEventListener("click", (e) => { if (e.target === sh) close(); });
  const lbl = (m) => (m === "Laat" ? "Avondsnack" : m);
  const days = [[C.addDays(C.today(), -1), "Gisteren"], [C.today(), "Vandaag"], [C.addDays(C.today(), 1), "Morgen"], [C.addDays(C.today(), 2), "Overmorgen"]];
  let toDay = day === C.today() ? C.addDays(day, 1) : C.today(), toMeal = "";
  sh.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Kopiëren">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">${list.length} ${list.length === 1 ? "item" : "items"} kopiëren</h3><button class="icon-btn" data-x aria-label="Sluiten">✕</button></div>
    <p class="small muted" style="margin:6px 0 0">${C.esc(list.map((i) => i.name).join(", "))}</p>
    <div class="sub-h">Naar welke dag?</div>
    <div class="chips" id="cD">${days.map(([d, l]) => `<button class="chip ${d === toDay ? "on" : ""}" data-d="${d}">${l}</button>`).join("")}
      <input type="date" class="input" id="cDate" value="${toDay}" style="max-width:160px"></div>
    <div class="sub-h">Bij welke maaltijd?</div>
    <div class="chips" id="cM"><button class="chip on" data-m="">Zelfde als nu</button>${MEALS.map((m) => `<button class="chip" data-m="${m}">${lbl(m)}</button>`).join("")}</div>
    <button class="btn" id="cGo" style="width:100%;margin-top:16px">Kopiëren</button></div>`;
  sh.querySelector("[data-x]").onclick = close;
  const setDay = (d) => { toDay = d; sh.querySelector("#cDate").value = d; sh.querySelectorAll("#cD .chip").forEach((c) => c.classList.toggle("on", c.dataset.d === d)); };
  sh.querySelector("#cD").onclick = (e) => { const b = e.target.closest(".chip"); if (b) setDay(b.dataset.d); };
  sh.querySelector("#cDate").onchange = (e) => e.target.value && setDay(e.target.value);
  sh.querySelector("#cM").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; toMeal = b.dataset.m; sh.querySelectorAll("#cM .chip").forEach((c) => c.classList.toggle("on", c === b)); };
  sh.querySelector("#cGo").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const ids = await C.rpc("copy_food_items", { p_ids: list.map((i) => i.id), p_day: toDay, p_meal: toMeal || null });
      close(); done();
      C.toast(`${list.length} gekopieerd naar ${days.find(([d]) => d === toDay)?.[1].toLowerCase() || toDay}`, 6000,
        { label: "Ongedaan maken", run: async () => { await C.rpc("void_food_many", { p_ids: ids }); done(); } });
    } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
  };
}

// ---------- recept of maaltijd maken van de selectie ----------
async function makeRecipe(list, day, done) {
  if (!list.length) return;
  const allFood = list.every((i) => i.food_id && Number(i.grams) > 0);
  if (allFood) {
    // echt recept: ingrediënten met gram; waarden per 100 g uit wat je logde
    const ingredients = list.map((i) => { const g = Number(i.grams);
      return { food: { id: i.food_id, name: i.name, per100: { kcal: i.kcal * 100 / g, protein: i.protein * 100 / g, carbs: i.carbs * 100 / g, fat: i.fat * 100 / g } }, grams: g }; });
    done();
    openAddFood(C, { day, recipeFrom: ingredients, after: done });
    return;
  }
  // niet alles heeft een gewicht (bv. snel kcal of een menu-portie): bewaar als maaltijd
  const name = prompt("Naam voor deze maaltijd (komt bij Vaak samen → Mijn maaltijden):", list.map((i) => i.name).slice(0, 2).join(" + "));
  if (!name) return;
  try {
    await C.rpc("save_meal_preset", { p: { name, items: list.map((i) => ({ food_id: i.food_id, grams: i.grams, name: i.name, kcal: i.kcal, protein: i.protein, carbs: i.carbs, fat: i.fat, fiber: i.fiber })) } });
    done(); C.toast(`"${name}" bewaard bij Mijn maaltijden`, 4000);
  } catch (err) { C.toast(err.message, 5000); }
}
