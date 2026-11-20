// Belasting (strain, zoals Bevel/Whoop) en "Wat beïnvloedt je herstel".
// Strain per dag = TRIMP (Banister) uit duur × hartslagreserve van elke training, met jouw max- en rusthartslag
// (Instellingen → Profiel), plus een schatting voor krachtsets en stappen. 0–100% via 100 × (1 − e^(−TRIMP/110)).
// Doel voor vandaag volgt je readiness. Acute:chronische belasting = gemiddelde van 7 dagen t.o.v. 28 dagen.
let C;
const n = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const STRENGTH_RE = /kracht|strength|gym|weight|fitness|push|pull|legs|upper|lower/i;

function trimpOf(day, hr) {
  const k = hr.sex === "v" ? [0.86, 1.67] : [0.64, 1.92];
  let t = 0, strengthHr = false;
  const parts = [];
  for (const w of day.workouts || []) {
    const min = n(w.min) || 0; if (!min) continue;
    const avg = n(w.avg_hr);
    const r = avg ? Math.max(0, Math.min(1, (avg - hr.rest) / Math.max(1, hr.max - hr.rest))) : 0.5;
    const v = min * r * k[0] * Math.exp(k[1] * r);
    if (STRENGTH_RE.test(w.name || "")) strengthHr = true;
    t += v; parts.push({ label: w.name || "Training", v, detail: `${Math.round(min)} min${avg ? ` · gem. ${avg} bpm` : ""}` });
  }
  const sets = n(day.strength_sets) || 0;
  if (sets && !strengthHr) { const v = sets * 2.5; t += v; parts.push({ label: "Krachttraining", v, detail: `${sets} werksets` }); }
  const steps = n(day.steps) || 0;
  if (steps > 4000) { const v = ((steps - 4000) / 1000) * 1.5; t += v; parts.push({ label: "Stappen", v, detail: `${steps.toLocaleString("nl-BE")} stappen` }); }
  return { trimp: t, parts };
}
const pct = (trimp) => Math.round(100 * (1 - Math.exp(-trimp / 110)));
function targetFor(score) {
  if (score == null) return null;
  return score >= 75 ? [55, 80, "Je bent goed hersteld: een stevige dag mag."] : score >= 50 ? [35, 60, "Gemiddeld hersteld: een normale training is prima."]
    : [15, 35, "Je herstel is laag: hou het vandaag rustig (wandelen, zone 1–2, mobiliteit)."];
}
function acwr(days, hr) {
  const t = days.map((d) => trimpOf(d, hr).trimp);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const acute = avg(t.slice(-7)), chronic = avg(t.slice(-28));
  if (t.length < 21 || chronic < 5) return null;
  const r = acute / chronic;
  return { r, acute, chronic, label: r < 0.8 ? ["low", "Minder dan je gewoon bent"] : r <= 1.3 ? ["ok", "Goede opbouw"] : r <= 1.5 ? ["mid", "Stevig opgebouwd: let op je herstel"] : ["bad", "Veel meer dan gewoonlijk: hoger blessurerisico"] };
}

