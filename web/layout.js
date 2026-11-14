// Eigen indeling per tab: blokken tonen/verbergen en verplaatsen.
// Een blok is een kind van de blokkencontainer van de pagina; de sleutel komt uit data-block, het id of de titel.
let C, cache = null;
const LS = "hh-layout";

const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
function titleOf(el) {
  if (el.dataset.blockTitle) return el.dataset.blockTitle;
  const h = el.querySelector("h2, h3, summary, b");
  return (h?.textContent || "").replace(/[▶›]/g, "").trim().slice(0, 50);
}
const ID_TITLES = { todayReady: "Readiness en Body Battery", todayFuel: "Calorieën en macro's", coachToday: "Plan van de coach (vandaag)", todayTimeline: "Tijdlijn", coachWeek: "Plan van je coach" };

function containerOf(view) {
  let c = view.querySelector("[data-blocks], .board") || view;
  for (let i = 0; i < 2 && c.children.length <= 2; i++) {
    const big = [...c.children].sort((a, b) => b.children.length - a.children.length)[0];
    if (!big || big.children.length < 3) break;
    c = big;
  }
  return c;
}
function blocksIn(container) {
  const seen = {};
  return [...container.children].filter((el) => !el.matches(".daynav, .fab, .skeleton, .layout-edit, script, style")).map((el) => {
    let key = el.dataset.block || el.id || slug(titleOf(el));
    if (!key) return null;
    if (seen[key]) key += "-" + ++seen[key]; else seen[key] = 1;
    el.dataset.blockKey = key;
    return { el, key, title: ID_TITLES[el.id] || titleOf(el) || key };
  }).filter(Boolean);
}

async function load() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(LS) || "null"); } catch { cache = null; }
  cache ||= {};
  C.rpc("get_setting", { p_key: "layout" }).then((v) => {
    if (v && JSON.stringify(v) !== JSON.stringify(cache)) { cache = v; try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* */ } }
  }).catch(() => {});
  return cache;
}
async function save() {
  try { localStorage.setItem(LS, JSON.stringify(cache)); } catch { /* */ }
  await C.rpc("set_setting", { p_key: "layout", p_value: cache }).catch(() => {});
}

export async function applyLayout(ctx, tab, view) {
  C = ctx;
  const L = (await load())[tab];
  const container = containerOf(view);
  const blocks = blocksIn(container);
  if (blocks.length < 2) return;
  if (L) {
    const pos = (k) => { const i = (L.order || []).indexOf(k); return i < 0 ? 1e3 : i; };
    const sorted = blocks.map((b, i) => ({ ...b, i })).sort((a, b) => pos(a.key) - pos(b.key) || a.i - b.i);
    const anchor = sorted[0].el.previousElementSibling;
    let ref = anchor;
    for (const b of sorted) { if (ref) ref.after(b.el); else container.prepend(b.el); ref = b.el; }
    for (const b of blocks) b.el.hidden = (L.hidden || []).includes(b.key);
  }
  if (!view.querySelector(".layout-edit")) {
    const btn = document.createElement("button");
    btn.className = "layout-edit"; btn.type = "button"; btn.textContent = "Pagina aanpassen";
    btn.onclick = () => openEditor(tab, view);
    view.appendChild(btn);
  }
}

function openEditor(tab, view) {
  const container = containerOf(view);
  const blocks = blocksIn(container);
  const L = (cache[tab] ||= { order: [], hidden: [] });
  let order = blocks.map((b) => b.key);
  const hidden = new Set(L.hidden || []);
  const s = document.createElement("div");
  s.className = "sheet";
  const byKey = Object.fromEntries(blocks.map((b) => [b.key, b]));
  const draw = () => {
    s.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Pagina aanpassen">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Pagina aanpassen</h3>
        <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
      <p class="small muted" style="margin:6px 0 10px">Zet blokken aan of uit en verplaats ze met de pijltjes.</p>
      <ol class="lay-list">${order.map((k, i) => `<li data-k="${k}" class="${hidden.has(k) ? "off" : ""}">
        <label class="switch"><input type="checkbox" ${hidden.has(k) ? "" : "checked"} aria-label="${C.esc(byKey[k].title)} tonen"><span></span></label>
        <span class="lay-t">${C.esc(byKey[k].title)}</span>
        <button class="icon-btn" data-up ${i === 0 ? "disabled" : ""} aria-label="Omhoog">↑</button>
        <button class="icon-btn" data-down ${i === order.length - 1 ? "disabled" : ""} aria-label="Omlaag">↓</button></li>`).join("")}</ol>
      <div class="row" style="margin-top:12px"><button class="btn" data-save>Opslaan</button><button class="btn ghost" data-reset>Standaard</button></div>
    </div>`;
  };
  draw();
  document.body.appendChild(s);
  s.addEventListener("click", async (e) => {
    if (e.target === s || e.target.closest("[data-close]")) return s.remove();
    const li = e.target.closest("li"); const k = li?.dataset.k; const i = order.indexOf(k);
    if (e.target.closest("[data-up]") && i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); }
    else if (e.target.closest("[data-down]") && i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); }
    else if (e.target.closest("[data-reset]")) { delete cache[tab]; await save(); s.remove(); C.refresh(); }
    else if (e.target.closest("[data-save]")) { cache[tab] = { order, hidden: [...hidden] }; await save(); s.remove(); C.toast("Indeling opgeslagen"); C.refresh(); }
  });
  s.addEventListener("change", (e) => {
    const li = e.target.closest("li"); if (!li) return;
    if (e.target.checked) hidden.delete(li.dataset.k); else hidden.add(li.dataset.k);
    li.classList.toggle("off", !e.target.checked);
  });
}
