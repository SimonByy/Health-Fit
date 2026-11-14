// Weekrapport (gratis): deze week tegenover vorige week, met doelgewicht en verwachte datum.
let C;
const monday = (iso) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const n = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));

// Gewichtstrend: lineaire regressie over de laatste 6 weken (minstens 3 wegingen over 10+ dagen)
export function weightTrend(series, goalKg) {
  const pts = (series || []).map((p) => ({ t: Date.parse(p.day + "T12:00:00Z") / 864e5, kg: Number(p.kg) })).filter((p) => p.kg > 0);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  const win = pts.filter((p) => p.t >= last.t - 42);
  let perWeek = null;
  if (win.length >= 3 && last.t - win[0].t >= 10) {
    const mt = win.reduce((a, p) => a + p.t, 0) / win.length, mk = win.reduce((a, p) => a + p.kg, 0) / win.length;
    const slope = win.reduce((a, p) => a + (p.t - mt) * (p.kg - mk), 0) / win.reduce((a, p) => a + (p.t - mt) ** 2, 0);
    perWeek = slope * 7;
  }
  const out = { last: last.kg, lastDay: new Date(last.t * 864e5).toISOString().slice(0, 10), perWeek, n: win.length };
  const goal = n(goalKg);
  if (goal && perWeek != null) {
    const diff = goal - last.kg;
    if (Math.abs(diff) < 0.3) out.reached = true;
    else if (Math.sign(diff) === Math.sign(perWeek) && Math.abs(perWeek) >= 0.05) {
      const weeks = diff / perWeek;
      if (weeks < 156) out.eta = new Date((last.t + weeks * 7) * 864e5).toISOString().slice(0, 10);
    } else out.wrongWay = true;
  }
  return out;
}

