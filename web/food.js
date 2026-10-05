// Voeding loggen in Health Hub: zoeken (eigen producten + Open Food Facts),
// barcode scannen, portie kiezen, per maaltijd bijhouden,
// maaltijden kopiëren, vaste maaltijden en recepten.
let C;
export const MEALS = ["Ontbijt", "Lunch", "Snack", "Avondeten", "Laat"];
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

export function openAddFood(ctx, { day, meal = mealForNow(), after, start = null, product = null, editRecipe: toEdit = null } = {}) {
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
  let picking = false;

  const head = (title, back) => `<div class="row" style="justify-content:space-between;flex-wrap:nowrap">
      ${back ? `<button class="icon-btn" data-back aria-label="Terug">‹</button>` : ""}
      <h3 style="margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${title}</h3><button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>`;
  const home = () => (picking ? recipeEditor() : search());
  const wire = (onBack) => {
    sheet.querySelector("[data-close]").onclick = close;
    sheet.querySelector("[data-back]")?.addEventListener("click", () => (onBack || home)());
  };
  const mealChips = () => (picking ? "" : `<div class="chips" id="fMeal" style="margin:10px 0">${MEALS.map((m) =>
    `<button class="chip ${m === meal ? "on" : ""}" data-m="${m}">${m}</button>`).join("")}</div>`);
  const bindMeal = (onChange) => sheet.querySelector("#fMeal")?.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    meal = b.dataset.m;
    sheet.querySelectorAll("#fMeal .chip").forEach((c) => c.classList.toggle("on", c === b));
    onChange?.();
  });

  // ---- zoekscherm ----
  let local = [], remote = [], seq = 0, remoteState = "";
  let presets = null, yesterday = null;
  function search(initial = "") {
    scanner?.stop(); scanner = null;
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${picking ? "Ingrediënt kiezen" : "Voeding toevoegen"}">
      ${head(picking ? "Ingrediënt kiezen" : "Voeding toevoegen", picking)}
      ${mealChips()}
      <div class="row" style="flex-wrap:nowrap;${picking ? "margin-top:10px" : ""}">
        <input class="input" id="fQ" placeholder="Zoek product of merk…" autocomplete="off" enterkeyhint="search" value="${C.esc(initial)}">
        <button class="btn" id="fScan" aria-label="Barcode scannen">▥ Scan</button>
      </div>
      ${picking ? "" : `<div id="fShort"></div>
      <div class="row small" style="margin:8px 0 2px;gap:14px">
        <button class="linkbtn" id="fQuick">Snel kcal/macro's</button>
        <button class="linkbtn" id="fCustom">Eigen product</button>
        <button class="linkbtn" id="fRecipe">Recept maken</button>
      </div>`}
      <div id="fRes" class="pk-list"></div>
      <p class="muted small" style="margin:10px 0 0">Productdata: Open Food Facts (open databank, ODbL).</p>
    </div>`;
    wire(); bindMeal(shortcuts);
    const q = sheet.querySelector("#fQ");
    let t1, t2;
    q.oninput = () => {
      clearTimeout(t1); clearTimeout(t2);
      const term = q.value.trim();
      const my = ++seq;
      const sh = sheet.querySelector("#fShort"); if (sh) sh.hidden = !!term;
      t1 = setTimeout(async () => { local = await C.rpc("get_foods", { p_query: term || null, p_limit: term ? 15 : 25 }).catch(() => []); if (my === seq) list(); }, 150);
      remote = []; remoteState = term.length >= 3 ? "loading" : "";
      if (term.length >= 3) t2 = setTimeout(async () => {
        try { const r = await C.invoke("food", { q: term }); if (my === seq) { remote = r.products || []; remoteState = ""; list(); } }
        catch (e) { if (my === seq) { remoteState = "fout: " + e.message; list(); } }
      }, 600);
      list();
    };
    q.onkeydown = (e) => { if (e.key === "Enter") q.blur(); };
    sheet.querySelector("#fScan").onclick = scan;
    sheet.querySelector("#fQuick")?.addEventListener("click", quick);
    sheet.querySelector("#fCustom")?.addEventListener("click", () => custom({ name: q.value.trim() }));
    sheet.querySelector("#fRecipe")?.addEventListener("click", () => { recipe = { name: "", servings: 1, total_g: "", ingredients: [] }; recipeEditor(); });
    q.oninput();
    if (!picking) shortcuts();
    if (!initial) setTimeout(() => q.focus(), 50);
  }

  // Snelkoppelingen: maaltijd van gisteren + vaste maaltijden
  async function shortcuts() {
    const box = sheet.querySelector("#fShort"); if (!box) return;
    if (presets === null || yesterday === null) {
      [presets, yesterday] = await Promise.all([
        C.rpc("get_meal_presets").catch(() => []), C.rpc("get_food_log", { p_day: addDays(day, -1) }).catch(() => [])]);
    }
    const y = yesterday.filter((i) => i.meal === meal);
    const yk = y.reduce((s, i) => s + (Number(i.kcal) || 0), 0);
    const el = sheet.querySelector("#fShort"); if (!el) return;
    el.innerHTML = (y.length ? `<button class="shortcut" id="fYest"><span><b>⧉ ${meal} van gisteren</b><br><span class="small muted">${C.esc(y.map((i) => i.name).join(", "))}</span></span><span class="k">${C.fmt(yk)}<small> kcal</small></span></button>` : "")
      + (presets.length ? `<div class="sub-h" style="margin-top:12px">Mijn maaltijden</div><div class="chips">${presets.map((p, i) =>
        `<button class="chip preset" data-i="${i}">${C.esc(p.name)} <span class="muted">· ${C.fmt(p.kcal)} kcal</span></button>`).join("")}</div>` : "");
    el.querySelector("#fYest")?.addEventListener("click", async () => {
      const ids = await C.rpc("copy_meal", { p_from: addDays(day, -1), p_meal: meal, p_to: day, p_to_meal: meal });
      close(); undoMany(ids, `${meal} van gisteren toegevoegd`, after); after?.();
    });
    el.querySelectorAll(".preset").forEach((b) => (b.onclick = async () => {
      const p = presets[Number(b.dataset.i)];
      const ids = await C.rpc("log_meal_preset", { p_id: p.id, p_day: day, p_meal: meal });
      close(); undoMany(ids, `${p.name} toegevoegd aan ${meal}`, after); after?.();
    }));
    if (presets.length) {
      const m = document.createElement("button");
      m.className = "linkbtn"; m.textContent = "Beheren"; m.style.marginTop = "6px";
      m.onclick = managePresets;
      el.appendChild(m);
    }
  }

  function managePresets() {
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Mijn maaltijden">
      ${head("Mijn maaltijden", true)}
      <p class="hint" style="margin-top:8px">Bewaar een maaltijd via ★ Bewaar in je daglijst.</p>
      ${presets.map((p, i) => `<div class="tpl-ex" data-i="${i}" style="grid-template-columns:1fr auto">
        <span><b>${C.esc(p.name)}</b><br><span class="small muted">${C.esc(p.items.map((x) => x.name).join(", "))} · ${C.fmt(p.kcal)} kcal</span></span>
        <button class="icon-btn" data-del aria-label="${C.esc(p.name)} verwijderen">✕</button></div>`).join("")}
    </div>`;
    wire(() => search());
    sheet.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      const p = presets[Number(b.closest("[data-i]").dataset.i)];
      if (!confirm(`"${p.name}" verwijderen?`)) return;
      await C.rpc("save_meal_preset", { p: { id: p.id, archived: true } });
      presets = presets.filter((x) => x !== p);
      managePresets();
    }));
  }

  const itemHtml = (p, i, src) => {
    const k = p.per100?.kcal;
    return `<button class="pk-item" data-src="${src}" data-i="${i}">
      <span><b>${C.esc(p.name)}</b>${p.source === "recipe" ? ` <span class="badge" style="background:var(--fuel)">recept</span>` : ""}<br><span class="small muted">${p.brand ? C.esc(p.brand) + " · " : ""}${k != null ? `${C.fmt(k)} kcal/100 g` : "geen kcal"}${p.use_count ? ` · ${p.use_count}× gelogd` : ""}</span></span><span>+</span></button>`;
  };
  function list() {
    const box = sheet.querySelector("#fRes"); if (!box) return;
    const term = sheet.querySelector("#fQ").value.trim();
    const seen = new Set(local.map((p) => p.barcode).filter(Boolean));
    const loc = picking ? local.filter((p) => p.source !== "recipe") : local;
    const rem = remote.filter((p) => !p.barcode || !seen.has(p.barcode));
    box.innerHTML =
      (loc.length ? `<div class="sub-h">${term ? "Mijn producten" : "Recent"}</div>${loc.map((p, i) => itemHtml(p, i, "l")).join("")}` : "")
      + (rem.length ? `<div class="sub-h">Open Food Facts</div>${rem.map((p, i) => itemHtml(p, i, "r")).join("")}` : "")
      + (remoteState === "loading" ? `<p class="muted small">Zoeken in Open Food Facts…</p>` : remoteState ? `<p class="muted small">Open Food Facts: ${C.esc(remoteState)}</p>` : "")
      + (!loc.length && !rem.length && !remoteState ? `<p class="muted small">${term ? "Niets gevonden. Scan de barcode of maak een eigen product." : "Zoek een product of scan een barcode."}</p>` : "");
    box.onclick = (e) => {
      const b = e.target.closest(".pk-item"); if (!b) return;
      amount(b.dataset.src === "l" ? loc[b.dataset.i] : rem[b.dataset.i]);
    };
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
      sheet.querySelector("#fLive").innerHTML = MACROS.map(([k, l, u]) => `<div class="macro"><div class="v">${C.fmt(v[k])}${u ? `<small> ${u}</small>` : ""}</div><div class="l">${l}</div></div>`).join("");
      sheet.querySelector("#fAdd").textContent = picking ? "Toevoegen aan recept" : `Toevoegen aan ${meal}`;
    };
    inp.oninput = live;
    sheet.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => { inp.value = b.dataset.g; live(); }));
    live();
    sheet.querySelector("#fEditRec")?.addEventListener("click", () => editRecipe(p));
    sheet.querySelector("#fAdd").onclick = async (e) => {
      if (!(g > 0)) return C.toast("Vul een hoeveelheid in");
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
      return `Totaal ${C.fmt(tot.kcal)} kcal · per portie <b>${C.fmt(tot.kcal / serv)} kcal</b>, E ${C.fmt(tot.protein / serv)} g · K ${C.fmt(tot.carbs / serv)} g · V ${C.fmt(tot.fat / serv)} g`;
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
      <p class="small" id="rSum" style="margin:4px 0 0"></p>
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
    sheet.querySelector("#rSave").onclick = async (e) => {
      sync();
      if (!r.name.trim()) return C.toast("Geef het recept een naam");
      r.ingredients = r.ingredients.filter((i) => i.grams > 0);
      if (!r.ingredients.length) return C.toast("Voeg minstens één ingrediënt toe");
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
    const f = (id, label, val, ph = "") => `<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" inputmode="decimal" value="${val ?? ""}" placeholder="${ph}"></div>`;
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Eigen product">
      ${head("Eigen product", true)}
      ${note ? `<p class="hint" style="margin-top:8px">${C.esc(note)}</p>` : ""}
      <div class="field"><label for="cN">Naam</label><input class="input" id="cN" value="${C.esc(p.name || "")}"></div>
      <div class="field"><label for="cB">Merk (optioneel)</label><input class="input" id="cB" value="${C.esc(p.brand || "")}"></div>
      <p class="small muted" style="margin:12px 0 0">Per 100 g (zoals op het etiket)</p>
      <div class="grid2">${f("cK", "kcal", per.kcal != null ? Math.round(per.kcal) : "")}${f("cP", "Eiwit (g)", per.protein)}${f("cC", "Koolhydraten (g)", per.carbs)}${f("cF", "Vet (g)", per.fat)}${f("cFi", "Vezels (g)", per.fiber, "optioneel")}${f("cS", "Portie (g)", p.serving_g, "optioneel")}</div>
      ${p.barcode ? `<p class="small muted">Barcode ${C.esc(p.barcode)}</p>` : ""}
      <button class="btn" id="cSave" style="width:100%;margin-top:10px">Opslaan en verder</button></div>`;
    wire();
    sheet.querySelector("#cSave").onclick = async () => {
      const v = (id) => numIn(sheet.querySelector("#" + id).value);
      const name = sheet.querySelector("#cN").value.trim();
      if (!name || v("cK") == null) return C.toast("Naam en kcal zijn nodig");
      try {
        const saved = await C.rpc("save_food", { p: { barcode: p.barcode || null, name, brand: sheet.querySelector("#cB").value.trim() || null,
          per100: { kcal: v("cK"), protein: v("cP"), carbs: v("cC"), fat: v("cF"), fiber: v("cFi") }, serving_g: v("cS") } });
        amount(saved);
      } catch (e) { C.toast(e.message, 5000); }
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
    sheet.querySelector("#qSave").onclick = async () => {
      const v = (id) => numIn(sheet.querySelector("#" + id).value);
      if (v("qK") == null) return C.toast("Vul minstens kcal in");
      await C.rpc("log_food", { p: { day, meal, name: sheet.querySelector("#qN").value.trim() || "Snel ingevoerd",
        kcal: v("qK"), protein: v("qP"), carbs: v("qC"), fat: v("qF") } });
      close(); C.toast("Toegevoegd"); after?.();
    };
  }

  if (start === "recipe") { recipe = { name: "", servings: 1, total_g: "", ingredients: [] }; recipeEditor(); }
  else if (toEdit) editRecipe(toEdit);
  else if (product) amount(product);
  else search();
}
