// Voeding loggen in Health Hub: zoeken (eigen producten + Open Food Facts),
// barcode scannen, portie kiezen, per maaltijd bijhouden,
// maaltijden kopiëren, vaste maaltijden en recepten.
let C;
export const MEALS = ["Ontbijt", "Lunch", "Snack", "Avondeten", "Laat"];
import { check, enterSubmits, readLabel } from "./formkit.js";
const MACROS = [["kcal", "kcal", ""], ["protein", "Eiwit", "g"], ["carbs", "Koolh.", "g"], ["fat", "Vet", "g"]];

const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function mealForNow() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hour12: false }).format(new Date()));
  if (h < 11) return "Ontbijt";
  if (h < 15) return "Lunch";
  if (h < 18) return "Snack";
  if (h < 22) return "Avondeten";
  return "Laat";
}
const scale = (per100, g) => Object.fromEntries(MACROS.map(([k]) => [k, per100?.[k] == null ? null : (Number(per100[k]) * g) / 100]));
const numIn = (v) => { const x = String(v ?? "").trim().replace(",", "."); return x === "" || Number.isNaN(Number(x)) ? null : Number(x); };

// Meerdere items gelogd → toast met ongedaan maken
function undoMany(ids, label, after) {
  C.toast(label, 5000, {
    label: "Ongedaan maken",
    run: async () => { await C.rpc("void_food_many", { p_ids: ids }); C.toast("Ongedaan gemaakt"); after?.(); },
  });
}

// ---------------- daglijst per maaltijd ----------------
export async function renderFoodLog(ctx, day, box, after) {
  C = ctx;
  const items = await C.rpc("get_food_log", { p_day: day });
  const isToday = day === todayIso();
  if (!items.length) {
    box.innerHTML = `<p class="muted small" style="margin:0">Nog niets gelogd in Health Hub op deze dag.</p>`;
    return;
  }
  const by = Object.fromEntries(MEALS.map((m) => [m, items.filter((i) => i.meal === m)]));
  box.innerHTML = MEALS.filter((m) => by[m].length).map((m) => {
    const tot = by[m].reduce((s, i) => s + (Number(i.kcal) || 0), 0);
    return `<div class="fmeal" data-meal="${m}"><div class="fmeal-h"><b>${m}</b>
        <span class="fmeal-act">
          <button class="linkbtn fsave" title="Bewaren als vaste maaltijd">★ Bewaar</button>
          ${!isToday ? `<button class="linkbtn fcopy" title="Kopieer naar vandaag">⧉ Naar vandaag</button>` : ""}
          <span>${C.fmt(tot)} kcal</span></span></div>
      ${by[m].map((i) => `<div class="fitem" data-id="${i.id}">
        <span><span class="t">${C.esc(i.name)}</span>
          <span class="m">${i.grams != null ? `${C.fmt(i.grams)} g · ` : ""}E ${C.fmt(i.protein)} · K ${C.fmt(i.carbs)} · V ${C.fmt(i.fat)}</span></span>
        <span class="k">${C.fmt(i.kcal)}</span>
        <button class="icon-btn fdel" aria-label="${C.esc(i.name)} verwijderen">✕</button>
      </div>`).join("")}</div>`;
  }).join("") + (!isToday ? `<button class="btn secondary" id="fCopyDay" style="width:100%;margin-top:10px">⧉ Hele dag kopiëren naar vandaag</button>` : "");

  box.querySelector("#fCopyDay")?.addEventListener("click", async () => {
    const ids = await C.rpc("copy_meal", { p_from: day, p_meal: null, p_to: todayIso(), p_to_meal: null });
    undoMany(ids, `${ids.length} items gekopieerd naar vandaag`, after);
  });
  box.onclick = async (e) => {
    const mealEl = e.target.closest(".fmeal");
    if (e.target.closest(".fsave")) {
      const meal = mealEl.dataset.meal;
      const name = prompt("Naam voor deze maaltijd", meal === "Ontbijt" ? "Mijn ontbijt" : `Mijn ${meal.toLowerCase()}`);
      if (!name) return;
      try { await C.rpc("save_meal_preset", { p: { name, from_day: day, from_meal: meal } }); C.toast(`"${name}" bewaard bij Mijn maaltijden`); }
      catch (err) { C.toast(err.message, 5000); }
      return;
    }
    if (e.target.closest(".fcopy")) {
      const meal = mealEl.dataset.meal;
      const ids = await C.rpc("copy_meal", { p_from: day, p_meal: meal, p_to: todayIso(), p_to_meal: meal });
      undoMany(ids, `${meal} gekopieerd naar vandaag`, after);
      return;
    }
    const b = e.target.closest(".fdel"); if (!b) return;
    const it = items.find((i) => i.id === b.closest(".fitem").dataset.id);
    await C.rpc("void_food", { p_id: it.id });
    C.toast(`${it.name} verwijderd`, 5000, {
      label: "Ongedaan maken",
      run: async () => {
        const p = it.food_id && it.grams
          ? { day: it.day, meal: it.meal, grams: it.grams, food: { id: it.food_id } }
          : { day: it.day, meal: it.meal, name: it.name, kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat };
        await C.rpc("log_food", { p }); after?.();
      },
    });
    after?.();
  };
}

// ---------------- toevoegen ----------------
// ---------------- recepten-overzicht ----------------
export async function renderRecipes(ctx, day, box, after) {
  C = ctx;
  const list = (await C.rpc("get_foods", { p_query: null, p_limit: 500 })).filter((f) => f.source === "recipe");
  if (!list.length) {
    box.innerHTML = `<p class="muted small" style="margin:0">Nog geen recepten. Maak er een uit ingrediënten (zoeken of scannen), met het aantal porties: daarna log je een portie in één tik.</p>`;
    return;
  }
  box.innerHTML = list.map((r, i) => `<div class="fitem" data-i="${i}">
      <button class="rlog" style="all:unset;cursor:pointer"><span class="t">${C.esc(r.name)}</span>
        <span class="m">${C.fmt(r.recipe?.servings)} porties · ${C.fmt((r.per100?.kcal || 0) * (r.serving_g || 100) / 100)} kcal en ${C.fmt((r.per100?.protein || 0) * (r.serving_g || 100) / 100)} g eiwit per portie</span></button>
      <button class="linkbtn redit">Bewerk</button>
      <button class="icon-btn rarch" aria-label="${C.esc(r.name)} verwijderen">✕</button></div>`).join("");
  box.querySelectorAll(".fitem").forEach((row) => {
    const r = list[Number(row.dataset.i)];
    row.querySelector(".rlog").onclick = () => openAddFood(ctx, { day, after, product: r });
    row.querySelector(".redit").onclick = () => openAddFood(ctx, { day, after, editRecipe: r });
    row.querySelector(".rarch").onclick = async () => {
      if (!confirm(`Recept "${r.name}" verwijderen? Al gelogde porties blijven staan.`)) return;
      await C.rpc("save_food", { p: { id: r.id, archived: true } });
      after?.();
    };
  });
}

