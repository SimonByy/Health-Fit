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
  const bb = n(r.bb_now) ?? n(r.bb_wake);
  const bbTone = tone(bb);
  const sc = n(r.score_now) ?? n(r.score);
  const hm = (iso) => new Intl.DateTimeFormat("nl-BE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" }).format(new Date(iso));
  const isToday = day === C.today();
  // Het horloge synct pas naar Garmin als de Garmin Connect-app op je gsm verbinding maakt
  const stale = isToday && r.watch_sync && Date.now() - new Date(r.watch_sync).getTime() > 60 * 6e4;
  const est = isToday && r.bb_now != null && r.bb_base_ts && Date.now() - new Date(r.bb_base_ts).getTime() > 30 * 6e4;
  const bbSub = !isToday ? "einde van de dag (geschat)"
    : est && r.bb_actual ? `geschat · ${r.bb_base} om ${hm(r.bb_base_ts)}`
    : r.bb_actual ? `gemeten ${hm(r.bb_base_ts)}` : r.bb_now != null ? "geschat" : "bij opstaan";
  el.innerHTML = `<div class="readyrow">
    <button class="rd-card ${tone(sc)}" id="rdOpen" type="button" aria-label="Readiness ${sc ?? "onbekend"}, details">
      ${ring(sc)}
      <span class="rd-txt"><span class="rd-k">Readiness</span><b>${C.esc(r.label || "Nog geen data")}</b></span>
    </button>
    <button class="rd-card bb ${bbTone}" id="bbOpen" type="button" aria-label="Body Battery ${bb ?? "onbekend"}, details">
      <div class="bb-bat" aria-hidden="true"><i style="height:${bb ?? 0}%"></i></div>
      <span class="rd-txt"><span class="rd-k">Body Battery</span><b class="bb-num">${bb == null ? "–" : (est ? "≈" : "") + bb}</b><span class="rd-s">${bbSub}</span></span>
    </button>
  </div>${stale ? `<p class="rd-stale small">Je horloge synct niet sinds ${hm(r.watch_sync)}. Open de Garmin Connect-app even, dan klopt dit weer.</p>` : ""}`;
  el.querySelector("#rdOpen").onclick = () => details(r);
  el.querySelector("#bbOpen").onclick = () => details(r);
}

async function details(r) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const row = (l, v, extra) => `<div class="rd-part"><span>${l}</span><span class="rd-bar"><i class="${tone(v)}" style="width:${v ?? 0}%"></i></span><b>${v ?? "–"}</b>${extra ? `<small>${extra}</small>` : ""}</div>`;
  const p = r.parts || {};
  const sc = r.score_now ?? r.score;
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Readiness">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Readiness ${sc ?? "–"}</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <p class="small muted" style="margin:4px 0 12px">${C.esc(r.label || "")}${r.score != null && sc !== r.score ? ` · 's ochtends ${r.score}` : ""}</p>
    ${row("Slaap", p.slaap, r.sleep_score != null ? `score ${r.sleep_score}` : "")}
    ${row("Body Battery", p.body_battery, r.bb_wake != null ? `${r.bb_wake} bij opstaan` : "")}
    ${row("HRV", p.hrv, r.hrv != null ? `${r.hrv} ms (gem. ${r.hrv_base ?? "–"})` : "")}
    ${row("Rusthartslag", p.rusthartslag, r.rhr != null ? `${r.rhr} bpm (gem. ${r.rhr_base ?? "–"})` : "")}
    <h4 style="margin:16px 0 6px">Body Battery vandaag</h4>
    <div id="bbDay" class="bbday"><div class="skeleton" style="height:120px"></div></div>
  </div>`;
  document.body.appendChild(sheet);
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("[data-close]")) sheet.remove(); });
  const box = sheet.querySelector("#bbDay");
  const d = await C.rpc("get_bb_day", { p_day: r.day }).catch(() => null);
  if (!d) { box.innerHTML = `<p class="small muted">Geen gegevens.</p>`; return; }
  box.innerHTML = bbChart(d, r);
}

// Verloop van je Body Battery met je trainingen erop: waarom hij zakte
function bbChart(d, r) {
  const W = 340, H = 130, P = { l: 24, r: 8, t: 8, b: 20 };
  const day0 = new Date(d.day + "T00:00:00").getTime();
  const isToday = d.day === C.today();
  const end = isToday ? Date.now() : day0 + 864e5;
  const pts = (d.series || []).filter(([t]) => t >= day0 && t <= end);
  const x = (t) => P.l + ((t - day0) / (end - day0)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - v / 100) * (H - P.t - P.b);
  const hm = (t) => new Intl.DateTimeFormat("nl-BE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" }).format(new Date(t));
  const acts = (d.acts || []).map((a) => {
    const s = new Date(String(a.start).replace(" ", "T")).getTime();
    return { ...a, s, e: s + (Number(a.min) || 30) * 6e4 };
  }).filter((a) => !Number.isNaN(a.s));
  const path = pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = pts.at(-1);
  // schatting vanaf de laatste meting tot nu
  const est = isToday && last && r.bb_now != null && end - last[0] > 20 * 6e4 ? `<path d="M${x(last[0]).toFixed(1)},${y(last[1]).toFixed(1)} L${x(end).toFixed(1)},${y(r.bb_now).toFixed(1)}" class="bb-est"/>` : "";
  const hours = [0, 6, 12, 18].map((h) => day0 + h * 36e5).filter((t) => t <= end);
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="bb-svg" role="img" aria-label="Body Battery doorheen de dag">
    ${[0, 50, 100].map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="bb-grid"/><text x="${P.l - 4}" y="${y(v) + 4}" text-anchor="end" class="bb-ax">${v}</text>`).join("")}
    ${acts.map((a) => `<rect x="${x(a.s).toFixed(1)}" y="${P.t}" width="${Math.max(3, x(Math.min(a.e, end)) - x(a.s)).toFixed(1)}" height="${H - P.t - P.b}" class="bb-act ${a.kind}"/>`).join("")}
    ${path ? `<path d="${path}" class="bb-line"/>` : ""}${est}
    ${hours.map((t) => `<text x="${x(t)}" y="${H - 5}" text-anchor="middle" class="bb-ax">${hm(t).slice(0, 2)}u</text>`).join("")}
  </svg>`;
  const drops = acts.map((a) => {
    const before = pts.filter(([t]) => t <= a.s).at(-1), after = pts.filter(([t]) => t >= a.e).at(0);
    const dlt = before && after ? Math.round(after[1] - before[1]) : null;
    return `<li><i class="dot ${a.kind}"></i>${C.esc(a.name || (a.kind === "kracht" ? "Krachttraining" : "Training"))} · ${hm(a.s)} · ${Math.round(a.min || 0)} min${dlt != null && dlt < 0 ? ` · <b>${dlt}</b>` : ""}</li>`;
  }).join("");
  const lastTxt = last ? `Laatst gemeten om ${hm(last[0])}: <b>${last[1]}</b>${isToday && end - last[0] > 45 * 6e4 && r.bb_now != null
      ? `. Stippellijn = schatting met jouw gemiddelde verbruik (${String(r.bb_rate ?? 2.5).replace(".", ",")} per uur): nu ongeveer <b>${r.bb_now}</b>.` : ""}` : "Nog geen metingen vandaag.";
  return `${svg}${drops ? `<ul class="bb-acts">${drops}</ul>` : ""}<p class="small muted" style="margin:8px 0 0">${lastTxt}</p>`;
}
