// Mealprep in Health Hub: weekmenu (zondagavond t/m vrijdagmiddag), boodschappenlijst en recepten.
// Het weekmenu stelt Claude elke vrijdag voor; hier kijk je het na, wissel je gerechten,
// geef je je mening (lekker / niet lekker), kook je en vink je af in de winkel.
import { check, enterSubmits } from "./formkit.js";
let C;
let D = null;            // laatste mp_get
let tab = "week";
let hideChecked = false;
let filter = "alle";
let query = "";

const SLOTS = { ontbijt: "Ontbijt", lunch: "Lunch", snack: "Snack", avond: "Avond", avondsnack: "Avondsnack" };
const SLOT_ORDER = ["ontbijt", "lunch", "snack", "avond", "avondsnack"];
const FOOD_MEAL = { ontbijt: "Ontbijt", lunch: "Lunch", snack: "Snack", avond: "Avondeten", avondsnack: "Laat" };
const DEPTS = ["Groenten & fruit", "Vlees & vis", "Zuivel & eieren", "Brood & wraps", "Houdbaar", "Ontbijt & sport", "Diepvries", "Overig"];
const WD = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];

const $ = (s, r = document) => r.querySelector(s);
const n = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const wd = (iso) => WD[new Date(iso + "T12:00:00Z").getUTCDay()];
const dshort = (iso) => { const d = new Date(iso + "T12:00:00Z"); return `${wd(iso)} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
const recById = (id) => D.recipes.find((r) => r.id === id);
const currentWeek = () => D.weeks.find((w) => w.id === D.current_week_id) || null;

function amountText(amount, unit, shop = false) {
  const a = n(amount);
  if (a === null) return unit ? "" : "";
  if (unit === "g" && a >= 1000) return `${C.fmt(a / 1000, 2)} kg`;
  if (unit === "ml" && a >= 1000) return `${C.fmt(a / 1000, 2)} l`;
  if (unit === "stuk") { const v = shop ? Math.ceil(a - 0.01) : a; return `${C.fmt(v, 2)} ${v === 1 ? "stuk" : "stuks"}`; }
  if (unit === "teen") { const v = shop ? Math.ceil(a - 0.01) : a; return `${C.fmt(v, 2)} ${v === 1 ? "teen" : "tenen"}`; }
  if (unit === "el" || unit === "tl") return `${C.fmt(a, 1)} ${unit}`;
  return `${C.fmt(a, a < 10 ? 1 : 0)}${unit ? " " + unit : ""}`;
}
const ingLine = (i, mult = 1, shop = false) => {
  const amt = n(i.amount) === null ? "" : amountText(n(i.amount) * mult, i.unit, shop);
  return amt ? `${amt} ${i.name}` : `${i.name} (naar smaak)`;
};

async function load() { D = await C.rpc("mp_get"); return D; }
async function reload() { await load(); draw(); }

// ======================================================================
export async function renderMenu(ctx, param) {
  C = ctx;
  if (["week", "lijst", "recepten"].includes(param)) tab = param;
  await load();
  draw();
}

function draw() {
  const v = C.view;
  v.innerHTML = `<div class="seg mp-seg" role="group" aria-label="Onderdeel">
      ${[["week", "Weekmenu"], ["lijst", "Boodschappen"], ["recepten", "Recepten"]].map(([k, l]) =>
        `<button data-t="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div>
    <div id="mpBody"></div>`;
  v.querySelector(".mp-seg").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    tab = b.dataset.t; history.replaceState(null, "", `#/menu/${tab}`); draw();
  };
  const body = $("#mpBody");
  if (tab === "week") drawWeek(body);
  else if (tab === "lijst") drawList(body);
  else drawRecipes(body);
}

// ---------------------------------------------------------------- weekmenu
function dayTotals(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const it of items) {
    const r = recById(it.recipe_id); if (!r) continue;
    const q = n(it.portions) || 1;
    for (const k of Object.keys(t)) t[k] += q * (n(r[k]) || 0);
  }
  return t;
}

// Kookplan: per gerecht (geen ontbijt/snack) hoeveel porties en voor welke dagen
function cookPlan(w) {
  const by = new Map();
  for (const it of w.items) {
    if (it.slot === "ontbijt" || it.slot === "snack") continue;
    const e = by.get(it.recipe_id) || { recipe_id: it.recipe_id, portions: 0, days: [], slot: it.slot };
    e.portions += n(it.portions) || 1; e.days.push(it.day);
    by.set(it.recipe_id, e);
  }
  return [...by.values()].sort((a, b) => a.days[0].localeCompare(b.days[0]));
}

