// "Stel voeding voor": kijkt hoeveel je vandaag nog kan eten (doel − gegeten − wat later nog
// gepland staat) en kiest daar een gerecht bij uit je menu, je recepten en wat je vaak eet.
// Rekent alles lokaal; geen AI-oproep nodig.

const ORDER = ["Ontbijt", "Lunch", "Snack", "Avondeten", "Laat"];
const SLOT = { Ontbijt: "ontbijt", Lunch: "lunch", Snack: "snack", Avondeten: "avond", Laat: "avondsnack" };
// Reserve voor een latere maaltijd waarvoor nog niets gepland of gelogd is
const DEFAULT_RESERVE = { Snack: { kcal: 200, p: 20, f: 4 }, Avondeten: { kcal: 550, p: 50, f: 12 }, Laat: { kcal: 180, p: 20, f: 4 } };
const TYPES = { Lunch: ["lunch", "avond"], Avondeten: ["avond", "lunch"] };
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? 0 : Number(v));

/** Budget voor deze maaltijd. eaten = {kcal,p,f} van vandaag; plan = menu-items van vandaag (met r); logged = food_log van vandaag. */
export function mealBudget({ meal, goals, eaten, plan = [], logged = [] }) {
  const G = { kcal: num(goals.kcal_in) || 2000, p: num(goals.protein_g) || 150, f: num(goals.fat_g) || 55 };
  const later = ORDER.slice(ORDER.indexOf(meal) + 1);
  const reserve = { kcal: 0, p: 0, f: 0 }, parts = [];
  for (const m of later) {
    const open = plan.filter((i) => i.slot === SLOT[m] && !i.eaten);
    if (open.length) {
      for (const i of open) {
        const q = num(i.portions) || 1;
        reserve.kcal += num(i.r.kcal) * q; reserve.p += num(i.r.protein) * q; reserve.f += num(i.r.fat) * q;
        parts.push(i.r.name);
      }
    } else if (!logged.some((l) => l.meal === m && !l.skipped) && !plan.some((i) => i.slot === SLOT[m]) && DEFAULT_RESERVE[m]) {
      const d = DEFAULT_RESERVE[m];
      reserve.kcal += d.kcal; reserve.p += d.p; reserve.f += d.f;
      parts.push((m === "Laat" ? "avondsnack" : m.toLowerCase()) + " (± " + d.kcal + " kcal)");
    }
  }
  return {
    goals: G, reserve, reserveParts: parts,
    kcal: G.kcal - num(eaten.kcal) - reserve.kcal,
    p: Math.max(0, G.p - num(eaten.p) - reserve.p),
    f: G.f - num(eaten.f) - reserve.f,
    left: { kcal: G.kcal - num(eaten.kcal), p: G.p - num(eaten.p), f: G.f - num(eaten.f) },
  };
}

function portionsFor(step) {
  step = num(step) || 0.25;
  if (step >= 1) return [1, 2];
  const out = [];
  for (let q = Math.ceil(0.75 / step - 1e-9) * step; q <= 2 + 1e-9; q += step) out.push(Math.round(q * 100) / 100);
  return out;
}

function score(c, B) {
  const target = Math.max(B.kcal, 150);
  let s = Math.abs(c.kcal - target) / target;
  if (c.kcal > target) s += 0.5 * (c.kcal - target) / target;            // te veel is erger dan iets minder
  const need = Math.max(B.p, 20);
  if (c.p < B.p) s += 1.5 * (B.p - c.p) / need;                          // eiwit halen telt zwaar
  if (B.f >= 0 && c.f > B.f) s += 0.05 * (c.f - B.f);                    // vet boven wat er nog past
  if (B.f < 0) s += 0.03 * c.f;
  return s - (c.bonus || 0);
}

/** Geeft de beste voorstellen terug: [{key, src, name, q, kcal, p, c, f, x}] */
export function suggestMeal({ meal, budget: B, plan = [], recipes = [], frequent = [], max = 4 }) {
  const cands = [];
  const planned = plan.filter((i) => i.slot === SLOT[meal] && !i.eaten);
  for (const i of planned) {
    const q = num(i.portions) || 1;
    cands.push({ src: "menu", name: i.r.name, q, kcal: num(i.r.kcal) * q, p: num(i.r.protein) * q, c: num(i.r.carbs) * q, f: num(i.r.fat) * q, x: i, bonus: 0.15 });
  }
  const types = TYPES[meal] || [SLOT[meal]];
  for (const r of recipes) {
    if (r.status !== "klaar" || r.disliked || r.hidden || r.kcal == null || !types.includes(r.meal_type)) continue;
    let best = null;
    for (const q of portionsFor(r.portion_step)) {
      const c = { src: "recept", name: r.name, q, kcal: num(r.kcal) * q, p: num(r.protein) * q, c: num(r.carbs) * q, f: num(r.fat) * q, x: r,
        bonus: (r.favorite ? 0.05 : 0) - (r.meal_type === types[0] ? 0 : 0.25) };
      c.s = score(c, B);
      if (!best || c.s < best.s) best = c;
    }
    if (best) cands.push(best);
  }
  for (const f of frequent) {
    if (num(f.kcal) <= 0) continue;
    cands.push({ src: "vaak", name: f.name, q: 1, kcal: num(f.kcal), p: num(f.protein), c: num(f.carbs), f: num(f.fat), x: f, bonus: Math.min(0.1, num(f.n) * 0.01) });
  }
  cands.forEach((c) => { if (c.s == null) c.s = score(c, B); });
  cands.sort((a, b) => a.s - b.s);
  const seen = new Set(), out = [];
  for (const c of cands) {
    const k = c.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim();
    if (seen.has(k)) continue;
    seen.add(k); out.push({ ...c, key: out.length });
    if (out.length >= max) break;
  }
  return out;
}