// Alleen een product kiezen (bv. als ingrediënt van een menu-recept): onPick(food, gram).
export function pickFood(ctx, onPick, { initial = "" } = {}) {
  return openAddFood(ctx, { day: todayIso(), onPick, initial });
}

export function openAddFood(ctx, { day, meal = mealForNow(), after, start = null, product = null, editRecipe: toEdit = null, onPick = null, initial = "" } = {}) {
  C = ctx;
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  document.body.appendChild(sheet);
  let scanner = null;
  const close = () => { scanner?.stop(); sheet.remove(); };
  sheet._close = close;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });

  // recept in opbouw (null = gewone modus); in "pick"-modus kies je ingrediënten
  let recipe = null;
  let picking = !!onPick;
  // product gekozen in pick-modus: eerst bewaren (een id is nodig), dan teruggeven
  const picked = async (food, g) => {
    try {
      const f = food.id ? food : await C.rpc("save_food", { p: { barcode: food.barcode, name: food.name, brand: food.brand, per100: food.per100,
        serving_g: food.serving_g, serving_label: food.serving_label, source: food.source || "off" } });
      close(); onPick(f, g);
    } catch (err) { C.toast(err.message, 5000); }
  };

  const head = (title, back) => `<div class="row" style="justify-content:space-between;flex-wrap:nowrap">
      ${back ? `<button class="icon-btn" data-back aria-label="Terug">‹</button>` : ""}
      <h3 style="margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${title}</h3><button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>`;
  const home = () => (onPick ? close() : picking ? recipeEditor() : search());
  const wire = (onBack) => {
    sheet.querySelector("[data-close]").onclick = close;
    sheet.querySelector("[data-back]")?.addEventListener("click", () => (onBack || home)());
  };
  const mealChips = () => (picking ? "" : `<div class="chips" id="fMeal" style="margin:10px 0">${MEALS.map((m) =>
    `<button class="chip ${m === meal ? "on" : ""}" data-m="${m}">${m === "Laat" ? "Avondsnack" : m}</button>`).join("")}</div>`);
  const bindMeal = (onChange) => sheet.querySelector("#fMeal")?.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    meal = b.dataset.m;
    sheet.querySelectorAll("#fMeal .chip").forEach((c) => c.classList.toggle("on", c === b));
    onChange?.();
  });

  // ---- één zoek- en kiesscherm ----
  // Bovenaan één zoekveld dat alles doorzoekt: je menu, vaste producten, wat je vaak eet,
  // je recepten, je eigen producten en Open Food Facts. Elke rij: tik = hoeveelheid kiezen, + = meteen toevoegen.
  let local = [], remote = [], seq = 0, remoteState = "";
  let Q = null; // snelle data: { products, frequent, recipes, presets, yesterday, menu }
  const REG = new Map();
  const SLOT = { Ontbijt: "ontbijt", Lunch: "lunch", Snack: "snack", Avondeten: "avond", Laat: "avondsnack" };
  const mealLabel = (m) => (m === "Laat" ? "Avondsnack" : m);
  async function loadQuick() {
    if (Q) return Q;
    const [qa, presets, yest, menu] = await Promise.all([
      C.rpc("get_quick_add").catch(() => ({})),
      C.rpc("get_meal_presets").catch(() => []),
      C.rpc("get_food_log", { p_day: addDays(day, -1) }).catch(() => []),
      day === todayIso() ? C.rpc("mp_get").then((m) => {
        const w = m.weeks?.find((x) => x.id === m.current_week_id);
        return (w?.items || []).filter((i) => i.day === day).map((i) => ({ ...i, r: m.recipes.find((r) => r.id === i.recipe_id) })).filter((i) => i.r);
      }).catch(() => []) : Promise.resolve([]),
    ]);
    Q = { products: qa.products || [], frequent: qa.frequent || {}, recipes: qa.recipes || [], presets, yesterday: yest, menu };
    return Q;
  }
  const kc = (v) => (v == null ? "–" : C.fmt(v));
  const per100From = (x) => { const g = Number(x.grams) || 0; if (!g) return null;
    return { kcal: x.kcal * 100 / g, protein: x.protein * 100 / g, carbs: x.carbs * 100 / g, fat: x.fat * 100 / g }; };
  // registreer een rij en geef de html terug
  function row(entry) {
    const key = "k" + REG.size;
    REG.set(key, entry);
    return `<div class="fi" data-key="${key}"><button class="fi-main" type="button"><b>${C.esc(entry.title)}</b><span>${entry.sub}</span></button>
      <button class="fi-add" type="button" aria-label="${C.esc(entry.title)} toevoegen">+</button></div>`;
  }
  const foodEntry = (p, extra = "") => {
    const per = p.per100 || {}, g = p.serving_g || 100, kcal = per.kcal != null ? per.kcal * g / 100 : null;
    return { kind: "food", food: p, title: p.name + (p.brand && !p.name.includes(p.brand) ? ` · ${p.brand}` : ""),
      sub: `${p.serving_g ? C.esc(p.serving_label && p.serving_label !== "1 portie" ? p.serving_label : C.fmt(g) + " g") : "100 g"} · ${kc(kcal)} kcal${extra}` };
  };
  const portionEntry = (x, q = 1, extra = "") => ({ kind: "portion", item: { name: x.name, kcal: Number(x.kcal) || 0, protein: Number(x.protein) || 0, carbs: Number(x.carbs) || 0, fat: Number(x.fat) || 0 }, q,
    title: x.name, sub: `${q === 1 ? "1 portie" : C.fmt(q, 2) + " porties"} · ${kc(x.kcal * q)} kcal · ${C.fmt(x.protein * q)} g eiwit${extra}` });

  function search(initial = "") {
    scanner?.stop(); scanner = null;
    sheet.innerHTML = `<div class="sheet-card add-sheet" role="dialog" aria-label="${picking ? "Ingrediënt kiezen" : "Eten toevoegen"}">
      ${head(picking ? "Ingrediënt kiezen" : "Eten toevoegen", picking)}
      ${picking ? "" : `<div class="chips meals" id="fMeal">${MEALS.map((m) => `<button class="chip ${m === meal ? "on" : ""}" data-m="${m}">${mealLabel(m)}</button>`).join("")}</div>`}
      <div class="searchrow">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="fQ" placeholder="Zoek in alles: product, recept, merk…" autocomplete="off" enterkeyhint="search" value="${C.esc(initial)}">
        <button class="scanbtn" id="fScan" type="button" aria-label="Barcode scannen">▥</button>
      </div>
      <div class="actions">
        <button class="act" id="fCustom" type="button">📷 Nieuw product</button>
        ${picking ? "" : `<button class="act" id="fQuick" type="button">⚡ Snel kcal</button><button class="act" id="fRecipe" type="button">🍲 Recept maken</button>`}
      </div>
      <div id="fRes"></div>
    </div>`;
    wire();
    sheet.querySelector("#fMeal")?.addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      meal = b.dataset.m;
      sheet.querySelectorAll("#fMeal .chip").forEach((c) => c.classList.toggle("on", c === b));
      list();
    });
    const q = sheet.querySelector("#fQ");
    let t1, t2;
    q.oninput = () => {
      clearTimeout(t1); clearTimeout(t2);
      const term = q.value.trim();
      const my = ++seq;
      t1 = setTimeout(async () => { local = await C.rpc("get_foods", { p_query: term || null, p_limit: term ? 20 : 12 }).catch(() => []); if (my === seq) list(); }, 120);
      remote = []; remoteState = term.length >= 3 ? "loading" : "";
      if (term.length >= 3) t2 = setTimeout(async () => {
        try { const r = await C.invoke("food", { q: term }); if (my === seq) { remote = r.products || []; remoteState = ""; list(); } }
        catch (e) { if (my === seq) { remoteState = "fout: " + e.message; list(); } }
      }, 500);
      list();
    };
    q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); sheet.querySelector(".fi-main")?.click(); } };
    sheet.querySelector("#fScan").onclick = scan;
    sheet.querySelector("#fQuick")?.addEventListener("click", quick);
    sheet.querySelector("#fCustom").addEventListener("click", () => custom({ name: q.value.trim() }));
    sheet.querySelector("#fRecipe")?.addEventListener("click", () => { recipe = { name: "", servings: 1, total_g: "", ingredients: [] }; recipeEditor(); });
    sheet.querySelector("#fRes").addEventListener("click", onRowClick);
    if (!picking) loadQuick().then(() => list());
    q.oninput();
    if (!initial) setTimeout(() => q.focus(), 60);
  }

  function list() {
    const box = sheet.querySelector("#fRes"); if (!box) return;
    REG.clear();
    const term = sheet.querySelector("#fQ").value.trim().toLowerCase();
    const match = (s) => !term || String(s || "").toLowerCase().includes(term);
    const sec = (title, rows) => (rows.length ? `<div class="fi-h">${title}</div>${rows.join("")}` : "");
    let html = "";
    const shownFoods = new Set();
    if (!picking && Q) {
      const slot = SLOT[meal];
      const menu = Q.menu.filter((i) => (term ? true : i.slot === slot) && match(i.r.name));
      html += sec(term ? "Op je menu" : `Op je menu: ${mealLabel(meal).toLowerCase()}`, menu.map((i) => row(portionEntry(i.r, Number(i.portions) || 1))));
      const y = Q.yesterday.filter((i) => i.meal === meal);
      if (!term && y.length) {
        const key = "k" + REG.size;
        REG.set(key, { kind: "yesterday" });
        html += `<div class="fi" data-key="${key}"><button class="fi-main" type="button"><b>⧉ ${C.esc(mealLabel(meal))} van gisteren</b><span>${C.esc(y.map((i) => i.name).join(", "))} · ${kc(y.reduce((s, i) => s + (Number(i.kcal) || 0), 0))} kcal</span></button><button class="fi-add" type="button" aria-label="Herhalen">+</button></div>`;
      }
      const freq = (Q.frequent[meal] || []).filter((f) => match(f.name)).slice(0, term ? 6 : 5);
      html += sec(term ? "Vaak gegeten" : `Vaak bij ${mealLabel(meal).toLowerCase()}`, freq.map((f) => {
        if (f.food_id && f.grams) { shownFoods.add(f.food_id); return row(foodEntry({ id: f.food_id, name: f.name, brand: f.brand, per100: per100From(f), serving_g: f.grams }, ` · ${f.n}×`)); }
        return row(portionEntry(f, 1, ` · ${f.n}×`));
      }));
      const prods = Q.products.filter((p) => match(p.name) || match(p.brand));
      prods.forEach((p) => shownFoods.add(p.id));
      html += sec("Vaste producten", prods.map((p) => row(foodEntry(p))));
      const recs = Q.recipes.filter((r) => (term ? match(r.name) : r.meal_type === slot));
      html += sec("Recepten", recs.map((r) => row(portionEntry({ ...r, name: (r.favorite ? "★ " : "") + r.name }))));
      const pres = Q.presets.filter((p) => match(p.name));
      html += sec("Mijn maaltijden", pres.map((p) => { const key = "k" + REG.size; REG.set(key, { kind: "preset", preset: p });
        return `<div class="fi" data-key="${key}"><button class="fi-main" type="button"><b>${C.esc(p.name)}</b><span>${C.esc(p.items.map((x) => x.name).join(", "))} · ${kc(p.kcal)} kcal</span></button><button class="fi-add" type="button" aria-label="Toevoegen">+</button></div>`; }));
    }
    const loc = (picking ? local.filter((p) => p.source !== "recipe") : local).filter((p) => !shownFoods.has(p.id));
    const seen = new Set(local.map((p) => p.barcode).filter(Boolean));
    const rem = remote.filter((p) => !p.barcode || !seen.has(p.barcode));
    html += sec(term ? "Mijn producten" : "Recent", loc.map((p) => row(foodEntry(p))));
    html += sec("Open Food Facts", rem.map((p) => row(foodEntry(p))));
    if (remoteState === "loading") html += `<p class="muted small fi-note">Zoeken in Open Food Facts…</p>`;
    else if (remoteState) html += `<p class="muted small fi-note">Open Food Facts: ${C.esc(remoteState)}</p>`;
    if (!html) html = `<p class="muted fi-note">${term ? "Niets gevonden. Scan de barcode of tik op 📷 Nieuw product en fotografeer het etiket." : "Zoek een product of scan een barcode."}</p>`;
    if (!picking && !term) html += `<button class="linkbtn" id="fManage" style="margin:14px 2px 0">Vaste producten beheren</button>`;
    box.innerHTML = html;
    box.querySelector("#fManage")?.addEventListener("click", manage);
  }

  async function onRowClick(e) {
    const rowEl = e.target.closest(".fi"); if (!rowEl) return;
    const en = REG.get(rowEl.dataset.key); if (!en) return;
    const add = !!e.target.closest(".fi-add");
    if (en.kind === "food") {
      if (!add) return amount(en.food);
      const g = en.food.serving_g || 100;
      if (onPick) return picked(en.food, g);
      if (picking) { recipe.ingredients.push({ food: en.food, grams: g }); picking = false; return recipeEditor(); }
      return quickLog(rowEl, { day, meal, grams: g, food: foodRef(en.food) }, en.food.name);
    }
    if (en.kind === "portion") {
      if (!add) return portion(en.item, en.q);
      const x = en.item, q = en.q;
      return quickLog(rowEl, { day, meal, name: x.name.replace(/^★ /, ""), kcal: x.kcal * q, protein: x.protein * q, carbs: x.carbs * q, fat: x.fat * q }, x.name);
    }
    if (en.kind === "yesterday") {
      rowEl.classList.add("busy");
      const ids = await C.rpc("copy_meal", { p_from: addDays(day, -1), p_meal: meal, p_to: day, p_to_meal: meal });
      close(); undoMany(ids, `${mealLabel(meal)} van gisteren toegevoegd`, after); after?.(); return;
    }
    if (en.kind === "preset") {
      rowEl.classList.add("busy");
      const ids = await C.rpc("log_meal_preset", { p_id: en.preset.id, p_day: day, p_meal: meal });
      close(); undoMany(ids, `${en.preset.name} toegevoegd`, after); after?.();
    }
  }
  const foodRef = (p) => (p.id ? { id: p.id } : { barcode: p.barcode, name: p.name, brand: p.brand, per100: p.per100, serving_g: p.serving_g, serving_label: p.serving_label, source: p.source || "off" });
  async function quickLog(rowEl, payload, label) {
    const btn = rowEl.querySelector(".fi-add");
    if (btn.disabled) return;
    btn.disabled = true; rowEl.classList.add("busy");
    try {
      const r = await C.rpc("log_food", { p: payload });
      btn.textContent = "✓"; rowEl.classList.remove("busy"); rowEl.classList.add("done");
      undoMany([r.id], `${label.replace(/^★ /, "")} · ${C.fmt(r.kcal)} kcal bij ${mealLabel(meal).toLowerCase()}`, after);
      after?.();
    } catch (err) { btn.disabled = false; rowEl.classList.remove("busy"); C.toast(err.message, 4000); }
  }

  // Porties kiezen voor een recept of menu-item
  function portion(x, q0 = 1) {
    let q = q0;
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${C.esc(x.name)}">
      ${head(C.esc(x.name.replace(/^★ /, "")), true)}
      <div class="chips meals" id="fMeal" style="margin:10px 0">${MEALS.map((m) => `<button class="chip ${m === meal ? "on" : ""}" data-m="${m}">${mealLabel(m)}</button>`).join("")}</div>
      <div class="stepper"><button type="button" data-d="-0.25" aria-label="Minder">−</button><output id="pQ"></output><button type="button" data-d="0.25" aria-label="Meer">+</button></div>
      <div class="chips" style="justify-content:center;margin:8px 0 12px">${[0.5, 1, 1.5, 2].map((v) => `<button class="chip" data-q="${v}">${String(v).replace(".", ",")}</button>`).join("")}</div>
      <div class="macros" id="pLive" style="grid-template-columns:repeat(4,1fr)"></div>
      <button class="btn" id="pAdd" style="width:100%;margin-top:14px"></button></div>`;
    wire();
    sheet.querySelector("#fMeal").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; meal = b.dataset.m; sheet.querySelectorAll("#fMeal .chip").forEach((c) => c.classList.toggle("on", c === b)); live(); };
    const live = () => {
      sheet.querySelector("#pQ").textContent = `${C.fmt(q, 2)} ${q === 1 ? "portie" : "porties"}`;
      const v = { kcal: x.kcal * q, protein: x.protein * q, carbs: x.carbs * q, fat: x.fat * q };
      sheet.querySelector("#pLive").innerHTML = MACROS.map(([k, l, u]) => `<div class="macro m-${k}"><div class="v">${C.fmt(v[k])}${u ? `<small> ${u}</small>` : ""}</div><div class="l">${l}</div></div>`).join("");
      sheet.querySelector("#pAdd").textContent = `Toevoegen aan ${mealLabel(meal).toLowerCase()}`;
    };
    sheet.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => { q = Math.max(0.25, Math.round((q + Number(b.dataset.d)) * 4) / 4); live(); }));
    sheet.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => { q = Number(b.dataset.q); live(); }));
    live();
    sheet.querySelector("#pAdd").onclick = async (e) => {
      e.target.disabled = true;
      try {
        const r = await C.rpc("log_food", { p: { day, meal, name: x.name.replace(/^★ /, ""), kcal: x.kcal * q, protein: x.protein * q, carbs: x.carbs * q, fat: x.fat * q } });
        close(); undoMany([r.id], `${x.name.replace(/^★ /, "")} · ${C.fmt(r.kcal)} kcal bij ${mealLabel(meal).toLowerCase()}`, after); after?.();
      } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
    };
  }

  // Vaste producten aan/uit zetten
  async function manage() {
    const recent = (await C.rpc("get_foods", { p_query: null, p_limit: 40 }).catch(() => [])).filter((f) => f.source !== "recipe");
    const ids = new Set((Q?.products || []).map((p) => p.id));
    const all = [...(Q?.products || []), ...recent.filter((f) => !ids.has(f.id))];
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Vaste producten">
      ${head("Vaste producten", true)}
      <p class="hint small" style="margin:8px 0">Vink aan wat bovenaan moet staan om met één tik toe te voegen.</p>
      ${all.map((f) => `<label class="mp-check"><input type="checkbox" data-id="${f.id}" ${ids.has(f.id) ? "checked" : ""}>
        <span class="t">${C.esc(f.name)}${f.brand ? ` <span class="muted">(${C.esc(f.brand)})</span>` : ""}${f.serving_g ? ` <span class="small muted">· ${C.fmt(f.serving_g)} g</span>` : ""}</span></label>`).join("")}</div>`;
    wire(() => { Q = null; search(); });
    sheet.querySelectorAll("input[data-id]").forEach((cb) => (cb.onchange = () =>
      C.rpc("set_food_quick", { p_id: cb.dataset.id, p_quick: cb.checked }).catch((e) => { cb.checked = !cb.checked; C.toast(e.message, 4000); })));
  }

  // ---- barcode ----
  async function scan() {
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Barcode scannen">
      ${head("Barcode scannen", true)}
      <div class="scanbox"><video id="fVid" playsinline muted autoplay></video><i></i></div>
      <p class="muted small" id="fScanMsg">Richt de camera op de barcode.</p>
      <div class="row">
        <label class="btn secondary" style="cursor:pointer">Foto kiezen<input type="file" id="fPhoto" accept="image/*" capture="environment" hidden></label>
        <input class="input" id="fCode" inputmode="numeric" placeholder="of typ de code" aria-label="Barcode">
        <button class="btn" id="fCodeGo">Zoek</button>
      </div></div>`;
    wire(() => search());
    const msg = sheet.querySelector("#fScanMsg");
    sheet.querySelector("#fCodeGo").onclick = () => { const v = sheet.querySelector("#fCode").value.replace(/\D/g, ""); if (v.length >= 6) lookup(v); };
    let reader;
    try {
      const zx = await import("https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.1/+esm");
      reader = new zx.BrowserMultiFormatReader();
      sheet.querySelector("#fPhoto").onchange = async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const url = URL.createObjectURL(f);
        try { const r = await reader.decodeFromImageUrl(url); lookup(r.getText()); }
        catch { msg.textContent = "Geen barcode gevonden op de foto. Probeer dichterbij en scherp."; }
        finally { URL.revokeObjectURL(url); }
      };
      let done = false;
      scanner = await reader.decodeFromConstraints({ video: { facingMode: "environment" } }, sheet.querySelector("#fVid"), (res) => {
        if (res && !done) { done = true; navigator.vibrate?.(60); lookup(res.getText()); }
      });
    } catch (e) {
      msg.textContent = /Permission|NotAllowed/i.test(String(e?.name || e))
        ? "Geen cameratoegang. Sta de camera toe in Instellingen → Safari, of kies een foto."
        : "Camera niet beschikbaar. Kies een foto of typ de code.";
    }
  }
  async function lookup(code) {
    scanner?.stop(); scanner = null;
    sheet.querySelector(".sheet-card").innerHTML = `${head("Barcode " + C.esc(code), true)}<p class="muted">Zoeken…</p>`;
    wire(() => search());
    try {
      const mine = (await C.rpc("get_foods", { p_query: code, p_limit: 1 })).find((p) => p.barcode === code);
      if (mine) return amount(mine);
      const r = await C.invoke("food", { barcode: code });
      if (r.product && r.product.per100?.kcal != null) return amount(r.product);
      custom({ barcode: code, name: r.product?.name || "", brand: r.product?.brand || "", per100: r.product?.per100 },
        "Niet (volledig) gevonden in Open Food Facts. Vul de waarden van het etiket in, dan onthoudt de app dit product.");
    } catch (e) {
      custom({ barcode: code }, "Opzoeken mislukt (" + e.message + "). Vul het zelf in.");
    }
  }

  // ---- hoeveelheid ----
  function amount(p) {
    const per = p.per100 || {};
    let g = p.serving_g ? Number(p.serving_g) : 100;
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Hoeveelheid">
      ${head(C.esc(p.name), true)}
      <p class="muted small" style="margin:2px 0 0">${p.brand ? C.esc(p.brand) + " · " : ""}per 100 g: ${C.fmt(per.kcal)} kcal · E ${C.fmt(per.protein, 1)} · K ${C.fmt(per.carbs, 1)} · V ${C.fmt(per.fat, 1)}</p>
      ${p.recipe ? `<p class="small muted" style="margin:4px 0 0">Recept: ${C.fmt(p.recipe.servings)} porties van ${C.fmt(p.serving_g)} g · <button class="linkbtn" id="fEditRec">Recept bewerken</button></p>` : ""}
      ${mealChips()}
      <div class="row" style="flex-wrap:nowrap;${picking ? "margin-top:10px" : ""}"><input class="input" id="fG" inputmode="decimal" value="${g}" aria-label="Hoeveelheid in gram" style="font-size:22px;font-weight:600">
        <span class="muted">gram</span></div>
      <div class="chips" style="margin:10px 0">
        ${p.serving_g ? `<button class="chip" data-g="${p.serving_g}">1 portie (${C.esc(p.serving_label && p.serving_label !== "1 portie" ? p.serving_label : C.fmt(p.serving_g) + " g")})</button>
          <button class="chip" data-g="${p.serving_g * 2}">2 porties</button>` : ""}
        ${[50, 100, 150, 200, 250].map((x) => `<button class="chip" data-g="${x}">${x} g</button>`).join("")}
      </div>
      <div class="macros" id="fLive" style="grid-template-columns:repeat(4,1fr)"></div>
      <button class="btn" id="fAdd" style="width:100%;margin-top:14px"></button>
    </div>`;
    wire(); bindMeal(() => live());
    const inp = sheet.querySelector("#fG");
    const live = () => {
      g = numIn(inp.value) || 0;
      const v = scale(per, g);
      sheet.querySelector("#fLive").innerHTML = MACROS.map(([k, l, u]) => `<div class="macro m-${k}"><div class="v">${C.fmt(v[k])}${u ? `<small> ${u}</small>` : ""}</div><div class="l">${l}</div></div>`).join("");
      sheet.querySelector("#fAdd").textContent = picking ? "Toevoegen aan recept" : `Toevoegen aan ${meal}`;
    };
    inp.oninput = live;
    sheet.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => { inp.value = b.dataset.g; live(); }));
    live();
    sheet.querySelector("#fEditRec")?.addEventListener("click", () => editRecipe(p));
    enterSubmits(sheet.querySelector(".sheet-card"), "#fAdd");
    sheet.querySelector("#fAdd").onclick = async (e) => {
      if (!check(sheet, [{ el: "#fG", ok: g > 0, msg: "Vul een hoeveelheid in grammen in." }])) return;
      if (onPick) return picked(p, g);
      if (picking) { recipe.ingredients.push({ food: p, grams: g }); picking = false; return recipeEditor(); }
      e.target.disabled = true;
      try {
        const food = p.id ? { id: p.id } : { barcode: p.barcode, name: p.name, brand: p.brand, per100: per, serving_g: p.serving_g, serving_label: p.serving_label, source: p.source || "off" };
        const r = await C.rpc("log_food", { p: { day, meal, grams: g, food } });
        close();
        C.toast(`${p.name}: ${C.fmt(r.kcal)} kcal bij ${meal}`);
        after?.();
      } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
    };
  }

  // ---- recept ----
  async function editRecipe(p) {
    const all = await C.rpc("get_foods", { p_query: null, p_limit: 500 }).catch(() => []);
    const byId = Object.fromEntries(all.map((f) => [f.id, f]));
    recipe = { id: p.id, name: p.name, servings: p.recipe.servings, total_g: p.recipe.total_g,
      ingredients: (p.recipe.ingredients || []).map((i) => ({ food: byId[i.food_id] || { id: i.food_id, name: i.name }, grams: i.grams })) };
    recipeEditor();
  }
  function recipeEditor() {
    picking = false;
    const r = recipe;
    const summary = () => {
      const sumG = r.ingredients.reduce((s, i) => s + i.grams, 0);
      const tot = Object.fromEntries(MACROS.map(([k]) => [k, r.ingredients.reduce((s, i) => s + (Number(i.food.per100?.[k]) || 0) * i.grams / 100, 0)]));
      const serv = Math.max(1, numIn(r.servings) || 1);
      const t = sheet.querySelector("#rT"); if (t) t.placeholder = `${Math.round(sumG)} (som)`;
      return `<span class="rsum-k"><b>${C.fmt(tot.kcal / serv)}</b> kcal per portie <span class="muted">(totaal ${C.fmt(tot.kcal)})</span></span>
        <span class="mpills"><span class="mp prot">Eiwit <b>${C.fmt(tot.protein / serv)} g</b></span><span class="mp carb">Koolh. <b>${C.fmt(tot.carbs / serv)} g</b></span><span class="mp fat">Vet <b>${C.fmt(tot.fat / serv)} g</b></span></span>`;
    };
    const ikcal = (i) => (i.food.per100 ? `${C.fmt((Number(i.food.per100.kcal) || 0) * i.grams / 100)} kcal` : "");
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Recept">
      ${head(r.id ? "Recept bewerken" : "Recept maken", true)}
      <div class="field"><label for="rN">Naam</label><input class="input" id="rN" value="${C.esc(r.name)}" placeholder="bv. Kip-rijst bowl"></div>
      <div class="sub-h">Ingrediënten</div>
      ${r.ingredients.map((i, k) => `<div class="tpl-ex" data-k="${k}" style="grid-template-columns:1fr 84px auto">
          <span><b>${C.esc(i.food.name)}</b><br><span class="small muted ik">${ikcal(i)}</span></span>
          <input class="input rg" inputmode="decimal" value="${i.grams}" aria-label="Gram ${C.esc(i.food.name)}">
          <button class="icon-btn rdel" aria-label="Verwijderen">✕</button></div>`).join("") || `<p class="muted small">Nog geen ingrediënten.</p>`}
      <button class="btn secondary" id="rAdd" style="width:100%;margin:8px 0">+ Ingrediënt</button>
      <div class="grid2">
        <div class="field"><label for="rS">Aantal porties</label><input class="input" id="rS" inputmode="numeric" value="${C.esc(r.servings)}"></div>
        <div class="field"><label for="rT">Gewicht na bereiden (g)</label><input class="input" id="rT" inputmode="decimal" value="${C.esc(r.total_g)}"></div>
      </div>
      <div class="rsum" id="rSum"></div>
      <p class="small muted" style="margin:4px 0 0">Kook je pasta of rijst? Weeg het eindresultaat en vul het in, dan klopt het per gram.</p>
      <button class="btn" id="rSave" style="width:100%;margin-top:12px">Recept opslaan</button>
    </div>`;
    wire(() => { recipe = null; search(); });
    const sync = () => {
      r.name = sheet.querySelector("#rN").value;
      r.servings = sheet.querySelector("#rS").value;
      r.total_g = sheet.querySelector("#rT").value;
    };
    const upd = () => { sheet.querySelector("#rSum").innerHTML = summary(); };
    sheet.querySelectorAll("[data-k]").forEach((row) => {
      const i = r.ingredients[Number(row.dataset.k)];
      row.querySelector(".rg").oninput = (e) => { i.grams = numIn(e.target.value) || 0; row.querySelector(".ik").textContent = ikcal(i); upd(); };
      row.querySelector(".rdel").onclick = () => { sync(); r.ingredients.splice(Number(row.dataset.k), 1); recipeEditor(); };
    });
    sheet.querySelector("#rS").oninput = () => { r.servings = sheet.querySelector("#rS").value; upd(); };
    upd();
    sheet.querySelector("#rAdd").onclick = () => { sync(); picking = true; search(); };
    enterSubmits(sheet.querySelector(".sheet-card"), "#rSave");
    sheet.querySelector("#rSave").onclick = async (e) => {
      sync();
      const withG = r.ingredients.filter((i) => i.grams > 0);
      if (!check(sheet, [
        { el: "#rN", ok: !!r.name.trim(), msg: "Geef je recept een naam." },
        { el: "#rAdd", ok: withG.length > 0, msg: "Voeg minstens één ingrediënt toe (met grammen)." },
        ...[...sheet.querySelectorAll("[data-k]")].map((row) => ({ el: row.querySelector(".rg"), ok: (numIn(row.querySelector(".rg").value) || 0) > 0, msg: "Gram?" })),
      ])) return;
      r.ingredients = withG;
      e.target.disabled = true;
      try {
        // producten uit Open Food Facts eerst bewaren (ingrediënten hebben een id nodig)
        for (const i of r.ingredients) {
          if (!i.food.id) {
            i.food = await C.rpc("save_food", { p: { barcode: i.food.barcode, name: i.food.name, brand: i.food.brand, per100: i.food.per100,
              serving_g: i.food.serving_g, serving_label: i.food.serving_label, source: i.food.source || "off" } });
          }
        }
        const saved = await C.rpc("save_recipe", { p: { id: r.id, name: r.name.trim(), servings: numIn(r.servings) || 1, total_g: numIn(r.total_g),
          ingredients: r.ingredients.map((i) => ({ food_id: i.food.id, grams: i.grams })) } });
        recipe = null;
        C.toast("Recept opgeslagen");
        after?.();
        amount(saved);
      } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
    };
  }

  // ---- eigen product ----
  function custom(p = {}, note = "") {
    scanner?.stop(); scanner = null;
    const per = p.per100 || {};
    const f = (id, label, val, cls = "", ph = "") => `<div class="field ${cls}"><label for="${id}">${label}</label><input class="input" id="${id}" inputmode="decimal" value="${val ?? ""}" placeholder="${ph}"></div>`;
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Eigen product">
      ${head("Nieuw product", true)}
      ${note ? `<p class="hint" style="margin-top:8px">${C.esc(note)}</p>` : ""}
      <div class="ocr-row">
        <label class="ocr-btn"><span>📷</span><span><b>Foto van het etiket</b><small>vult de voedingswaarden in</small></span>
          <input type="file" id="cLabel" accept="image/*" capture="environment" hidden></label>
        ${p.barcode ? "" : `<button class="ocr-btn" id="cScan" type="button"><span>▥</span><span><b>Barcode scannen</b><small>zoekt het product op</small></span></button>`}
      </div>
      <p class="small muted" id="cOcr" hidden></p>
      <div class="field"><label for="cN">Naam</label><input class="input" id="cN" value="${C.esc(p.name || "")}" placeholder="bv. XXL Fit Pudding chocolade"></div>
      <div class="field"><label for="cB">Merk (optioneel)</label><input class="input" id="cB" value="${C.esc(p.brand || "")}"></div>
      <p class="small muted" style="margin:12px 0 0">Per 100 g (zoals op het etiket)</p>
      <div class="grid2">${f("cK", "kcal", per.kcal != null ? Math.round(per.kcal) : "", "fk-kcal")}${f("cP", "Eiwit (g)", per.protein, "fk-prot")}${f("cC", "Koolhydraten (g)", per.carbs, "fk-carb")}${f("cF", "Vet (g)", per.fat, "fk-fat")}${f("cFi", "Vezels (g)", per.fiber, "", "optioneel")}${f("cS", "Portie (g)", p.serving_g, "", "optioneel")}</div>
      ${p.barcode ? `<p class="small muted">Barcode ${C.esc(p.barcode)}</p>` : ""}
      <button class="btn" id="cSave" style="width:100%;margin-top:10px">Opslaan en verder</button></div>`;
    wire();
    const card = sheet.querySelector(".sheet-card");
    enterSubmits(card, "#cSave");
    sheet.querySelector("#cScan")?.addEventListener("click", scan);
    sheet.querySelector("#cLabel").onchange = async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      const st = sheet.querySelector("#cOcr"); st.hidden = false;
      try {
        const { values } = await readLabel(file, (m) => { st.textContent = m; });
        const map = { cK: values.kcal, cP: values.protein, cC: values.carbs, cF: values.fat, cFi: values.fiber };
        let n = 0;
        for (const [id, v] of Object.entries(map)) {
          if (v == null) continue;
          const el = sheet.querySelector("#" + id); el.value = String(v).replace(".", ","); el.classList.add("filled"); n++;
        }
        st.textContent = n ? `${n} waarden ingevuld uit de foto (blauw omrand). Kijk ze even na.` : "Ik kon geen waarden lezen. Probeer een scherpere foto, recht van voor, of typ ze over.";
      } catch (err) { st.textContent = "Etiket lezen lukte niet (" + (err.message || err) + "). Typ de waarden over."; }
    };
    sheet.querySelector("#cSave").onclick = async (e) => {
      const v = (id) => numIn(sheet.querySelector("#" + id).value);
      const name = sheet.querySelector("#cN").value.trim();
      if (!check(sheet, [
        { el: "#cN", ok: !!name, msg: "Geef het product een naam." },
        { el: "#cK", ok: v("cK") != null, msg: "Vul de kcal per 100 g in." },
      ])) return;
      e.target.disabled = true;
      try {
        const saved = await C.rpc("save_food", { p: { barcode: p.barcode || null, name, brand: sheet.querySelector("#cB").value.trim() || null,
          per100: { kcal: v("cK"), protein: v("cP"), carbs: v("cC"), fat: v("cF"), fiber: v("cFi") }, serving_g: v("cS") } });
        amount(saved);
      } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
    };
  }

  // ---- snel invoeren ----
  function quick() {
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Snel invoeren">
      ${head("Snel invoeren", true)}
      ${mealChips()}
      <div class="field"><label for="qN">Omschrijving</label><input class="input" id="qN" placeholder="bv. Restaurant pasta"></div>
      <div class="grid2">
        <div class="field"><label for="qK">kcal</label><input class="input" id="qK" inputmode="decimal"></div>
        <div class="field"><label for="qP">Eiwit (g)</label><input class="input" id="qP" inputmode="decimal"></div>
        <div class="field"><label for="qC">Koolhydraten (g)</label><input class="input" id="qC" inputmode="decimal"></div>
        <div class="field"><label for="qF">Vet (g)</label><input class="input" id="qF" inputmode="decimal"></div>
      </div>
      <button class="btn" id="qSave" style="width:100%;margin-top:10px">Toevoegen</button></div>`;
    wire(); bindMeal();
    enterSubmits(sheet.querySelector(".sheet-card"), "#qSave");
    sheet.querySelector("#qSave").onclick = async () => {
      const v = (id) => numIn(sheet.querySelector("#" + id).value);
      if (!check(sheet, [{ el: "#qK", ok: v("qK") != null, msg: "Vul minstens de kcal in." }])) return;
      await C.rpc("log_food", { p: { day, meal, name: sheet.querySelector("#qN").value.trim() || "Snel ingevoerd",
        kcal: v("qK"), protein: v("qP"), carbs: v("qC"), fat: v("qF") } });
      close(); C.toast("Toegevoegd"); after?.();
    };
  }

  if (onPick) search(initial);
  else if (start === "recipe") { recipe = { name: "", servings: 1, total_g: "", ingredients: [] }; recipeEditor(); }
  else if (toEdit) editRecipe(toEdit);
  else if (product) amount(product);
  else search();
}

// ---------------- snel toevoegen ----------------
// Alles loopt nu via één scherm (openAddFood); dit blijft voor oude knoppen.
export function openQuickAdd(ctx, opts = {}) { return openAddFood(ctx, opts); }

// ---------------- gelogd item aanpassen ----------------
export function openEditFood(ctx, it, after) {
  C = ctx;
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  let meal = it.meal;
  const g0 = Number(it.grams) || 0;
  const byGram = !!(it.food_id && g0);
  const per = byGram ? { kcal: it.kcal * 100 / g0, protein: it.protein * 100 / g0, carbs: it.carbs * 100 / g0, fat: it.fat * 100 / g0 } : null;
  const f = (id, label, val, cls) => `<div class="field ${cls}"><label for="${id}">${label}</label><input class="input" id="${id}" inputmode="decimal" value="${val == null ? "" : String(Math.round(val * 10) / 10).replace(".", ",")}"></div>`;
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Aanpassen">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0;flex:1;min-width:0">${C.esc(it.name)}</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <div class="chips meals" id="eMeal" style="margin:10px 0">${MEALS.map((m) => `<button class="chip ${m === meal ? "on" : ""}" data-m="${m}">${m === "Laat" ? "Avondsnack" : m}</button>`).join("")}</div>
    ${byGram ? `<div class="row" style="flex-wrap:nowrap"><input class="input" id="eG" inputmode="decimal" value="${C.fmt(g0)}" aria-label="Gram" style="font-size:22px;font-weight:600"><span class="muted">gram</span></div>
      <div class="chips" style="margin:10px 0">${[0.5, 1.5, 2].map((x) => `<button class="chip" data-x="${x}">×${String(x).replace(".", ",")}</button>`).join("")}</div>
      <div class="macros" id="eLive" style="grid-template-columns:repeat(4,1fr)"></div>`
    : `<div class="grid2">${f("eK", "kcal", it.kcal, "fk-kcal")}${f("eP", "Eiwit (g)", it.protein, "fk-prot")}${f("eC", "Koolhydraten (g)", it.carbs, "fk-carb")}${f("eF", "Vet (g)", it.fat, "fk-fat")}</div>
      <div class="chips" style="margin:6px 0">${[0.5, 1.5, 2].map((x) => `<button class="chip" data-x="${x}">×${String(x).replace(".", ",")} portie</button>`).join("")}</div>`}
    <button class="btn" id="eSave" style="width:100%;margin-top:14px">Opslaan</button>
    <button class="btn ghost" id="eDel" style="width:100%;margin-top:8px;color:var(--bad)">Verwijderen</button>
  </div>`;
  const card = sheet.querySelector(".sheet-card");
  card.querySelector("[data-close]").onclick = close;
  card.querySelector("#eMeal").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; meal = b.dataset.m; card.querySelectorAll("#eMeal .chip").forEach((c) => c.classList.toggle("on", c === b)); };
  const num = (id) => numIn(card.querySelector("#" + id)?.value);
  const live = () => {
    if (!byGram) return;
    const v = scale(per, num("eG") || 0);
    card.querySelector("#eLive").innerHTML = MACROS.map(([k, l, u]) => `<div class="macro m-${k}"><div class="v">${C.fmt(v[k])}${u ? `<small> ${u}</small>` : ""}</div><div class="l">${l}</div></div>`).join("");
  };
  card.querySelector("#eG")?.addEventListener("input", live);
  card.querySelectorAll("[data-x]").forEach((b) => (b.onclick = () => {
    const x = Number(b.dataset.x);
    if (byGram) { card.querySelector("#eG").value = Math.round((num("eG") || g0) * x); live(); }
    else for (const id of ["eK", "eP", "eC", "eF"]) { const v = num(id); if (v != null) card.querySelector("#" + id).value = String(Math.round(v * x * 10) / 10).replace(".", ","); }
  }));
  live();
  enterSubmits(card, "#eSave");
  card.querySelector("#eSave").onclick = async (e) => {
    if (byGram ? !check(card, [{ el: "#eG", ok: (num("eG") || 0) > 0, msg: "Vul een hoeveelheid in." }])
      : !check(card, [{ el: "#eK", ok: num("eK") != null, msg: "Vul de kcal in." }])) return;
    e.target.disabled = true;
    try {
      const p = byGram ? { day: it.day, meal, grams: num("eG"), food: { id: it.food_id } }
        : { day: it.day, meal, name: it.name, kcal: num("eK"), protein: num("eP"), carbs: num("eC"), fat: num("eF") };
      await C.rpc("edit_food", { p_id: it.id, p });
      close(); C.toast("Aangepast"); after?.();
    } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
  };
  card.querySelector("#eDel").onclick = async () => {
    await C.rpc("void_food", { p_id: it.id });
    close();
    C.toast(`${it.name} verwijderd`, 5000, { label: "Ongedaan maken", run: async () => {
      const p = byGram ? { day: it.day, meal: it.meal, grams: g0, food: { id: it.food_id } }
        : { day: it.day, meal: it.meal, name: it.name, kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat };
      await C.rpc("log_food", { p }); after?.();
    } });
    after?.();
  };
}