function drawWeek(box) {
  const w = currentWeek();
  if (!w || !w.items.length) {
    box.innerHTML = `<section class="panel"><h3>Nog geen weekmenu</h3>
      <p class="hint">Elke vrijdag stelt Claude je menu voor zondagavond tot vrijdagmiddag voor: met je favorieten, een wrap als lunch, magere kwark als snack en hoogstens twee avondgerechten die je voor 2 à 3 dagen kookt. Bonusproducten van Albert Heijn worden meegenomen.</p>
      <p class="hint">Zet intussen een ★ bij wat je lekker vindt en een 👎 bij wat niet: daar houdt het menu rekening mee.</p>
      <button class="btn" id="goRec">Naar mijn recepten</button></section>`;
    $("#goRec").onclick = () => { tab = "recepten"; draw(); };
    return;
  }
  const g = D.goals || {};
  const days = [...new Set(w.items.map((i) => i.day))].sort();
  const plan = cookPlan(w);
  box.innerHTML = `
    <h2 class="section-title" style="margin-top:4px">Week van ${C.esc(dshort(w.week_start))}</h2>
    ${w.notes ? `<p class="muted small" style="margin:-4px 0 10px">${C.esc(w.notes)}</p>` : ""}
    ${w.reviewed_at
      ? `<p class="small muted" style="margin:0 0 12px">✓ Menu goedgekeurd · <button class="linkbtn" id="unreview">ongedaan maken</button></p>`
      : `<section class="panel mp-review"><h3>Kijk je menu na</h3>
          <p class="hint">Tik op een gerecht om het te wisselen, de porties aan te passen of je mening te geven. Je boodschappenlijst past zich meteen aan.</p>
          <button class="btn" id="review">✓ Menu is goed</button></section>`}
    ${plan.length ? `<section class="panel"><h3>Koken deze week</h3>
        ${plan.map((p) => { const r = recById(p.recipe_id); return r ? `<div class="mp-row">
          <span><b>${C.esc(r.name)}</b><br><span class="small muted">${C.fmt(p.portions, 2)} porties · ${p.days.map((d) => wd(d).slice(0, 2)).join(", ")}</span></span>
          <span class="row" style="gap:6px;flex-wrap:nowrap"><button class="icon-btn mp-edit" data-r="${r.id}" aria-label="${C.esc(r.name)} aanpassen">✏️</button>
          <button class="btn secondary mp-cook" data-r="${r.id}" data-p="${p.portions}">Koken</button></span></div>` : ""; }).join("")}
        ${w.prep?.length ? `<details class="mp-prep"><summary>Prepschema</summary><ol>${w.prep.map((s) => `<li>${C.esc(s)}</li>`).join("")}</ol></details>` : ""}
      </section>` : ""}
    ${days.map((d) => {
      const its = w.items.filter((i) => i.day === d).sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
      const t = dayTotals(its);
      const kPct = g.kcal_in ? Math.min(100, (t.kcal / g.kcal_in) * 100) : 0;
      const pPct = g.protein_g ? Math.min(100, (t.protein / g.protein_g) * 100) : 0;
      return `<section class="panel mp-day ${d === D.today ? "today" : ""}">
        <div class="row" style="justify-content:space-between"><h3 style="text-transform:capitalize">${C.esc(dshort(d))}${d === D.today ? ` <span class="badge" style="background:var(--fuel)">vandaag</span>` : ""}</h3>
          <span class="small muted">${C.fmt(t.kcal)} kcal · ${C.fmt(t.protein)} g eiwit</span></div>
        ${its.length >= 3 && g.kcal_in ? `<div class="mp-bars"><div class="bar" style="--c:var(--fuel)"><i style="width:${kPct}%"></i></div><div class="bar" style="--c:var(--move)"><i style="width:${pPct}%"></i></div></div>` : ""}
        ${its.map((it) => { const r = recById(it.recipe_id); if (!r) return "";
          const q = n(it.portions) || 1;
          const canEat = d <= D.today;
          return `<div class="mp-irow ${it.eaten ? "eaten" : ""}">${canEat ? `<label class="mp-eat" title="Gegeten"><input type="checkbox" data-eat="${it.id}" ${it.eaten ? "checked" : ""} aria-label="${C.esc(r.name)} gegeten"></label>` : ""}
            <button class="mp-item" data-item="${it.id}">
            <span class="slot">${SLOTS[it.slot]}</span>
            <span class="nm">${r.favorite ? "★ " : ""}${C.esc(r.name)}${q !== 1 ? ` <span class="muted">· ${C.fmt(q, 2)} portie</span>` : ""}</span>
            <span class="k">${C.fmt(q * (n(r.kcal) || 0))}</span></button></div>`; }).join("")}
        ${(() => { const have = new Set(its.map((i) => i.slot)); const free = SLOT_ORDER.filter((sl) => !have.has(sl));
          return free.length ? `<div class="chips mp-addslot">${free.map((sl) => `<button class="chip" data-addday="${d}" data-addslot="${sl}">+ ${SLOTS[sl]}</button>`).join("")}</div>` : ""; })()}
      </section>`;
    }).join("")}
    ${w.bonus?.length ? `<section class="panel"><h3>In de bonus verwerkt</h3><ul class="mp-ul">${w.bonus.map((b) =>
      `<li>${C.esc(b.product || "")}${b.deal ? ` · <b>${C.esc(b.deal)}</b>` : ""}${b.valid ? ` <span class="muted small">(${C.esc(b.valid)})</span>` : ""}</li>`).join("")}</ul></section>` : ""}`;

  $("#review")?.addEventListener("click", async () => { await C.rpc("mp_week_review", { p_week_id: w.id, p_reviewed: true }); C.toast("Menu goedgekeurd"); reload(); });
  $("#unreview")?.addEventListener("click", async () => { await C.rpc("mp_week_review", { p_week_id: w.id, p_reviewed: false }); reload(); });
  box.querySelectorAll(".mp-cook").forEach((b) => (b.onclick = () => openCook(recById(Number(b.dataset.r)), Number(b.dataset.p))));
  box.querySelectorAll(".mp-edit").forEach((b) => (b.onclick = () => openEdit(recById(Number(b.dataset.r)))));
  box.querySelectorAll("[data-eat]").forEach((cb) => (cb.onchange = async () => {
    const it = w.items.find((i) => i.id === Number(cb.dataset.eat)); const r = recById(it.recipe_id);
    try {
      await C.rpc("mp_item_eaten", { p_item_id: it.id, p_eaten: cb.checked });
      it.eaten = cb.checked; cb.closest(".mp-irow").classList.toggle("eaten", cb.checked);
      C.toast(cb.checked ? `${r.name} gelogd in Voeding` : `${r.name} uit Voeding gehaald`);
    } catch (e) { cb.checked = !cb.checked; C.toast(e.message, 5000); }
  }));
  box.querySelectorAll("[data-addslot]").forEach((b) => (b.onclick = () => openAddSlot(w, b.dataset.addday, b.dataset.addslot)));
  box.querySelectorAll(".mp-item").forEach((b) => (b.onclick = () => {
    const it = w.items.find((i) => i.id === Number(b.dataset.item));
    openRecipe(recById(it.recipe_id), { item: it });
  }));
}

// ---------------------------------------------------------------- boodschappen
function drawList(box) {
  const w = currentWeek();
  const groups = w?.shopping || [];
  const all = groups.flatMap((g) => g.items.filter((i) => !i.pantry));
  const done = all.filter((i) => i.checked).length;
  box.innerHTML = `
    <div class="row" style="justify-content:space-between;margin:4px 0 8px">
      <span class="small muted">${w ? `Week van ${C.esc(dshort(w.week_start))} · ` : ""}${done} van ${all.length} afgevinkt</span>
      <button class="chip ${hideChecked ? "on" : ""}" id="hideC">Verberg afgevinkt</button>
    </div>
    <p class="hint small muted" style="margin:0 0 10px">Vink af wat je al hebt of kocht. Vers spul voor later in de week staat op de lijst van de tussendag. Wat vóór vrijdagavond is afgevinkt, komt niet in je AH-mandje.</p>
    ${groups.length ? groups.map((g, gi) => {
      const items = g.items.filter((i) => !(hideChecked && i.checked));
      // Kop per winkelmoment (zondag AH / tussendag Okay) boven de eerste afdeling ervan.
      let head = "";
      if (g.moment && (gi === 0 || groups[gi - 1].moment !== g.moment)) {
        const mi = groups.filter((x) => x.moment === g.moment).flatMap((x) => x.items.filter((i) => !i.pantry));
        head = `<h2 class="section-title" style="margin-top:${gi ? 18 : 4}px">${C.esc(g.moment_label || g.moment)}
          <span class="small muted">· ${mi.filter((i) => i.checked).length}/${mi.length}</span></h2>`;
      }
      if (!items.length) return head;
      return `${head}<section class="panel mp-shop"><h3>${C.esc(g.afdeling || g.dept)}</h3>
        ${items.map((i) => `<label class="mp-check ${i.checked ? "done" : ""} ${i.pantry ? "pantry" : ""}">
          <input type="checkbox" data-key="${C.esc(i.key)}" ${i.checked ? "checked" : ""}>
          <span class="t">${C.esc(i.amount != null ? amountText(i.amount, i.unit, true) + " " : "")}${C.esc(i.name)}
            ${i.bonus ? ` <span class="badge" style="background:var(--fuel)">bonus</span>` : ""}
            ${i.pantry ? ` <span class="small muted">· check voorraad</span>` : ""}</span>
          ${i.extra_id ? `<button class="icon-btn mp-xdel" data-x="${i.extra_id}" aria-label="${C.esc(i.name)} verwijderen">✕</button>` : ""}
        </label>`).join("")}</section>`;
    }).join("") : `<div class="empty">Nog geen boodschappen. Ze verschijnen zodra je weekmenu er is, of zet zelf iets op je lijst.</div>`}
    <section class="panel"><h3>Iets extra</h3>
      <form class="row" id="xForm" style="margin-top:8px">
        <input class="input" id="xName" placeholder="bv. tandpasta, 2 l cola zero" autocomplete="off" maxlength="120">
        <select class="input" id="xDept" style="flex:0 0 auto;width:auto">${DEPTS.map((d) => `<option ${d === "Overig" ? "selected" : ""}>${C.esc(d)}</option>`).join("")}</select>
        <button class="btn">+</button>
      </form>
    </section>
    ${w?.list_recipes?.length ? `<section class="panel"><h3>Extra recepten op je lijst</h3>${w.list_recipes.map((l) => {
      const r = recById(l.recipe_id); return `<div class="mp-row"><span>${C.esc(r?.name || "Recept")} <span class="muted small">· ${C.fmt(l.portions, 2)} porties</span></span>
        <button class="icon-btn mp-lrdel" data-l="${l.id}" aria-label="Van de lijst halen">✕</button></div>`; }).join("")}</section>` : ""}`;

  $("#hideC").onclick = () => { hideChecked = !hideChecked; drawList(box); };
  box.querySelectorAll(".mp-check input").forEach((cb) => (cb.onchange = async () => {
    const lab = cb.closest(".mp-check");
    lab.classList.toggle("done", cb.checked);
    const item = groups.flatMap((g) => g.items).find((i) => i.key === cb.dataset.key);
    if (item) item.checked = cb.checked;
    try { await C.rpc("mp_check", { p_week_id: w.id, p_key: cb.dataset.key, p_checked: cb.checked }); }
    catch (e) { cb.checked = !cb.checked; lab.classList.toggle("done", cb.checked); if (item) item.checked = cb.checked; C.toast("Niet opgeslagen: " + e.message, 4000); }
    if (hideChecked && cb.checked) setTimeout(() => drawList(box), 400);
  }));
  box.querySelectorAll(".mp-xdel").forEach((b) => (b.onclick = async (e) => {
    e.preventDefault();
    await C.rpc("mp_extra_remove", { p_id: Number(b.dataset.x) }); reload();
  }));
  box.querySelectorAll(".mp-lrdel").forEach((b) => (b.onclick = async () => {
    await C.rpc("mp_list_remove_recipe", { p_id: Number(b.dataset.l) }); C.toast("Van je lijst gehaald"); reload();
  }));
  $("#xForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#xName").value.trim(); if (!name) return;
    try { await C.rpc("mp_extra_add", { p_week_id: w?.id ?? null, p_name: name, p_dept: $("#xDept").value }); C.toast(`${name} toegevoegd`); reload(); }
    catch (err) { C.toast(err.message, 4000); }
  };
}

