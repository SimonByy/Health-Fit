// Eén geplande maaltijd uit het weekmenu beheren, vanuit Voeding of de tijdlijn: ook op de dag zelf of achteraf.
// Porties aanpassen, wisselen voor een ander recept, afvinken als gegeten, of weghalen (met ongedaan maken).
// Is ze al gegeten, dan gaat een wijziging ook door in Voeding (eerst uit Voeding, aanpassen, opnieuw loggen).
const n = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const SLOTS = { ontbijt: "Ontbijt", lunch: "Lunch", snack: "Snack", avond: "Avondeten", avondsnack: "Avondsnack" };

// it: { id, week_id, day, slot, recipe_id, portions, eaten }
export async function openPlanItem(C, it0, after) {
  let it = { ...it0 };
  const M = await C.rpc("mp_get");
  const rec = (id) => (M.recipes || []).find((r) => r.id === id);
  // vanuit de tijdlijn komt enkel het id mee: de rest uit het weekmenu
  for (const w of M.weeks || []) { const x = (w.items || []).find((i) => i.id === it.id); if (x) { it = { ...x, ...it, week_id: w.id, eaten: x.eaten ?? it.eaten }; break; } }
  let r = rec(it.recipe_id), q = n(it.portions) || 1, eaten = !!it.eaten;
  const sheet = document.createElement("div"); sheet.className = "sheet";
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Geplande maaltijd"></div>`;
  document.body.appendChild(sheet);
  const card = sheet.firstElementChild;
  const close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  const done = (msg, undo) => { close(); if (msg) C.toast(msg, undo ? 5000 : 2600, undo || null); after?.(); };
  // aanpassen met behoud van "gegeten": eerst uit Voeding, dan wijzigen, dan opnieuw loggen
  const change = async (fn) => {
    if (eaten) await C.rpc("mp_item_eaten", { p_item_id: it.id, p_eaten: false });
    try { await fn(); } finally { if (eaten) await C.rpc("mp_item_eaten", { p_item_id: it.id, p_eaten: true }); }
  };
  const draw = () => {
    const step = n(r?.portion_step) || 0.25;
    const k = (n(r?.kcal) || 0) * q, p = (n(r?.protein) || 0) * q;
    card.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0;flex:1;min-width:0">${C.esc(r?.name || "Maaltijd")}</h3>
        <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
      <p class="small muted" style="margin:4px 0 12px">${C.esc(SLOTS[it.slot] || it.slot)} · ${C.esc(C.shortDate ? C.shortDate(it.day) : it.day)} · ${eaten ? "gegeten" : "gepland"}</p>
      <div class="pi-row"><span><b class="num" style="font-size:26px">${C.fmt(k)}</b> kcal<br><span class="small muted">${C.fmt(p)} g eiwit</span></span>
        <span class="mp-step" aria-label="Porties"><button data-q="-" aria-label="Minder">−</button><b>${C.fmt(q, 2)}</b><button data-q="+" aria-label="Meer">+</button><span class="small muted">${q === 1 ? "portie" : "porties"}</span></span></div>
      <div class="pi-acts">
        <button class="btn ${eaten ? "secondary" : ""}" id="piEat">${eaten ? "✓ Gegeten · ongedaan maken" : "✓ Gegeten"}</button>
        <button class="btn secondary" id="piSwap">⇄ Ander gerecht</button>
        <button class="btn ghost" id="piRec">Recept bekijken</button>
        <button class="btn danger" id="piDel">Uit mijn planning halen</button>
      </div>
      <div id="piSwapList" hidden></div>`;
    card.querySelector("[data-close]").onclick = close;
    card.querySelectorAll("[data-q]").forEach((b) => (b.onclick = async () => {
      const nv = Math.max(step, Math.min(6, Math.round((q + (b.dataset.q === "+" ? step : -step)) / step) * step));
      if (nv === q) return;
      try { await change(() => C.rpc("mp_item_set", { p_item_id: it.id, p_recipe_id: r.id, p_portions: nv })); q = nv; draw(); after?.(); }
      catch (e) { C.toast(e.message, 5000); }
    }));
    card.querySelector("#piEat").onclick = async () => {
      try { await C.rpc("mp_item_eaten", { p_item_id: it.id, p_eaten: !eaten }); done(!eaten ? `${r.name} gelogd in Voeding` : `${r.name} uit Voeding gehaald`); }
      catch (e) { C.toast(e.message, 5000); }
    };
    card.querySelector("#piRec").onclick = () => { close(); location.hash = "#/menu/week"; };
    card.querySelector("#piDel").onclick = async () => {
      try {
        if (eaten) await C.rpc("mp_item_eaten", { p_item_id: it.id, p_eaten: false });
        await C.rpc("mp_item_remove", { p_item_id: it.id });
        done(`${r?.name || "Maaltijd"} uit je planning gehaald`, { label: "Ongedaan maken", run: async () => {
          await C.rpc("mp_item_add", { p_week_id: it.week_id, p_day: it.day, p_slot: it.slot, p_recipe_id: it.recipe_id, p_portions: q }); after?.(); } });
      } catch (e) { C.toast(e.message, 5000); }
    };
    card.querySelector("#piSwap").onclick = () => {
      const box = card.querySelector("#piSwapList"); box.hidden = !box.hidden; if (box.hidden) return;
      const same = (M.recipes || []).filter((x) => x.id !== r?.id && x.meal_type === (r?.meal_type || it.slot) && x.status === "klaar" && !x.disliked && n(x.kcal) != null)
        .sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name));
      box.innerHTML = same.length ? `<div class="rx-list" style="margin-top:10px">${same.map((x) => `<button class="rx-li" data-sw="${x.id}"><span>${x.favorite ? "★" : "•"}</span>${C.esc(x.name)}<small style="margin-left:auto" class="muted">${C.fmt(n(x.kcal) * q)} kcal</small></button>`).join("")}</div>`
        : `<p class="small muted">Geen andere recepten voor deze maaltijd.</p>`;
      box.querySelectorAll("[data-sw]").forEach((b) => (b.onclick = async () => {
        const nr = rec(Number(b.dataset.sw)), stp = n(nr.portion_step) || 0.25, nq = Math.max(stp, Math.round(q / stp) * stp);
        try { await change(() => C.rpc("mp_item_set", { p_item_id: it.id, p_recipe_id: nr.id, p_portions: nq })); r = nr; q = nq; C.toast(`Gewisseld voor ${nr.name}`); draw(); after?.(); }
        catch (e) { C.toast(e.message, 5000); }
      }));
    };
  };
  draw();
}