export async function renderWeek(ctx, param) {
  C = ctx;
  // standaard deze week; op maandag de week die net voorbij is
  const thisMon = monday(C.today());
  const start = /^\d{4}-\d{2}-\d{2}$/.test(param || "") ? monday(param) : C.today() === thisMon ? C.addDays(thisMon, -7) : thisMon;
  C.view.innerHTML = `<section class="panel"><p class="muted">Weekrapport laden…</p></section>`;
  const [r, ws] = await Promise.all([C.rpc("get_week_report", { p_from: start }), C.rpc("get_weight_series", { p_days: 120 }).catch(() => [])]);
  const a = r.nu || {}, b = r.vorige || {}, g = r.doelen || {};
  const range = new Intl.DateTimeFormat("nl-BE", { day: "numeric", month: "short", timeZone: "UTC" }).formatRange(new Date(start + "T12:00:00Z"), new Date(C.addDays(start, 6) + "T12:00:00Z"));

  // rij: label, waarde, vorige, eenheid, decimals, doel, richting (+1 = meer is beter, -1 = minder, 0 = neutraal)
  const row = (label, v, pv, unit = "", dec = 0, goal = null, dir = 1) => {
    v = n(v); pv = n(pv);
    if (v == null && pv == null) return "";
    const d = v != null && pv != null ? v - pv : null;
    const cls = d == null || Math.abs(d) < (dec ? 0.05 : 0.5) || !dir ? "" : (d > 0) === (dir > 0) ? "up" : "down";
    const goalTxt = goal != null && v != null ? `<small class="${(dir > 0 ? v >= goal * 0.95 : v <= goal * 1.05) ? "ok" : "muted"}"> doel ${C.fmt(goal, dec)}${unit}</small>` : "";
    return `<div class="wr-row"><span class="wr-l">${label}</span>
      <span class="wr-v"><b>${v == null ? "–" : C.fmt(v, dec) + unit}</b>${goalTxt}</span>
      <span class="wr-d ${cls}">${d == null ? "" : (d > 0 ? "+" : d < 0 ? "−" : "±") + C.fmt(Math.abs(d), dec) + unit}</span></div>`;
  };
  const wt = weightTrend(ws, g.weight_kg);
  const wkTxt = (w) => `${w > 0 ? "+" : "−"}${C.fmt(Math.abs(w), 2)} kg per week`;
  const weightHtml = wt ? `<section class="panel">
      <h3 style="margin:0 0 6px">Gewicht</h3>
      <p style="margin:0">Laatst gewogen <b>${C.fmt(wt.last, 1)} kg</b> <span class="muted small">(${C.esc(C.shortDate(wt.lastDay))})</span>${wt.perWeek != null ? ` · trend <b>${wkTxt(wt.perWeek)}</b>` : ""}</p>
      ${g.weight_kg ? `<p class="small" style="margin:6px 0 0">Doel ${C.fmt(g.weight_kg, 1)} kg: ${wt.reached ? "<b>bereikt</b>." : wt.eta ? `in dit tempo rond <b>${C.esc(new Date(wt.eta + "T12:00:00Z").toLocaleDateString("nl-BE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }))}</b>.` : wt.wrongWay ? "de trend gaat de andere kant op." : "nog te weinig wegingen voor een schatting (minstens 3 over 10 dagen)."}</p>`
        : `<p class="small muted" style="margin:6px 0 0">Stel een doelgewicht in bij Instellingen → Doelen voor een verwachte datum.</p>`}
      ${wt.perWeek != null && Math.abs(wt.perWeek) > Math.max(1, wt.last * 0.01) ? `<p class="small warn" style="margin:6px 0 0">Meer dan 1% van je gewicht per week is snel; kijk of je genoeg eet en eiwit haalt.</p>` : ""}
    </section>` : "";

  C.view.innerHTML = `
    <section class="panel pl-head">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap">
        <button class="wnav" data-w="-7" aria-label="Vorige week">‹</button>
        <div style="text-align:center"><h2 style="margin:0">Je week</h2><span class="small muted">${C.esc(range)}</span></div>
        <button class="wnav" data-w="7" aria-label="Volgende week" ${start >= thisMon ? "disabled" : ""}>›</button>
      </div>
      <p class="small muted" style="margin:8px 0 0;text-align:center">Rechts: verschil met de week ervoor.</p>
    </section>
    <section class="panel"><h3 style="margin:0 0 6px">Training</h3>
      ${n(a.gepland) ? row("Plan afgewerkt", a.gedaan, b.gepland ? b.gedaan : null, ` / ${a.gepland}`, 0, null, 1) : ""}
      ${row("Krachttrainingen", a.kracht, b.kracht)}
      ${row("Werksets", a.sets, b.sets)}
      ${row("Volume", n(a.volume_kg) != null ? a.volume_kg / 1000 : null, n(b.volume_kg) != null ? b.volume_kg / 1000 : null, " t", 1)}
      ${row("Cardiosessies", a.cardio, b.cardio)}
      ${row("Cardio", a.cardio_min, b.cardio_min, " min")}
      ${row("Afstand", a.cardio_km, b.cardio_km, " km", 1)}
    </section>
    <section class="panel"><h3 style="margin:0 0 6px">Herstel en dag</h3>
      ${row("Slaap per nacht", a.slaap_h, b.slaap_h, " u", 1, n(g.sleep_h))}
      ${row("Stappen per dag", a.stappen, b.stappen, "", 0, n(g.steps))}
      ${a.gewoontes != null ? row("Gewoontes afgevinkt", a.gewoontes, b.gewoontes, "%") : ""}
    </section>
    <section class="panel"><h3 style="margin:0 0 6px">Voeding</h3>
      ${n(a.dagen_gelogd) ? `${row("Calorieën per dag", a.kcal, b.kcal, "", 0, null, 0)}${g.kcal_in && a.kcal ? `<p class="small muted" style="margin:0 0 6px">Doel ${C.fmt(g.kcal_in)} kcal; ${Math.abs(a.kcal - g.kcal_in) <= 150 ? "mooi op koers" : a.kcal < g.kcal_in ? `${C.fmt(g.kcal_in - a.kcal)} kcal onder je doel` : `${C.fmt(a.kcal - g.kcal_in)} kcal boven je doel`}.</p>` : ""}
        ${row("Eiwit per dag", a.eiwit, b.eiwit, " g", 0, n(g.protein_g))}
        <p class="small muted" style="margin:0">Gemiddelde over ${a.dagen_gelogd} gelogde ${a.dagen_gelogd === 1 ? "dag" : "dagen"}.</p>`
        : `<p class="small muted" style="margin:0">Deze week niets gelogd.</p>`}
    </section>
    ${weightHtml}`;
  C.view.querySelectorAll(".wnav").forEach((btn) => (btn.onclick = () => { if (!btn.disabled) location.hash = `#/week/${C.addDays(start, Number(btn.dataset.w))}`; }));
}