// ---------------------------------------------------------------- recepten
function drawRecipes(box) {
  const F = [["alle", "Alle"], ["fav", "★ Lekker"], ["avond", "Avond"], ["lunch", "Lunch"], ["snack", "Snack"], ["ontbijt", "Ontbijt"], ["concept", "Concepten"], ["niet", "👎"]];
  const q = query.toLowerCase();
  const list = D.recipes.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (filter === "fav") return r.favorite;
    if (filter === "niet") return r.disliked;
    if (filter === "concept") return r.status === "concept";
    if (filter !== "alle") return r.meal_type === filter && !r.disliked;
    return !r.disliked;
  });
  box.innerHTML = `
    <button class="btn mp-add" id="addRec">📷 + Recept toevoegen</button>
    <p class="small muted" style="margin:6px 0 10px">Via een foto, een link naar een receptensite of zelf typen. ★ betekent: vaker in je weekmenu. 👎: nooit meer.</p>
    <input class="input" id="rq" placeholder="Zoek een recept…" value="${C.esc(query)}" autocomplete="off" style="margin-bottom:10px">
    <div class="chips" id="rf" style="margin-bottom:12px">${F.map(([k, l]) => `<button class="chip ${filter === k ? "on" : ""}" data-f="${k}">${l}</button>`).join("")}</div>
    <div class="list">${list.map((r) => `<div class="item mp-ritem" data-id="${r.id}" style="--c:var(--fuel);grid-template-columns:6px 1fr auto">
        <span class="swatch"></span>
        <span><div class="t">${C.esc(r.name)}${r.status === "concept" ? ` <span class="badge">concept</span>` : ""}</div>
          <div class="m">${SLOTS[r.meal_type]}${n(r.kcal) != null ? ` · ${C.fmt(r.kcal)} kcal · ${C.fmt(r.protein)} g eiwit per portie` : ""}${r.note ? " · 📝" : ""}</div></span>
        <button class="mp-star ${r.favorite ? "on" : ""}" data-star="${r.id}" aria-label="${r.favorite ? "Niet meer als favoriet" : "Lekker: vaker voorstellen"}">${r.favorite ? "★" : "☆"}</button>
      </div>`).join("") || `<div class="empty">${filter === "fav" ? "Nog geen favorieten. Tik op ☆ bij een recept." : "Geen recepten in deze lijst."}</div>`}</div>`;

  $("#addRec").onclick = () => openAdd();
  const rq = $("#rq");
  rq.oninput = () => { query = rq.value; const pos = rq.selectionStart; drawRecipes(box); const n2 = $("#rq"); n2.focus(); n2.setSelectionRange(pos, pos); };
  $("#rf").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter = b.dataset.f; drawRecipes(box); };
  box.querySelectorAll(".mp-ritem").forEach((row) => (row.onclick = async (e) => {
    const r = recById(Number(row.dataset.id));
    if (e.target.closest("[data-star]")) {
      const nv = !r.favorite;
      await C.rpc("mp_set_opinion", { p_id: r.id, p_opinion: nv ? "lekker" : "neutraal" });
      r.favorite = nv; r.disliked = false;
      C.toast(nv ? `★ ${r.name} komt vaker terug` : `${r.name} niet meer als favoriet`);
      return drawRecipes(box);
    }
    openRecipe(r);
  }));
}

// ---------------------------------------------------------------- recept-detail
function sheetShell(label) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${C.esc(label)}"></div>`;
  document.body.appendChild(sheet);
  const close = () => { sheet._onClose?.(); sheet.remove(); };
  sheet._close = close;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  return { sheet, card: sheet.firstElementChild, close };
}
const head = (title) => `<div class="row" style="justify-content:space-between;flex-wrap:nowrap">
  <h3 style="margin:0;flex:1;min-width:0">${title}</h3><button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>`;