/** Bottom sheet met de voorstellen; loggen in één tik. */
export function openSuggest(C, { day, meal, label, goals, eaten, plan, logged, recipes, frequent, pkv, after }) {
  const B = mealBudget({ meal, goals, eaten, plan, logged });
  const list = suggestMeal({ meal, budget: B, plan, recipes, frequent });
  const sh = document.createElement("div"); sh.className = "sheet"; document.body.appendChild(sh);
  const close = () => sh.remove();
  sh.addEventListener("click", (e) => { if (e.target === sh) close(); });
  const qTxt = (q) => (q === 1 ? "" : ` · ${C.fmt(q, 2)} ${q === 1 ? "portie" : "porties"}`);
  const src = { menu: "Uit je menu", recept: "Recept", vaak: "Eet je vaak" };
  const intro = B.left.kcal <= 0
    ? `Je zit vandaag al aan <b>${C.fmt(B.goals.kcal)} kcal</b>. Hieronder wat het minst extra kost en toch eiwit geeft.`
    : `Je hebt vandaag nog <b>${C.fmt(Math.max(0, B.left.kcal))} kcal</b> en <b>${C.fmt(Math.max(0, B.left.p))} g eiwit</b> te gaan.`
      + (B.reserveParts.length ? ` Na wat nog komt (${C.esc(B.reserveParts.join(", "))}) blijft er voor je ${label.toLowerCase()} ± <b>${C.fmt(Math.max(0, B.kcal))} kcal</b> en minstens <b>${C.fmt(B.p)} g eiwit</b> over.` : ` Dat is wat er voor je ${label.toLowerCase()} overblijft.`);
  sh.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Voorstel voor ${C.esc(label)}">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Voorstel voor je ${C.esc(label.toLowerCase())}</h3><button class="icon-btn" data-x aria-label="Sluiten">✕</button></div>
    <p class="small" style="margin:8px 0 4px">${intro}</p>
    ${list.length ? `<div class="sgl">${list.map((s) => {
      const restK = B.left.kcal - s.kcal, restP = B.left.p - s.p;
      return `<div class="sgl-i">
        <div class="sgl-t"><b>${C.esc(s.name)}</b><small>${src[s.src]}${qTxt(s.q)} · ${pkv(s.p, s.c, s.f)}</small>
          <small class="muted">Daarna nog ${restK >= 0 ? `${C.fmt(restK)} kcal` : `${C.fmt(-restK)} kcal te veel`} en ${restP > 0 ? `${C.fmt(restP)} g eiwit te gaan` : "je eiwitdoel gehaald"}</small></div>
        <div class="sgl-r"><span class="sgl-k">${C.fmt(s.kcal)}<small>kcal</small></span><button class="btn small" data-log="${s.key}">Loggen</button></div>
      </div>`; }).join("")}</div>`
      : `<p class="mempty">Ik vond geen recepten met voedingswaarden voor deze maaltijd. Voeg er een toe bij Menu → Recepten.</p>`}
  </div>`;
  sh.querySelector("[data-x]").onclick = close;
  sh.querySelectorAll("[data-log]").forEach((b) => (b.onclick = async () => {
    const s = list[Number(b.dataset.log)];
    b.disabled = true;
    try {
      if (s.src === "menu") {
        await C.rpc("mp_item_eaten", { p_item_id: s.x.id, p_eaten: true });
        C.toast(`${s.name} gelogd`, 4000);
      } else {
        const p = s.src === "vaak" && s.x.food_id && s.x.grams
          ? { day, meal, grams: s.x.grams, food: { id: s.x.food_id } }
          : { day, meal, name: s.name + (s.q !== 1 ? ` (${C.fmt(s.q, 2)} porties)` : ""), kcal: Math.round(s.kcal), protein: +s.p.toFixed(1), carbs: +s.c.toFixed(1), fat: +s.f.toFixed(1) };
        const r = await C.rpc("log_food", { p });
        C.toast(`${s.name} gelogd`, 5000, { label: "Ongedaan maken", run: async () => { await C.rpc("void_food_many", { p_ids: [r.id] }); after?.(); } });
      }
      close(); after?.();
    } catch (e) { b.disabled = false; C.toast(e.message, 5000); }
  }));
}