export async function renderStrain(ctx, el, day) {
  C = ctx;
  const [P, load, ready] = await Promise.all([import("./profile.js"), C.rpc("get_load", { p_days: 42 }).catch(() => []), C.rpc("get_readiness", { p_day: day || C.today() }).catch(() => null)]);
  const hr = await P.getZones(C).catch(() => ({ max: 190, rest: 60 }));
  hr.sex = (await P.getProfile(C).catch(() => ({ p: {} }))).p.sex;
  if (!load?.length) { el.innerHTML = ""; return; }
  const today = load.find((d) => d.day === (day || C.today())) || load[load.length - 1];
  const { trimp, parts } = trimpOf(today, hr);
  const s = pct(trimp);
  const tgt = targetFor(n(ready?.score_now) ?? n(ready?.score));
  const ac = acwr(load, hr);
  const week = load.slice(-7).map((d) => ({ d: d.day, s: pct(trimpOf(d, hr).trimp) }));
  const R = 30, L = 2 * Math.PI * R;
  el.innerHTML = `<section class="panel strain">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Belasting</h3><button class="btn ghost small" id="stInfo">Hoe werkt dit?</button></div>
    <div class="st-main">
      <svg viewBox="0 0 72 72" class="st-ring" role="img" aria-label="Belasting ${s}%${tgt ? `, doel ${tgt[0]} tot ${tgt[1]}%` : ""}">
        <circle cx="36" cy="36" r="${R}" class="st-track"/>
        ${tgt ? `<circle cx="36" cy="36" r="${R}" class="st-target" stroke-dasharray="${(L * (tgt[1] - tgt[0])) / 100} ${L}" stroke-dashoffset="${-L * tgt[0] / 100}" transform="rotate(-90 36 36)"/>` : ""}
        <circle cx="36" cy="36" r="${R - 6}" class="st-fill" stroke-dasharray="${2 * Math.PI * (R - 6)}" stroke-dashoffset="${2 * Math.PI * (R - 6) * (1 - s / 100)}" transform="rotate(-90 36 36)"/>
        <text x="36" y="40" text-anchor="middle">${s}%</text></svg>
      <div class="st-txt">${tgt ? `<b>Doel vandaag ${tgt[0]}–${tgt[1]}%</b><span>${s < tgt[0] ? `Nog ${tgt[0] - s}% tot je doel.` : s > tgt[1] ? "Boven je doel: plan rust in." : "Binnen je doel. ✓"} ${C.esc(tgt[2])}</span>` : `<b>${s < 30 ? "Lichte dag" : s < 60 ? "Gemiddelde dag" : "Zware dag"}</b><span>Geen readiness vandaag, dus geen doel.</span>`}</div>
    </div>
    <div class="st-week" aria-label="Belasting laatste 7 dagen">${week.map((w) => `<span><i style="height:${Math.max(4, w.s)}%"></i><small>${["zo", "ma", "di", "wo", "do", "vr", "za"][new Date(w.d + "T12:00:00Z").getUTCDay()]}</small></span>`).join("")}</div>
    ${ac ? `<p class="st-ac ${ac.label[0]}"><b>${C.fmt(ac.r, 2)}</b> belasting 7 dagen t.o.v. 28 dagen · ${C.esc(ac.label[1])}</p>` : ""}
    <a class="small" href="#/trends" style="display:inline-block;margin-top:6px">Wat beïnvloedt je herstel? ›</a>
  </section>`;
  el.querySelector("#stInfo").onclick = () => {
    const sh = document.createElement("div"); sh.className = "sheet";
    sh.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Belasting"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Belasting vandaag · ${s}%</h3><button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
      ${parts.length ? `<table class="nutrients" style="margin-top:10px">${parts.sort((a, b) => b.v - a.v).map((x) => `<tr><td>${C.esc(x.label)}<br><span class="small muted">${C.esc(x.detail)}</span></td><td style="text-align:right">${Math.round(x.v)}</td></tr>`).join("")}
        <tr><td><b>Totaal (TRIMP)</b></td><td style="text-align:right"><b>${Math.round(trimp)}</b></td></tr></table>` : `<p class="muted">Nog geen training of beweging vandaag.</p>`}
      <p class="small muted">Elke training telt mee volgens duur × hoe hoog je hartslag zat tussen je rust- (${hr.rest}) en maxhartslag (${hr.max}); hoger in je zones weegt veel zwaarder. Krachtsets zonder hartslag tellen elk ±2,5, stappen boven 4.000 elk duizendtal 1,5. Pas je hartslag aan in Instellingen → Profiel en hartslagzones.</p>
      <p class="small muted">Het doel volgt je readiness. De verhouding 7 tegen 28 dagen (acute:chronische belasting) tussen 0,8 en 1,3 is een veilige opbouw; boven 1,5 stijgt het blessurerisico.</p></div>`;
    document.body.appendChild(sh);
    sh.addEventListener("click", (e) => { if (e.target === sh || e.target.closest("[data-close]")) sh.remove(); });
  };
}

export async function renderImpacts(ctx, el) {
  C = ctx;
  const rows = await C.rpc("get_impacts", { p_days: 90 }).catch(() => null);
  if (!rows) { el.innerHTML = ""; return; }
  const fmt = (v, unit, dec, goodUp) => {
    if (v == null) return "<span class='muted'>–</span>";
    const good = goodUp ? v > 0 : v < 0, small = Math.abs(v) < (unit === "u" ? 0.15 : unit === "ms" ? 2 : 1);
    return `<span class="im-v ${small ? "neutral" : good ? "good" : "bad"}">${v > 0 ? "+" : ""}${unit === "u" ? `${C.fmt(v * 60)} min` : `${C.fmt(v, dec)} ${unit}`}</span>`;
  };
  el.innerHTML = `<section class="panel impacts">
    <h3 style="margin:0 0 4px">Wat beïnvloedt je herstel?</h3>
    <p class="small muted" style="margin:0 0 10px">De nacht na een dag mét tegenover zonder, over de laatste 90 dagen. Groen = beter voor je herstel.</p>
    ${rows.length ? `<div class="im-head small muted"><span></span><span>HRV</span><span>Rust-HR</span><span>Slaap</span></div>
      ${rows.map((r) => `<div class="im-row"><span><b>${C.esc(r.label)}</b><small>${r.n_yes} dagen met · ${r.n_no} zonder</small></span>
        ${fmt(n(r.hrv), "ms", 1, true)}${fmt(n(r.rhr), "bpm", 1, false)}${fmt(n(r.sleep), "u", 2, true)}</div>`).join("")}`
      : `<p class="small">Nog te weinig data. Vink een paar weken je gewoontes af (Vandaag) en schrijf in je dagboek, dan zie je hier wat helpt en wat niet.</p>`}
    <p class="small muted" style="margin:10px 0 0">Samenhang, geen bewijs: een drukke dag met veel stappen kan ook om andere redenen slechter slapen geven. Voeg gewoontes toe die je wil testen (bv. "Magnesium", "Schermvrij na 22u") in Instellingen → Gewoontes; alcohol herkent de app uit je dagboek.</p>
  </section>`;
}