function bevelText(r, portions) {
  const lines = [r.name, `${C.fmt(portions, 2)} ${portions === 1 ? "portie" : "porties"}`, "", "Ingrediënten:"];
  for (const i of r.ingredients || []) lines.push(`- ${ingLine(i, portions)}`);
  if (r.steps?.length) { lines.push("", "Bereiding:"); r.steps.forEach((s, k) => lines.push(`${k + 1}. ${s}`)); }
  if (n(r.kcal) != null) lines.push("", `Per portie (schatting Health Hub): ${C.fmt(r.kcal)} kcal, ${C.fmt(r.protein)} g eiwit, ${C.fmt(r.carbs)} g koolhydraten, ${C.fmt(r.fat)} g vet`);
  return lines.join("\n");
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function openRecipe(r, { item = null } = {}) {
  if (!r) return;
  const { card, close } = sheetShell(r.name);
  let portions = item ? (n(item.portions) || 1) : r.servings || 1;
  let itemPortions = item ? (n(item.portions) || 1) : null;

  const render = () => {
    const m = (k) => n(r[k]);
    card.innerHTML = `${head(C.esc(r.name))}
      <p class="small muted" style="margin:2px 0 8px">${SLOTS[r.meal_type]}${r.status === "concept" ? " · concept" : ""}${r.macros_checked ? " · macro's gecheckt" : n(r.kcal) != null ? " · macro's zijn een schatting" : ""}</p>
      <div class="row mp-op">
        <button class="btn ${r.favorite ? "" : "secondary"}" data-op="lekker">${r.favorite ? "★ Lekker" : "☆ Lekker"}</button>
        <button class="btn ${r.disliked ? "" : "secondary"}" data-op="niet" ${r.disliked ? 'style="background:var(--bad)"' : ""}>👎 Niet lekker</button>
      </div>
      ${item ? `<section class="mp-box"><div class="row" style="justify-content:space-between">
          <span class="small"><b>In je menu</b>: ${C.esc(dshort(item.day))}, ${SLOTS[item.slot].toLowerCase()}</span>
          <span class="mp-step" aria-label="Porties in je menu"><button data-ip="-">−</button><b>${C.fmt(itemPortions, 2)}</b><button data-ip="+">+</button></span></div>
          <button class="btn secondary" id="swap" style="width:100%;margin-top:8px">⇄ Ander gerecht kiezen</button>
          <button class="linkbtn" id="unplan" style="margin-top:8px;color:var(--bad)">Uit het menu van deze dag halen</button></section>` : ""}
      ${r.status === "concept" ? `<section class="mp-box"><p class="small" style="margin:0 0 8px">${C.esc(r.description || "Nog geen details.")}</p>
          <button class="btn" id="aiFill" style="width:100%">✨ Laat Claude het uitwerken</button></section>` : ""}
      ${m("kcal") != null ? `<div class="macros" style="grid-template-columns:repeat(4,1fr)">
          ${[["kcal", "kcal", ""], ["protein", "eiwit", "g"], ["carbs", "koolh.", "g"], ["fat", "vet", "g"]].map(([k, l, u]) =>
            `<div class="macro"><div class="v">${C.fmt(m(k))}${u ? `<small> ${u}</small>` : ""}</div><div class="l">${l} / portie</div></div>`).join("")}</div>` : ""}
      ${r.ingredients?.length ? `<div class="row" style="justify-content:space-between;margin-top:14px">
          <h4 style="margin:0">Ingrediënten</h4>
          <span class="mp-step" aria-label="Aantal porties"><button data-p="-">−</button><b>${C.fmt(portions, 2)}</b><button data-p="+">+</button><span class="small muted">porties</span></span></div>
        <ul class="mp-ul">${r.ingredients.map((i) => `<li>${C.esc(ingLine(i, portions))}${i.pantry ? ` <span class="small muted">· voorraad</span>` : ""}</li>`).join("")}</ul>` : ""}
      ${r.steps?.length ? `<h4 style="margin:14px 0 4px">Bereiding</h4><ol class="mp-ul">${r.steps.map((s) => `<li>${C.esc(s)}</li>`).join("")}</ol>` : ""}
      ${r.storage ? `<p class="small" style="margin:10px 0 0"><b>Bewaren:</b> ${C.esc(r.storage)}</p>` : ""}
      ${r.source_url && /^https?:\/\//.test(r.source_url) ? `<p class="small" style="margin:6px 0 0"><a href="${C.esc(r.source_url)}" target="_blank" rel="noopener noreferrer">Bron van het recept</a></p>` : ""}
      ${r.ingredients?.length ? `<div class="mp-actions">
          <button class="btn" id="cook">👨‍🍳 Kookmodus</button>
          <button class="btn secondary" id="edit">✏️ Recept aanpassen</button>
          <button class="btn secondary" id="toList">+ ${C.fmt(portions, 2)} porties op mijn lijst</button>
          <button class="btn secondary" id="bevel">Kopieer voor Bevel</button>
          ${m("kcal") != null ? `<button class="btn secondary" id="logIt">1 portie loggen in Health Hub</button>` : ""}
        </div>` : ""}
      <div class="field" style="margin-top:14px"><label for="note">Opmerking voor de planner</label>
        <textarea class="input" id="note" rows="2" maxlength="500" placeholder="bv. minder zout, meer saus, enkel in het weekend">${C.esc(r.note || "")}</textarea></div>
      <div class="row" style="justify-content:space-between"><button class="btn ghost" id="saveNote">Opmerking bewaren</button>
        <button class="linkbtn" id="hide" style="color:var(--bad)">Recept verwijderen</button></div>`;
    bind();
  };

  const opinion = async (op) => {
    const now = op === "lekker" ? (r.favorite ? "neutraal" : "lekker") : (r.disliked ? "neutraal" : "niet");
    await C.rpc("mp_set_opinion", { p_id: r.id, p_opinion: now });
    r.favorite = now === "lekker"; r.disliked = now === "niet";
    C.toast(now === "lekker" ? "★ Komt vaker terug" : now === "niet" ? "👎 Komt niet meer in je menu" : "Mening gewist");
    render();
    if (tab === "recepten") drawRecipes($("#mpBody"));
  };

  const bind = () => {
    card.querySelector("[data-close]").onclick = close;
    card.querySelectorAll("[data-op]").forEach((b) => (b.onclick = () => opinion(b.dataset.op)));
    card.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => {
      portions = Math.max(1, Math.min(12, portions + (b.dataset.p === "+" ? 1 : -1))); render();
    }));
    card.querySelectorAll("[data-ip]").forEach((b) => (b.onclick = async () => {
      const nv = Math.max(0.5, Math.min(3, itemPortions + (b.dataset.ip === "+" ? 0.25 : -0.25)));
      if (nv === itemPortions) return;
      try { await C.rpc("mp_item_set", { p_item_id: item.id, p_recipe_id: r.id, p_portions: nv }); itemPortions = nv; item.portions = nv; render(); reload(); }
      catch (e) { C.toast(e.message, 4000); }
    }));
    card.querySelector("#swap")?.addEventListener("click", () => { close(); openSwap(item); });
    card.querySelector("#unplan")?.addEventListener("click", async () => {
      try { await C.rpc("mp_item_remove", { p_item_id: item.id }); close(); C.toast(`${r.name} uit het menu gehaald`); reload(); }
      catch (e) { C.toast(e.message, 5000); }
    });
    card.querySelector("#aiFill")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await C.rpc("recipe_inbox_add", { p_text: `Concept #${r.id} uitwerken: ${r.name}\n${r.description || ""}`, p_image_path: null });
        e.target.textContent = "✓ Claude werkt het binnen het uur uit";
      } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
    });
    card.querySelector("#cook")?.addEventListener("click", () => { close(); openCook(r, portions); });
    card.querySelector("#edit")?.addEventListener("click", () => { close(); openEdit(r); });
    card.querySelector("#toList")?.addEventListener("click", async () => {
      try { await C.rpc("mp_list_add_recipe", { p_week_id: D.current_week_id ?? null, p_recipe_id: r.id, p_portions: portions });
        C.toast(`${r.name} op je lijst gezet`); reload(); }
      catch (e) { C.toast(e.message, 4000); }
    });
    card.querySelector("#bevel")?.addEventListener("click", async () => {
      const txt = bevelText(r, portions);
      if (await copyText(txt)) C.toast("Gekopieerd. In Bevel: Mijn voedsel → + → Recept maken → Recept importeren → plakken.", 7000);
      else showText("Kopieer voor Bevel", txt);
    });
    card.querySelector("#logIt")?.addEventListener("click", async () => {
      try {
        await C.rpc("log_food", { p: { day: C.today(), meal: FOOD_MEAL[r.meal_type], name: r.name,
          kcal: n(r.kcal), protein: n(r.protein), carbs: n(r.carbs), fat: n(r.fat) } });
        C.toast(`1 portie ${r.name} gelogd bij ${FOOD_MEAL[r.meal_type]}`);
      } catch (e) { C.toast(e.message, 4000); }
    });
    card.querySelector("#saveNote").onclick = async () => {
      try { await C.rpc("mp_set_note", { p_id: r.id, p_note: card.querySelector("#note").value }); r.note = card.querySelector("#note").value.trim() || null; C.toast("Opmerking bewaard"); }
      catch (e) { C.toast(e.message, 4000); }
    };
    card.querySelector("#hide").onclick = async () => {
      if (!confirm(`"${r.name}" verwijderen uit je recepten?`)) return;
      try { await C.rpc("mp_hide_recipe", { p_id: r.id }); close(); C.toast("Recept verwijderd"); reload(); }
      catch (e) { C.toast(e.message, 5000); }
    };
  };
  render();
}

