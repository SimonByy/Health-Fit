// Training: plan van de coach, progressie per oefening (uit Hevy), volume per week.
// Loggen gebeurt in Hevy; deze pagina toont alleen wat eruit komt.
let C;
const n = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const clean = (s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim();

// Huidige geschatte 1RM tegenover ~4 weken eerder
function trend(series) {
  const pts = (series || []).filter((p) => n(p.rm) != null);
  if (!pts.length) return null;
  const last = pts.at(-1);
  const cutoff = new Date(last.day + "T12:00:00Z"); cutoff.setUTCDate(cutoff.getUTCDate() - 28);
  const iso = cutoff.toISOString().slice(0, 10);
  const before = [...pts].reverse().find((p) => p.day <= iso) || pts[0];
  const recentBest = Math.max(...pts.filter((p) => p.day > iso).map((p) => p.rm), last.rm);
  const pct = before === last ? 0 : ((recentBest - before.rm) / before.rm) * 100;
  return { last, before, best: recentBest, pct };
}

function spark(series, w = 120, h = 34) {
  const pts = (series || []).filter((p) => n(p.rm) != null);
  if (pts.length < 2) return "";
  const ys = pts.map((p) => p.rm), lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * (w - 4) + 2, h - 3 - ((p.rm - lo) / span) * (h - 6)]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = xy.at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/><circle cx="${lx}" cy="${ly}" r="2.6"/></svg>`;
}

export async function renderStrength(ctx) {
  C = ctx;
  C.view.innerHTML = `<div id="coachWeek"></div><div class="skeleton"></div>`;
  import("./coach.js").then((m) => m.renderCoachWeek(ctx, C.view.querySelector("#coachWeek"))).catch(() => {});
  const o = await C.rpc("get_strength_overview", { p_weeks: 12 });
  const lifts = (o.lifts || []).filter((l) => n(l.recent) > 0).map((l) => ({ ...l, t: trend(l.series) })).filter((l) => l.t);
  const up = lifts.filter((l) => l.t.pct >= 1).length, flat = lifts.filter((l) => Math.abs(l.t.pct) < 1).length, down = lifts.filter((l) => l.t.pct <= -1).length;
  const weekly = o.weekly || [];
  const thisWeek = weekly.at(-1), prev = weekly.slice(-5, -1);
  const avgSets = prev.length ? prev.reduce((s, w) => s + n(w.working_sets), 0) / prev.length : null;
  const recent = o.recent || [];
  const lastDays = recent.length ? Math.round((Date.parse(C.today()) - Date.parse(recent[0].day)) / 864e5) : null;

  const box = document.createElement("div");
  box.innerHTML = `
    <section class="sverdict">
      <h2>Progressie, laatste 4 weken</h2>
      ${lifts.length ? `<div class="tally"><span class="up"><b>${up}</b>sterker</span><span><b>${flat}</b>gelijk</span><span class="down"><b>${down}</b>zwakker</span></div>
      <p class="small muted">${lifts.length} oefeningen die je de laatste 4 weken deed, op basis van je geschatte 1RM.${lastDays != null && lastDays > 3 ? ` Laatste Hevy-training is van ${lastDays} dagen geleden: deel je export om bij te werken.` : ""}</p>`
      : `<p class="muted">Nog te weinig trainingen uit Hevy. Deel je Hevy-export naar Health Hub met de opdracht op je iPhone.</p>`}
    </section>
    ${lifts.length ? `<div class="lifts">${lifts.map((l, i) => `<button class="lift ${l.t.pct >= 1 ? "up" : l.t.pct <= -1 ? "down" : ""}" data-i="${i}">
        <span class="lift-n">${C.esc(clean(l.exercise))}</span>
        <span class="lift-v"><b>${C.fmt(l.t.last.kg, 1)}</b> kg × ${C.fmt(l.t.last.reps)}</span>
        ${spark(l.series)}
        <span class="lift-d">${l.t.pct >= 0 ? "+" : "−"}${C.fmt(Math.abs(l.t.pct), 1)}%</span>
      </button>`).join("")}</div>` : ""}

    <h2 class="section-title">Werksets per week</h2>
    <section class="panel">
      ${thisWeek ? `<p class="verdict" style="margin-top:0">Deze week <b>${C.fmt(thisWeek.working_sets)}</b> werksets in ${C.fmt(thisWeek.sessions)} trainingen${avgSets ? `, gemiddeld ${C.fmt(avgSets)} per week de 4 weken ervoor` : ""}.</p>` : ""}
      <div id="wkChart"></div>
    </section>

    <details class="panel" id="mvDet"><summary>Sets per spiergroep</summary><div id="mvBox" style="margin-top:8px"></div></details>

    <h2 class="section-title">Recente trainingen</h2>
    <div class="list">${recent.map((r) => `<div class="item" style="--c:var(--strength)"><span class="swatch"></span>
        <span><div class="t">${C.esc(r.title || "Training")}</div><div class="m">${C.esc(C.shortDate(r.day))} · ${C.fmt(r.duration_min)} min · ${C.fmt(r.working_sets)} sets</div></span>
        <span class="r">${C.fmt(n(r.volume_kg) / 1000, 1)}<small>ton volume</small></span></div>`).join("") || `<p class="muted" style="padding:14px">Nog geen trainingen.</p>`}</div>

    <section class="panel hevy-sync">
      <h3>Hevy bijwerken</h3>
      <p class="hint">In Hevy: Profiel → ⚙ → Export &amp; Import Data → Export workouts, en deel het bestand met de opdracht "Naar Health Hub". Op een computer kan het ook met een bestand.</p>
      <label class="btn ghost" style="cursor:pointer">CSV kiezen<input type="file" id="hevyCsv" accept=".csv,text/csv" hidden></label>
    </section>`;
  C.view.querySelector(".skeleton")?.replaceWith(box);

  if (weekly.length) C.mountChart(box.querySelector("#wkChart"), {
    points: weekly.map((w) => ({ x: w.week_start, y: n(w.working_sets) })), color: "var(--strength)", type: "bar", unit: "sets", height: 140,
  });
  box.querySelector("#hevyCsv").onchange = (e) => C.importHevy(e.target.files?.[0], () => renderStrength(ctx));
  box.querySelector("#mvDet").addEventListener("toggle", (e) => {
    if (e.target.open && !e.target.dataset.loaded) { e.target.dataset.loaded = 1; C.renderMuscles(box.querySelector("#mvBox")); }
  });
  box.querySelectorAll(".lift").forEach((b) => (b.onclick = () => openLift(lifts[Number(b.dataset.i)])));
}

function openLift(l) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const pts = l.series || [];
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${C.esc(clean(l.exercise))}">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${C.esc(clean(l.exercise))}</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <p class="small muted" style="margin:4px 0 10px">Geschatte 1RM per training, laatste 12 weken. Beste recent: <b>${C.fmt(l.t.best, 1)} kg</b>.</p>
    <div class="c"></div>
    <table class="nutrients" style="margin-top:10px">${pts.slice(-8).reverse().map((p) => `<tr><td>${C.esc(C.shortDate(p.day))}</td><td>${C.fmt(p.kg, 1)} kg × ${C.fmt(p.reps)} <span class="muted">· 1RM ${C.fmt(p.rm, 1)}</span></td></tr>`).join("")}</table>
  </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("[data-close]")) close(); });
  C.mountChart(sheet.querySelector(".c"), { points: pts.map((p) => ({ x: p.day, y: p.rm })), color: "var(--strength)", type: "line", unit: "kg", dec: 1, zero: false, height: 170 });
}
