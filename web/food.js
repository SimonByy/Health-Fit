// Voeding loggen in Health Hub: zoeken (eigen producten + Open Food Facts),
// barcode scannen, portie kiezen, per maaltijd bijhouden.
let C;
export const MEALS = ["Ontbijt", "Lunch", "Snack", "Avondeten", "Laat"];
const MACROS = [["kcal", "kcal", ""], ["protein", "Eiwit", "g"], ["carbs", "Koolh.", "g"], ["fat", "Vet", "g"]];

export function mealForNow() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hour12: false }).format(new Date()));
  if (h < 11) return "Ontbijt";
  if (h < 15) return "Lunch";
  if (h < 18) return "Snack";
  if (h < 22) return "Avondeten";
  return "Laat";
}
const scale = (per100, g) => Object.fromEntries(MACROS.map(([k]) => [k, per100?.[k] == null ? null : (Number(per100[k]) * g) / 100]));

// ---------------- daglijst per maaltijd ----------------
export async function renderFoodLog(ctx, day, box, after) {
  C = ctx;
  const items = await C.rpc("get_food_log", { p_day: day });
  if (!items.length) {
    box.innerHTML = `<p class="muted small" style="margin:0">Nog niets gelogd in Health Hub op deze dag.</p>`;
    return;
  }
  const by = Object.fromEntries(MEALS.map((m) => [m, items.filter((i) => i.meal === m)]));
  box.innerHTML = MEALS.filter((m) => by[m].length).map((m) => {
    const tot = by[m].reduce((s, i) => s + (Number(i.kcal) || 0), 0);
    return `<div class="fmeal"><div class="fmeal-h"><b>${m}</b><span>${C.fmt(tot)} kcal</span></div>
      ${by[m].map((i) => `<div class="fitem" data-id="${i.id}">
        <span><span class="t">${C.esc(i.name)}</span>
          <span class="m">${i.grams != null ? `${C.fmt(i.grams)} g · ` : ""}E ${C.fmt(i.protein)} · K ${C.fmt(i.carbs)} · V ${C.fmt(i.fat)}</span></span>
        <span class="k">${C.fmt(i.kcal)}</span>
        <button class="icon-btn fdel" aria-label="${C.esc(i.name)} verwijderen">✕</button>
      </div>`).join("")}</div>`;
  }).join("");
  box.onclick = async (e) => {
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
export function openAddFood(ctx, { day, meal = mealForNow(), after } = {}) {
  C = ctx;
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  document.body.appendChild(sheet);
  let scanner = null;
  const close = () => { scanner?.stop(); sheet.remove(); };
  sheet._close = close;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });

  const head = (title, back) => `<div class="row" style="justify-content:space-between;flex-wrap:nowrap">
      ${back ? `<button class="icon-btn" data-back aria-label="Terug">‹</button>` : ""}
      <h3 style="margin:0;flex:1">${title}</h3><button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>`;
  const wire = (onBack) => {
    sheet.querySelector("[data-close]").onclick = close;
    sheet.querySelector("[data-back]")?.addEventListener("click", onBack || search);
  };
  const mealChips = () => `<div class="chips" id="fMeal" style="margin:10px 0">${MEALS.map((m) =>
    `<button class="chip ${m === meal ? "on" : ""}" data-m="${m}">${m}</button>`).join("")}</div>`;
  const bindMeal = () => sheet.querySelector("#fMeal")?.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    meal = b.dataset.m;
    sheet.querySelectorAll("#fMeal .chip").forEach((c) => c.classList.toggle("on", c === b));
  });

  // ---- zoekscherm ----
  let local = [], remote = [], seq = 0, remoteState = "";
  function search(initial = "") {
    scanner?.stop(); scanner = null;
    sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Voeding toevoegen">
      ${head("Voeding toevoegen")}
      ${mealChips()}
      <div class="row" style="flex-wrap:nowrap">
        <input class="input" id="fQ" placeholder="Zoek product of merk…" autocomplete="off" enterkeyhint="search" value="${C.esc(initial)}">
        <button class="btn" id="fScan" aria-label="Barcode scannen">▥ Scan</button>
      </div>
      <div class="row small" style="margin:8px 0 2px;gap:14px">
        <button class="linkbtn" id="fQuick">Snel kcal/macro's invoeren</button>
        <button class="linkbtn" id="fCustom">Eigen product maken</button>
      </div>
      <div id="fRes" class="pk-list"></div>
      <p class="muted small" style="margin:10px 0 0">Productdata: Open Food Facts (open databank, ODbL).</p>
    </div>`;
    wire(); bindMeal();
    const q = sheet.querySelector("#fQ");
    let t1, t2;
    q.oninput = () => {
      clearTimeout(t1); clearTimeout(t2);
      const term = q.value.trim();
      const my = ++seq;
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
    sheet.querySelector("#fQuick").onclick = quick;
    sheet.querySelector("#fCustom").onclick = () => custom({ name: q.value.trim() });
    q.oninput();
    if (!initial) setTimeout(() => q.focus(), 50);
  }
  const itemHtml = (p, i, src) => {
    const k = p.per100?.kcal;
    return `<button class="pk-item" data-src="${src}" data-i="${i}">
      <span><b>${C.esc(p.name)}</b><br><span class="small muted">${p.brand ? C.esc(p.brand) + " · " : ""}${k != null ? `${C.fmt(k)} kcal/100 g` : "geen kcal"}${p.use_count ? ` · ${p.use_count}× gelogd` : ""}</span></span><span>+</span></button>`;
  };
  function list() {
    const box = sheet.querySelector("#fRes"); if (!box) return;
    const term = sheet.querySelector("#fQ").value.trim();
    const seen = new Set(local.map((p) => p.barcode).filter(Boolean));
    const rem = remote.filter((p) => !p.barcode || !seen.has(p.barcode));
    box.innerHTML =
      (local.length ? `<div class="sub-h">${term ? "Mijn producten" : "Recent"}</div>${local.map((p, i) => itemHtml(p, i, "l")).join("")}` : "")
      + (rem.length ? `<div class="sub-h">Open Food Facts</div>${rem.map((p, i) => itemHtml(p, i, "r")).join("")}` : "")
      + (remoteState === "loading" ? `<p class="muted small">Zoeken in Open Food Facts…</p>` : remoteState ? `<p class="muted small">Open Food Facts: ${C.esc(remoteState)}</p>` : "")
      + (!local.length && !rem.length && !remoteState ? `<p class="muted small">${term ? "Niets gevonden. Scan de barcode of maak een eigen product." : "Zoek een product of scan een barcode."}</p>` : "");
    box.onclick = (e) => {
      const b = e.target.closest(".pk-item"); if (!b) return;
      amount(b.dataset.src === "l" ? local[b.dataset.i] : rem[b.dataset.i]);
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
      ${mealChips()}
      <div class="row" style="flex-wrap:nowrap"><input class="input" id="fG" inputmode="decimal" value="${g}" aria-label="Hoeveelheid in gram" style="font-size:22px;font-weight:600">
        <span class="muted">gram</span></div>
      <div class="chips" style="margin:10px 0">
        ${p.serving_g ? `<button class="chip" data-g="${p.serving_g}">1 portie (${C.esc(p.serving_label || p.serving_g + " g")})</button>
          <button class="chip" data-g="${p.serving_g * 2}">2 porties</button>` : ""}
        ${[50, 100, 150, 200, 250].map((x) => `<button class="chip" data-g="${x}">${x} g</button>`).join("")}
      </div>
      <div class="macros" id="fLive" style="grid-template-columns:repeat(4,1fr)"></div>
      <button class="btn" id="fAdd" style="width:100%;margin-top:14px">Toevoegen aan ${meal}</button>
    </div>`;
    wire(() => search()); bindMeal();
    const inp = sheet.querySelector("#fG");
    const live = () => {
      g = Number(String(inp.value).replace(",", ".")) || 0;
      const v = scale(per, g);
      sheet.querySelector("#fLive").innerHTML = MACROS.map(([k, l, u]) => `<div class="macro"><div class="v">${C.fmt(v[k])}${u ? `<small> ${u}</small>` : ""}</div><div class="l">${l}</div></div>`).join("");
      sheet.querySelector("#fAdd").textContent = `Toevoegen aan ${meal}`;
    };
    inp.oninput = live;
    sheet.querySelector("#fMeal").addEventListener("click", live);
    sheet.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => { inp.value = b.dataset.g; live(); }));
    live();
    sheet.querySelector("#fAdd").onclick = async (e) => {
      if (!(g > 0)) return C.toast("Vul een hoeveelheid in");
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
    wire(() => search());
    sheet.querySelector("#cSave").onclick = async () => {
      const v = (id) => { const x = sheet.querySelector("#" + id).value.trim().replace(",", "."); return x === "" ? null : Number(x); };
      const name = sheet.querySelector("#cN").value.trim();
      if (!name || v("cK") == null) return C.toast("Naam en kcal zijn nodig");
      try {
        const saved = await C.rpc("save_food", { p: { barcode: p.barcode || null, name, brand: sheet.querySelector("#cB").value.trim() || null,
          per100: { kcal: v("cK"), protein: v("cP"), carbs: v("cC"), fat: v("cF"), fiber: v("cFi") }, serving_g: v("cS") } });
        amount(saved);
      } catch (e) {
        // barcode bestaat al lokaal: dan gewoon dat product gebruiken met de nieuwe waarden
        C.toast(e.message, 5000);
      }
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
    wire(() => search()); bindMeal();
    sheet.querySelector("#qSave").onclick = async () => {
      const v = (id) => { const x = sheet.querySelector("#" + id).value.trim().replace(",", "."); return x === "" ? null : Number(x); };
      if (v("qK") == null) return C.toast("Vul minstens kcal in");
      await C.rpc("log_food", { p: { day, meal, name: sheet.querySelector("#qN").value.trim() || "Snel ingevoerd",
        kcal: v("qK"), protein: v("qP"), carbs: v("qC"), fat: v("qF") } });
      close(); C.toast("Toegevoegd"); after?.();
    };
  }

  search();
}