function showText(title, text) {
  const { card, close } = sheetShell(title);
  card.innerHTML = `${head(C.esc(title))}<p class="small muted">Kopiëren lukte niet automatisch. Houd de tekst ingedrukt en kies Kopieer.</p>
    <textarea class="input" rows="14" readonly style="width:100%;font-size:14px">${C.esc(text)}</textarea>`;
  card.querySelector("[data-close]").onclick = close;
  const ta = card.querySelector("textarea"); ta.focus(); ta.select();
}

// Wisselen: ander recept van hetzelfde soort (niet 👎), favorieten eerst
function openSwap(item) {
  const cur = recById(item.recipe_id);
  const opts = D.recipes.filter((r) => slotFits(r, item.slot) && r.status === "klaar" && !r.disliked && r.id !== item.recipe_id)
    .sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name));
  const dayItems = (currentWeek()?.items || []).filter((i) => i.slot === item.slot).sort((a, b) => a.day.localeCompare(b.day));
  const picked = () => {
    const ids = [...card.querySelectorAll("[data-day]:checked")].map((c) => Number(c.dataset.day));
    return dayItems.filter((i) => ids.includes(i.id));
  };
  const { card, close } = sheetShell("Ander gerecht");
  card.innerHTML = `${head("Ander gerecht kiezen")}
    <p class="small muted" style="margin:4px 0 8px">${C.esc(dshort(item.day))}, ${SLOTS[item.slot].toLowerCase()}. Nu: ${C.esc(cur?.name || "")} (${C.fmt(cur?.kcal)} kcal).</p>
    <div class="sub-h" style="margin-top:4px">Op welke dagen?</div>
    <div class="mp-days">${dayItems.map((i) => { const r = recById(i.recipe_id); return `<label class="mp-check"><input type="checkbox" data-day="${i.id}" ${i.id === item.id ? "checked" : ""}>
      <span class="t"><b style="text-transform:capitalize">${C.esc(dshort(i.day))}</b> <span class="small muted">· ${C.esc(r?.name || "")}</span></span></label>`; }).join("")}</div>
    <button class="newidea" id="newIdea"><span>✨</span><span><b>Nieuw recept laten voorstellen</b><br><span class="small">Claude bedenkt iets nieuws dat in je macro's past en zet het op je menu. Binnen het uur, met een melding.</span></span></button>
    <input class="input" id="ideaHint" placeholder="Wens? Bv. iets met zalm, of snel klaar (optioneel)" style="margin:8px 0 10px">
    <div class="sub-h" style="margin-top:4px">Of kies een bestaand recept</div>
    ${opts.map((r) => `<button class="pk-item" data-r="${r.id}"><span><b>${r.favorite ? "★ " : ""}${C.esc(r.name)}</b><br>
      <span class="small muted">${C.fmt(r.kcal)} kcal · ${C.fmt(r.protein)} g eiwit${n(cur?.kcal) != null && n(r.kcal) != null ? ` · ${r.kcal - cur.kcal >= 0 ? "+" : ""}${C.fmt(r.kcal - cur.kcal)} kcal` : ""}</span></span><span>⇄</span></button>`).join("")
      || `<p class="muted">Geen andere ${SLOTS[item.slot].toLowerCase()}recepten. Voeg er een toe bij Recepten.</p>`}`;
  card.querySelector("[data-close]").onclick = close;
  card.querySelector("#newIdea").onclick = async () => {
    const targets = picked();
    if (!targets.length) return C.toast("Kies minstens één dag.");
    const hint = card.querySelector("#ideaHint").value.trim();
    const text = `Nieuw voorstel voor menu: vervang "${cur?.name || "?"}" (${SLOTS[item.slot].toLowerCase()}) op ${targets.map((t) => t.day).join(", ")}.\nItems: ${targets.map((t) => t.id).join(",")}\nMaaltijd: ${item.slot}${hint ? `\nWens: ${hint}` : ""}`;
    try { await C.rpc("recipe_inbox_add", { p_text: text, p_image_path: null }); close(); C.toast("Gevraagd. Je krijgt een melding zodra het nieuwe recept op je menu staat.", 5000); }
    catch (e) { C.toast(e.message, 5000); }
  };
  card.querySelectorAll("[data-r]").forEach((b) => (b.onclick = async () => {
    const targets = picked();
    if (!targets.length) return C.toast("Kies minstens één dag.");
    try {
      for (const t of targets) await C.rpc("mp_item_set", { p_item_id: t.id, p_recipe_id: Number(b.dataset.r), p_portions: n(t.portions) || 1 });
      close(); C.toast(`Gewisseld op ${targets.length} ${targets.length === 1 ? "dag" : "dagen"}`); reload();
    } catch (e) { C.toast(e.message, 5000); }
  }));
}

// snack en avondsnack zijn onderling wisselbaar
const slotFits = (r, slot) => r.meal_type === slot || (["snack", "avondsnack"].includes(slot) && ["snack", "avondsnack"].includes(r.meal_type));

// Een maaltijd toevoegen aan een lege plek in het weekmenu (bv. snack na het avondeten)
function openAddSlot(w, day, slot) {
  const opts = D.recipes.filter((r) => slotFits(r, slot) && r.status === "klaar" && !r.disliked)
    .sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name));
  const { card, close } = sheetShell(`${SLOTS[slot]} toevoegen`);
  card.innerHTML = `${head(`${SLOTS[slot]} op ${C.esc(dshort(day))}`)}
    <button class="newidea" id="asNew" style="margin-top:10px"><span>➕</span><span><b>Nieuw recept of product</b><br><span class="small">Bv. XXL Fitpudding: kies het product, de macro's komen uit Voeding.</span></span></button>
    <div class="sub-h" style="margin-top:10px">Of kies een bestaand recept</div>
    ${opts.map((r) => `<button class="pk-item" data-r="${r.id}"><span><b>${r.favorite ? "★ " : ""}${C.esc(r.name)}</b><br>
      <span class="small muted">${C.fmt(r.kcal)} kcal · ${C.fmt(r.protein)} g eiwit</span></span><span>＋</span></button>`).join("")
      || `<p class="muted small">Nog geen ${SLOTS[slot].toLowerCase()}recepten.</p>`}`;
  card.querySelector("[data-close]").onclick = close;
  const add = async (rid) => {
    await C.rpc("mp_item_add", { p_week_id: w.id, p_day: day, p_slot: slot, p_recipe_id: rid, p_portions: 1 });
    C.toast(`Toegevoegd aan ${dshort(day)}`); reload();
  };
  card.querySelectorAll("[data-r]").forEach((b) => (b.onclick = async () => {
    try { await add(Number(b.dataset.r)); close(); } catch (e) { C.toast(e.message, 5000); }
  }));
  card.querySelector("#asNew").onclick = () => { close(); openEdit({ id: null, name: "", meal_type: slot, servings: 1, ingredients: [], steps: [] }, (saved) => saved?.id && add(saved.id)); };
}

