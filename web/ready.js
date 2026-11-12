// Readiness (eigen score, de Venu 3 heeft er geen) en Body Battery bovenaan Vandaag.
let C;
const n = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const tone = (s) => (s == null ? "none" : s >= 75 ? "hi" : s >= 50 ? "mid" : s >= 30 ? "low" : "bad");

function ring(score, label) {
  const R = 30, L = 2 * Math.PI * R, f = score == null ? 0 : Math.max(0, Math.min(1, score / 100));
  return `<svg viewBox="0 0 72 72" class="rd-ring" aria-hidden="true">
    <circle cx="36" cy="36" r="${R}" class="rd-track"/>
    <circle cx="36" cy="36" r="${R}" class="rd-fill" stroke-dasharray="${L}" stroke-dashoffset="${L * (1 - f)}" transform="rotate(-90 36 36)"/>
    <text x="36" y="42" text-anchor="middle">${score == null ? "–" : score}</text></svg>`;
}

export async function renderReadiness(ctx, el, day) {
  C = ctx;
  const r = await C.rpc("get_readiness", { p_day: day }).catch(() => null);
  if (!r) { el.innerHTML = ""; return; }
  const bb = n(r.bb_wake);
  const bbTone = tone(bb);
  el.innerHTML = `<div class="readyrow">
    <button class="rd-card ${tone(n(r.score))}" id="rdOpen" type="button" aria-label="Readiness ${r.score ?? "onbekend"}, details">
      ${ring(n(r.score))}
      <span class="rd-txt"><span class="rd-k">Readiness</span><b>${C.esc(r.label || "Nog geen data")}</b></span>
    </button>
    <div class="rd-card bb ${bbTone}">
      <div class="bb-bat" aria-hidden="true"><i style="height:${bb ?? 0}%"></i></div>
      <span class="rd-txt"><span class="rd-k">Body Battery</span><b class="bb-num">${bb ?? "–"}</b><span class="rd-s">bij opstaan</span></span>
    </div>
  </div>`;
  el.querySelector("#rdOpen").onclick = () => details(r);
}

function details(r) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const row = (k, l, v, extra) => `<div class="rd-part"><span>${l}</span><span class="rd-bar"><i class="${tone(v)}" style="width:${v ?? 0}%"></i></span><b>${v ?? "–"}</b>${extra ? `<small>${extra}</small>` : ""}</div>`;
  const p = r.parts || {};
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Readiness">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Readiness ${r.score ?? "–"}</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <p class="small muted" style="margin:6px 0 12px">Je Venu 3 heeft geen Training Readiness, dus Health Hub berekent er zelf een uit je Garmin-data van vannacht.</p>
    ${row("slaap", "Slaap (30%)", p.slaap, r.sleep_score != null ? `slaapscore ${r.sleep_score}` : "")}
    ${row("bb", "Body Battery (30%)", p.body_battery, r.bb_wake != null ? `${r.bb_wake} bij opstaan` : "")}
    ${row("hrv", "HRV (25%)", p.hrv, r.hrv != null ? `${r.hrv} ms, gemiddeld ${r.hrv_base ?? "–"}` : "")}
    ${row("rhr", "Rusthartslag (15%)", p.rusthartslag, r.rhr != null ? `${r.rhr} bpm, gemiddeld ${r.rhr_base ?? "–"}` : "")}
    <p class="small muted" style="margin:12px 0 0">75+ klaar voor zwaar werk · 50–74 normaal trainen · 30–49 rustig aan · onder 30 herstel voorop. HRV en rusthartslag worden vergeleken met je eigen gemiddelde van de 7 dagen ervoor.</p>
  </div>`;
  document.body.appendChild(sheet);
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("[data-close]")) sheet.remove(); });
}