// ---------------------------------------------------------------- recept aanpassen
// Alles aanpasbaar. Ingrediënten koppel je aan een echt product uit Voeding (waarden per 100 g),
// zodat de macro's per portie uitgerekend worden in plaats van geschat.
// Wijzigingen gelden voor het recept, dus ook voor je weekmenu en boodschappenlijst.
const UNITS = ["g", "ml", "stuk", "teen", "el", "tl"];
const MK = ["kcal", "protein", "carbs", "fat"];
// gram van een ingrediënt (per portie), of null als dat niet te bepalen is
function ingGrams(i) {
  const a = n(i.amount); if (a === null) return null;
  if (!i.unit || i.unit === "g" || i.unit === "ml") return a;
  return n(i.g_per_unit) != null ? a * n(i.g_per_unit) : null;
}
function ingMacros(i) {
  const g = ingGrams(i);
  if (!i.per100 || g === null) return null;
  return Object.fromEntries(MK.map((k) => [k, (n(i.per100[k]) || 0) * g / 100]));
}
// totaal per portie + welke ingrediënten nog geen voedingswaarden hebben
function recipeMacros(ings) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 }; let linked = 0; const missing = [];
  for (const i of ings) {
    const m = ingMacros(i);
    if (m) { linked++; MK.forEach((k) => (t[k] += m[k])); }
    else if (!i.pantry && n(i.amount) !== null) missing.push(i.name || "?");
  }
  return { t, linked, missing };
}

async function openEdit(r0, onSaved) {
  if (!r0) return;
  const F = await import("./food.js");
  let r = { ...r0 };
  const isNew = !r.id;
  const { card, close } = sheetShell(isNew ? "Nieuw recept" : `${r.name} aanpassen`);
  let ings = (r.ingredients || []).map((i) => ({ ...i }));
  const f = (id, label, val, mode = "decimal") => `<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" inputmode="${mode}" value="${C.esc(val ?? "")}"></div>`;
  const linkInfo = (i) => {
    if (!i.per100) return `<button class="chip e-link warn" type="button">🔗 Koppel aan product</button>`;
    const m = ingMacros(i);
    const needG = i.unit && i.unit !== "g" && i.unit !== "ml";
    return `<button class="chip e-link on" type="button" title="Ander product kiezen">✓ ${C.esc(i.food_name || i.name)}</button>
      ${needG ? `<span class="small e-gpu">1 ${C.esc(i.unit)} = <input class="input e-gpu-in" inputmode="decimal" value="${C.esc(n(i.g_per_unit) ?? "")}" aria-label="Gram per ${C.esc(i.unit)}"> g</span>` : ""}
      <span class="small muted e-mac">${m ? `${C.fmt(m.kcal)} kcal · ${C.fmt(m.protein)} g eiwit` : "gram ontbreekt"}</span>`;
  };
  const ingRow = (i, k) => `<div class="mp-erow" data-k="${k}">
      <input class="input e-amt" inputmode="decimal" aria-label="Hoeveelheid per portie" placeholder="naar smaak" value="${C.esc(n(i.amount) ?? "")}">
      <select class="input e-unit" aria-label="Eenheid"><option value="">–</option>${UNITS.map((u) => `<option ${u === i.unit ? "selected" : ""}>${u}</option>`).join("")}</select>
      <input class="input e-name" aria-label="Naam op je boodschappenlijst" value="${C.esc(i.name || "")}" placeholder="Ingrediënt">
      <button class="icon-btn e-del" type="button" aria-label="Verwijderen">✕</button>
      <div class="e-link-row">${linkInfo(i)}</div>
      <select class="input e-dept" aria-label="Afdeling in de winkel">${DEPTS.map((d) => `<option ${d === (i.dept || "Overig") ? "selected" : ""}>${C.esc(d)}</option>`).join("")}</select>
      <label class="small e-pan"><input type="checkbox" class="e-pantry" ${i.pantry ? "checked" : ""}> voorraad</label>
    </div>`;
  const collect = () => {
    card.querySelectorAll(".mp-erow").forEach((row) => {
      const i = ings[Number(row.dataset.k)]; if (!i) return;
      const a = row.querySelector(".e-amt").value.trim().replace(",", ".");
      i.amount = a === "" || Number.isNaN(Number(a)) ? null : Number(a);
      i.unit = row.querySelector(".e-unit").value || null;
      i.name = row.querySelector(".e-name").value.trim();
      i.dept = row.querySelector(".e-dept").value;
      i.pantry = row.querySelector(".e-pantry").checked;
      const gp = row.querySelector(".e-gpu-in");
      if (gp) { const x = gp.value.trim().replace(",", "."); i.g_per_unit = x === "" || Number.isNaN(Number(x)) ? null : Number(x); }
    });
  };
  const v = (id) => card.querySelector("#" + id)?.value.trim() ?? "";
  const keep = () => {
    collect();
    r = { ...r, name: v("eName"), meal_type: card.querySelector("#eType").value, servings: n(v("eServ")) || r.servings || 1,
      steps: v("eSteps").split("\n").map((x) => x.trim()).filter(Boolean), storage: v("eStore") };
  };
  const macroHtml = () => {
    const { t, linked, missing } = recipeMacros(ings);
    if (!linked) return `<p class="small muted" style="margin:0">${n(r.kcal) != null
      ? `Nu: ${C.fmt(r.kcal)} kcal · ${C.fmt(r.protein)} g eiwit per portie, <b>geschat</b>. Koppel de ingrediënten aan producten, dan worden ze echt uitgerekend.`
      : "Koppel de ingrediënten aan producten, dan rekent de app de macro's uit."}</p>`;
    return `<div class="macros" style="grid-template-columns:repeat(4,1fr)">
        ${[["kcal", "kcal", ""], ["protein", "eiwit", "g"], ["carbs", "koolh.", "g"], ["fat", "vet", "g"]].map(([k, l, u]) =>
          `<div class="macro"><div class="v">${C.fmt(t[k])}${u ? `<small> ${u}</small>` : ""}</div><div class="l">${l} / portie</div></div>`).join("")}</div>
      ${missing.length ? `<p class="small" style="margin:6px 0 0;color:var(--bad)">Nog zonder voedingswaarden (telt als 0): ${C.esc(missing.join(", "))}</p>`
        : `<p class="small muted" style="margin:6px 0 0">✓ Alles gekoppeld: uitgerekend uit je producten.</p>`}`;
  };
  const updMacros = () => { collect(); card.querySelector("#eMac").innerHTML = macroHtml();
    card.querySelectorAll(".mp-erow").forEach((row) => { const m = ingMacros(ings[Number(row.dataset.k)]); const el = row.querySelector(".e-mac");
      if (el) el.textContent = m ? `${C.fmt(m.kcal)} kcal · ${C.fmt(m.protein)} g eiwit` : "gram ontbreekt"; }); };

  const render = () => {
    card.innerHTML = `${head(isNew ? "Nieuw recept" : `✏️ ${C.esc(r.name)}`)}
      <p class="small muted" style="margin:4px 0 0">${isNew ? "Ingrediënten per portie, gekoppeld aan echte producten." : "Geldt voor het recept: ook je weekmenu en boodschappenlijst passen zich aan."}</p>
      ${f("eName", "Naam", r.name, "text")}
      <div class="grid2">
        <div class="field"><label for="eType">Maaltijd</label><select class="input" id="eType">${Object.entries(SLOTS).map(([k, l]) => `<option value="${k}" ${k === r.meal_type ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        ${f("eServ", "Koken voor (porties)", r.servings || 1, "numeric")}
      </div>
      <h4 style="margin:12px 0 4px">Ingrediënten <span class="small muted">per portie</span></h4>
      <div id="eIngs">${ings.map(ingRow).join("") || `<p class="small muted">Nog geen ingrediënten.</p>`}</div>
      <div class="row" style="gap:8px;margin-top:6px">
        <button class="btn secondary" id="eAdd" type="button" style="flex:1">+ Product zoeken</button>
        <button class="btn ghost" id="eAddFree" type="button">+ Zonder product</button>
      </div>
      <h4 style="margin:14px 0 6px">Macro's per portie</h4>
      <div id="eMac">${macroHtml()}</div>
      <div class="field" style="margin-top:12px"><label for="eSteps">Bereiding (één stap per regel)</label>
        <textarea class="input" id="eSteps" rows="5">${C.esc((r.steps || []).join("\n"))}</textarea></div>
      <div class="field"><label for="eStore">Bewaren</label><textarea class="input" id="eStore" rows="2">${C.esc(r.storage || "")}</textarea></div>
      <button class="btn" id="eSave" style="width:100%">Bewaren</button>`;
    bind();
  };
  const linkTo = (k) => {
    keep();
    const i = ings[k];
    F.pickFood(C, (food, g) => {
      const per = food.per100 || {};
      i.food_id = food.id; i.food_name = food.name;
      i.per100 = { kcal: n(per.kcal), protein: n(per.protein), carbs: n(per.carbs), fat: n(per.fat) };
      if (!i.name) i.name = food.name;
      if (!i.unit || i.unit === "g" || i.unit === "ml") { if (n(i.amount) === null) i.amount = g; if (!i.unit) i.unit = "g"; }
      else i.g_per_unit = Math.round((g / (n(i.amount) || 1)) * 10) / 10;
      render();
    }, { initial: i.name || "" });
  };
  const bind = () => {
    card.querySelector("[data-close]").onclick = close;
    card.querySelectorAll(".mp-erow input, .mp-erow select").forEach((el) => el.addEventListener("input", updMacros));
    card.querySelectorAll(".mp-erow .e-unit").forEach((el) => el.addEventListener("change", () => { keep(); render(); }));
    card.querySelectorAll(".e-link").forEach((b) => (b.onclick = () => linkTo(Number(b.closest(".mp-erow").dataset.k))));
    card.querySelectorAll(".e-del").forEach((b) => (b.onclick = () => { keep(); ings.splice(Number(b.closest(".mp-erow").dataset.k), 1); render(); }));
    card.querySelector("#eAdd").onclick = () => {
      keep();
      F.pickFood(C, (food, g) => {
        const per = food.per100 || {};
        ings.push({ name: food.name, amount: g, unit: "g", dept: "Overig", pantry: false, food_id: food.id, food_name: food.name,
          per100: { kcal: n(per.kcal), protein: n(per.protein), carbs: n(per.carbs), fat: n(per.fat) } });
        render();
        card.querySelector(".mp-erow:last-of-type .e-dept")?.focus();
      });
    };
    card.querySelector("#eAddFree").onclick = () => { keep(); ings.push({ name: "", amount: null, unit: null, dept: "Houdbaar", pantry: true }); render();
      card.querySelector(".mp-erow:last-of-type .e-name")?.focus(); };
    card.querySelector("#eSave").onclick = async (e) => {
      keep();
      const list = ings.filter((i) => i.name);
      const { t, linked, missing } = recipeMacros(list);
      if (!check(card, [
        { el: "#eName", ok: !!r.name, msg: "Geef het recept een naam." },
        { el: "#eAdd", ok: linked > 0 || n(r.kcal) != null, msg: "Voeg minstens één product toe, dan kan de app de macro's uitrekenen." },
      ])) return;
      if (linked && missing.length && !confirm(`${missing.join(", ")} ${missing.length === 1 ? "heeft" : "hebben"} nog geen voedingswaarden en telt als 0. Toch bewaren?`)) return;
      const mac = linked ? Object.fromEntries(MK.map((k) => [k, Math.round(t[k] * 10) / 10])) : { kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat };
      e.target.disabled = true;
      try {
        const saved = await C.rpc("mp_save_recipe", { p: { id: r.id ?? null, name: r.name, meal_type: r.meal_type, servings: r.servings, ...mac,
          macros_checked: linked > 0 && !missing.length,
          ingredients: list.map((i) => ({ name: i.name, amount: n(i.amount), unit: i.unit || null, dept: i.dept || "Overig", pantry: !!i.pantry,
            ...(i.per100 ? { food_id: i.food_id, food_name: i.food_name, per100: i.per100, g_per_unit: n(i.g_per_unit) } : {}) })),
          steps: r.steps, storage: r.storage || null, source_url: r.source_url || null, description: r.description || null,
          status: "klaar", favorite: r.favorite ?? true } });
        Object.assign(r0, saved || {});
        close(); C.toast(isNew ? "Recept bewaard" : "Recept aangepast"); await onSaved?.(saved); reload();
      } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
    };
  };
  render();
}

// ---------------------------------------------------------------- kookmodus
async function openCook(r, portions) {
  if (!r) return;
  const { sheet, card, close } = sheetShell("Kookmodus");
  sheet.classList.add("mp-cookmode");
  let lock = null;
  try { lock = await navigator.wakeLock?.request("screen"); } catch { /* niet ondersteund */ }
  sheet._onClose = () => { try { lock?.release(); } catch { /* */ } };
  const done = new Set();
  const render = () => {
    card.innerHTML = `${head(`👨‍🍳 ${C.esc(r.name)}`)}
      <div class="row" style="justify-content:space-between;margin:8px 0">
        <span class="row" style="gap:8px"><button class="btn ghost" id="cEdit" style="padding:6px 10px">✏️ Aanpassen</button><span class="small muted">${lock ? "Scherm blijft aan" : ""}</span></span>
        <span class="mp-step"><button data-p="-">−</button><b>${C.fmt(portions, 2)}</b><button data-p="+">+</button><span class="small muted">porties</span></span></div>
      <h4 style="margin:6px 0">Klaarzetten</h4>
      ${(r.ingredients || []).map((i, k) => `<label class="mp-check big ${done.has("i" + k) ? "done" : ""}"><input type="checkbox" data-k="i${k}" ${done.has("i" + k) ? "checked" : ""}>
        <span class="t">${C.esc(ingLine(i, portions))}</span></label>`).join("")}
      <h4 style="margin:14px 0 6px">Stappen</h4>
      ${(r.steps || []).map((s, k) => `<label class="mp-check big step ${done.has("s" + k) ? "done" : ""}"><input type="checkbox" data-k="s${k}" ${done.has("s" + k) ? "checked" : ""}>
        <span class="t"><b>${k + 1}.</b> ${C.esc(s)}</span></label>`).join("")}
      ${r.storage ? `<p class="small" style="margin-top:12px"><b>Bewaren:</b> ${C.esc(r.storage)}</p>` : ""}`;
    card.querySelector("[data-close]").onclick = close;
    card.querySelector("#cEdit").onclick = () => openEdit(r, () => render());
    card.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { portions = Math.max(1, Math.min(12, portions + (b.dataset.p === "+" ? 1 : -1))); render(); }));
    card.querySelectorAll("input[data-k]").forEach((cb) => (cb.onchange = () => {
      cb.checked ? done.add(cb.dataset.k) : done.delete(cb.dataset.k);
      cb.closest(".mp-check").classList.toggle("done", cb.checked);
    }));
  };
  render();
}

// ---------------------------------------------------------------- recept toevoegen
async function imageToBlob(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.naturalWidth * s); cv.height = Math.round(img.naturalHeight * s);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    return await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.82));
  } finally { URL.revokeObjectURL(url); }
}

// Recept toevoegen: foto en/of tekst gaan naar de inbox. Een geplande Claude-taak (elk uur)
// werkt ze uit tot een volledig recept en stuurt een melding. Geen API-kosten.
function openAdd() {
  const { card, close } = sheetShell("Recept toevoegen");
  let photo = null, preview = null;
  card.innerHTML = `${head("Recept toevoegen")}
    <label class="btn mp-big" style="margin-top:12px" id="aPhotoBtn">📷 Foto maken of kiezen
      <input type="file" id="aPhoto" accept="image/*" hidden></label>
    <img id="aPrev" alt="" hidden style="width:100%;max-height:220px;object-fit:cover;border-radius:12px;margin-top:10px">
    <div class="field" style="margin-top:12px"><label for="aText">Wat is het? (optioneel bij een foto)</label>
      <textarea class="input" id="aText" rows="3" placeholder="bv. kip curry met rijst voor 3 dagen, of plak een link"></textarea></div>
    <select class="input" id="aType" style="margin-bottom:10px"><option value="">Maaltijd: laat Claude kiezen</option>${Object.entries(SLOTS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
    <button class="btn" id="aSend" style="width:100%">Versturen</button>
    <p class="small muted" id="aMsg" style="margin:8px 0 0">Claude werkt het binnen het uur uit (tussen 8u en 23u) met ingrediënten, stappen en macro's, en zet het met ★ bij je recepten. Je krijgt een melding.</p>
    <div id="aInbox"></div>`;
  card.querySelector("[data-close]").onclick = () => { if (preview) URL.revokeObjectURL(preview); close(); };
  const msg = card.querySelector("#aMsg");
  card.querySelector("#aPhoto").onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      photo = await imageToBlob(f);
      if (preview) URL.revokeObjectURL(preview);
      preview = URL.createObjectURL(photo);
      const im = card.querySelector("#aPrev"); im.src = preview; im.hidden = false;
      card.querySelector("#aPhotoBtn").firstChild.textContent = "📷 Andere foto ";
    } catch { C.toast("Deze foto kon ik niet openen. Probeer een JPEG of PNG.", 5000); }
  };
  card.querySelector("#aSend").onclick = async (e) => {
    const t = card.querySelector("#aText").value.trim();
    const type = card.querySelector("#aType").value;
    if (!check(card, [{ el: "#aText", ok: !!(photo || t), msg: "Kies een foto of typ wat het is." }])) return;
    e.target.disabled = true; msg.textContent = "Versturen…";
    try {
      let path = null;
      if (photo) {
        path = `${crypto.randomUUID()}.jpg`;
        const { error } = await C.sb.storage.from("recipe-inbox").upload(path, photo, { contentType: "image/jpeg", upsert: false });
        if (error) throw error;
      }
      const text = [type ? `Maaltijd: ${SLOTS[type].toLowerCase()}` : "", t].filter(Boolean).join("\n") || null;
      await C.rpc("recipe_inbox_add", { p_text: text, p_image_path: path });
      if (preview) URL.revokeObjectURL(preview);
      close(); C.toast("Verstuurd. Claude zet het binnen het uur bij je recepten.", 5000);
    } catch (err) { e.target.disabled = false; msg.textContent = "Versturen lukte niet: " + (err.message || err); }
  };
  // Wat staat er nog in de wachtrij?
  C.rpc("recipe_inbox_list").then((list) => {
    if (!list?.length) return;
    const lab = { nieuw: "⏳ in de wachtrij", bezig: "⏳ bezig", klaar: "✓ klaar", fout: "⚠︎ lukte niet" };
    card.querySelector("#aInbox").innerHTML = `<h4 style="margin:16px 0 4px">Recent verstuurd</h4>${list.map((i) =>
      `<div class="mp-row"><span class="small">${C.esc(i.recipe_name || (i.text || "Foto").split("\n").pop().slice(0, 60))}${i.error ? `<br><span class="muted">${C.esc(i.error)}</span>` : ""}</span>
        <span class="small muted" style="white-space:nowrap">${lab[i.status] || i.status}</span></div>`).join("")}`;
  }).catch(() => {});
}

// Voorbeeld van een herkend recept: aanpassen en bewaren
function openPreview(rec) {
  const { card, close } = sheetShell("Nieuw recept");
  const f = (id, label, val, mode = "decimal") => `<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" inputmode="${mode}" value="${C.esc(val ?? "")}"></div>`;
  card.innerHTML = `${head("Klopt dit?")}
    ${rec.notes ? `<p class="hint small" style="margin:8px 0 0">${C.esc(rec.notes)}</p>` : ""}
    ${f("pName", "Naam", rec.name, "text")}
    <div class="grid2">
      <div class="field"><label for="pType">Maaltijd</label><select class="input" id="pType">${Object.entries(SLOTS).map(([k, l]) => `<option value="${k}" ${k === rec.meal_type ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      ${f("pServ", "Koken voor (porties)", rec.servings, "numeric")}
      <div class="fk-kcal">${f("pK", "kcal / portie", Math.round(rec.kcal))}</div><div class="fk-prot">${f("pP", "Eiwit (g)", Math.round(rec.protein))}</div>
      <div class="fk-carb">${f("pC", "Koolhydraten (g)", Math.round(rec.carbs))}</div><div class="fk-fat">${f("pF", "Vet (g)", Math.round(rec.fat))}</div>
    </div>
    <h4 style="margin:10px 0 4px">Ingrediënten per portie</h4>
    <ul class="mp-ul">${(rec.ingredients || []).map((i) => `<li>${C.esc(ingLine(i))}${i.pantry ? ` <span class="small muted">· voorraad</span>` : ""}</li>`).join("")}</ul>
    <h4 style="margin:10px 0 4px">Bereiding</h4>
    <ol class="mp-ul">${(rec.steps || []).map((s) => `<li>${C.esc(s)}</li>`).join("")}</ol>
    ${rec.storage ? `<p class="small"><b>Bewaren:</b> ${C.esc(rec.storage)}</p>` : ""}
    <label class="small row" style="margin:10px 0"><input type="checkbox" id="pFav" ${rec.favorite !== false ? "checked" : ""}> ★ Lekker: vaker in mijn weekmenu</label>
    <button class="btn" id="pSave" style="width:100%">Recept bewaren</button>
    <button class="btn secondary" id="pLog" style="width:100%;margin-top:8px">Bewaren en 1 portie loggen bij vandaag</button>
    <p class="small muted" style="margin:6px 0 0">Macro's zijn een schatting van de AI. Je kan ingrediënten later via Claude laten aanpassen.</p>`;
  card.querySelector("[data-close]").onclick = close;
  const save = async (e, log) => {
    const v = (id) => card.querySelector("#" + id).value.trim();
    const num = (id) => { const x = v(id).replace(",", "."); return x === "" || Number.isNaN(Number(x)) ? null : Number(x); };
    if (!check(card, [
      { el: "#pName", ok: !!v("pName"), msg: "Geef het recept een naam." },
      { el: "#pK", ok: num("pK") != null, msg: "Vul de kcal per portie in." },
    ])) return;
    e.target.disabled = true;
    try {
      await C.rpc("mp_save_recipe", { p: { id: rec.id ?? null, name: v("pName"), meal_type: card.querySelector("#pType").value,
        servings: num("pServ") || 2, kcal: num("pK"), protein: num("pP"), carbs: num("pC"), fat: num("pF"), macros_checked: false,
        ingredients: rec.ingredients || [], steps: rec.steps || [], storage: rec.storage || null, source_url: rec.source_url || null,
        description: rec.notes || null, status: "klaar", favorite: card.querySelector("#pFav").checked } });
      if (log) await C.rpc("log_food", { p: { day: C.today(), meal: FOOD_MEAL[card.querySelector("#pType").value], name: v("pName"),
        kcal: num("pK"), protein: num("pP"), carbs: num("pC"), fat: num("pF") } });
      close(); C.toast(log ? "Recept bewaard en gelogd" : "Recept bewaard"); tab = "recepten"; filter = "alle"; reload();
    } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
  };
  enterSubmits(card, "#pSave");
  card.querySelector("#pSave").onclick = (e) => save(e, false);
  card.querySelector("#pLog").onclick = (e) => save(e, true);
}
