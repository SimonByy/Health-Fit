import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ======================================================================
// Hulpfuncties
// ======================================================================
const TZ = "Europe/Brussels";
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const nf0 = new Intl.NumberFormat("nl-BE", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("nl-BE", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("nl-BE", { maximumFractionDigits: 2 });

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const fmt = (v, dec = 0) => {
  const n = num(v);
  if (n === null) return "–";
  return (dec === 0 ? nf0 : dec === 1 ? nf1 : nf2).format(n);
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayLabel = (iso, opts = { weekday: "long", day: "numeric", month: "long" }) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("nl-BE", { ...opts, timeZone: "UTC" });
const shortDate = (iso) => dayLabel(iso, { day: "numeric", month: "short" });
const relDay = (iso) => {
  const t = today();
  if (iso === t) return "Vandaag";
  if (iso === addDays(t, -1)) return "Gisteren";
  return dayLabel(iso);
};
const hours = (h) => {
  const n = num(h);
  if (n === null) return "–";
  const hh = Math.floor(n);
  const mm = Math.round((n - hh) * 60);
  return `${hh}u${String(mm).padStart(2, "0")}`;
};
const timeAgo = (ts) => {
  if (!ts) return "nooit";
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 90) return "zonet";
  if (s < 3600) return `${Math.round(s / 60)} min geleden`;
  if (s < 86400) return `${Math.round(s / 3600)} u geleden`;
  return `${Math.round(s / 86400)} d geleden`;
};

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    if (/Geen toegang/.test(error.message)) throw new Error("Dit account heeft geen toegang tot deze app.");
    throw new Error(error.message);
  }
  return data;
}

async function invoke(fn, body) {
  const { data, error } = await sb.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message;
    try {
      const b = await error.context.json();
      msg = b.error || msg;
    } catch { /* geen json */ }
    throw new Error(msg);
  }
  return data;
}

function showError(err) {
  view.innerHTML = `<div class="empty"><strong>Er ging iets mis</strong>${esc(err.message || err)}</div>`;
}

const DOMAIN = {
  move: "var(--move)", sleep: "var(--sleep)", fuel: "var(--fuel)", strength: "var(--strength)", heart: "var(--heart)",
};

// ======================================================================
// Grafieken (SVG, met hover/tap-tooltip)
// ======================================================================
function mountChart(el, opts) {
  const draw = () => drawChart(el, opts);
  draw();
  const ro = new ResizeObserver(() => {
    if (el.clientWidth !== el._w) draw();
  });
  ro.observe(el);
}

function drawChart(el, { points, color, type = "bar", unit = "", dec = 0, goal = null, zero = true, height = 150, fmtY }) {
  const w = el.clientWidth || 320;
  el._w = w;
  const vals = points.map((p) => num(p.y));
  const present = vals.filter((v) => v !== null);
  if (!present.length) {
    el.innerHTML = `<p class="muted small" style="margin:8px 0 4px">Nog geen data voor deze periode.</p>`;
    return;
  }
  const pad = { l: 38, r: 6, t: 10, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  let lo = zero ? 0 : Math.min(...present);
  let hi = Math.max(...present, goal ?? -Infinity);
  if (!zero) {
    const span = hi - lo || Math.abs(hi) * 0.1 || 1;
    lo -= span * 0.15;
    hi += span * 0.15;
  } else {
    hi = hi * 1.08 || 1;
  }
  if (zero) {
    const raw = hi / 2;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const nice = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) || raw;
    hi = nice * 2;
  }
  const n = points.length;
  const step = iw / n;
  const x = (i) => pad.l + step * i + step / 2;
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const f = fmtY || ((v) => fmt(v, dec));

  // rasterlijnen: 3 stappen
  const ticks = [0, 0.5, 1].map((t) => lo + (hi - lo) * t);
  let svg = `<svg height="${height}" viewBox="0 0 ${w} ${height}" role="img" aria-label="grafiek">`;
  svg += `<g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>`;
  svg += `<g class="axis">${ticks
    .map((t) => `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${esc(f(t))}</text>`)
    .join("")}</g>`;
  // x-labels: eerste, midden, laatste
  const xi = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  svg += `<g class="axis">${xi
    .map((i) => {
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      const xx = i === 0 ? pad.l : i === n - 1 ? w - pad.r : x(i);
      return `<text x="${xx}" y="${height - 4}" text-anchor="${anchor}">${esc(points[i].label ?? shortDate(points[i].x))}</text>`;
    })
    .join("")}</g>`;
  svg += `<rect class="hl" x="0" y="${pad.t}" width="${Math.max(step, 2)}" height="${ih}" id="hl"/>`;
  if (type === "bar") {
    const bw = Math.max(1.5, Math.min(step - 2, 22));
    const rx = Math.min(4, bw / 2);
    points.forEach((p, i) => {
      const v = num(p.y);
      if (v === null) return;
      const top = y(Math.max(v, lo));
      const base = y(lo);
      const hgt = Math.max(base - top, 1);
      // afgeronde bovenkant, vlak op de basislijn
      const x0 = x(i) - bw / 2;
      const r = Math.min(rx, hgt);
      svg += `<path fill="${color}" d="M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${base} Z"/>`;
    });
  } else {
    // lijn verbindt gemeten punten (ook over dagen zonder meting heen)
    const pts = points.map((p, i) => ({ v: num(p.y), i })).filter((o) => o.v !== null);
    const d = pts.map((o, k) => `${k ? "L" : "M"}${x(o.i).toFixed(1)},${y(o.v).toFixed(1)}`).join(" ");
    svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (pts.length < 2 || pts.length < n / 3) pts.forEach((o) => { svg += `<circle cx="${x(o.i)}" cy="${y(o.v)}" r="3" fill="${color}"/>`; });
    svg += `<circle id="dot" r="4.5" fill="${color}" stroke="var(--surface)" stroke-width="2" opacity="0"/>`;
  }
  if (goal != null) {
    svg += `<line class="goal" x1="${pad.l}" x2="${w - pad.r}" y1="${y(goal)}" y2="${y(goal)}"/>`;
    svg += `<text class="goal-label" x="${w - pad.r}" y="${y(goal) - 4}" text-anchor="end">doel ${esc(f(goal))}</text>`;
  }
  svg += `</svg>`;
  el.innerHTML = `<div class="chart">${svg}<div class="tip"></div></div>`;

  const wrap = el.firstElementChild;
  const tip = wrap.querySelector(".tip");
  const hl = wrap.querySelector("#hl");
  const dot = wrap.querySelector("#dot");
  const move = (ev) => {
    const r = wrap.getBoundingClientRect();
    const px = (ev.touches?.[0]?.clientX ?? ev.clientX) - r.left;
    let i = Math.floor((px - pad.l) / step);
    i = Math.max(0, Math.min(n - 1, i));
    const p = points[i];
    const v = num(p.y);
    hl.setAttribute("x", x(i) - step / 2);
    hl.setAttribute("width", step);
    hl.classList.add("on");
    tip.innerHTML = `${esc(p.tip ?? shortDate(p.x))}<br><b>${v === null ? "geen data" : esc(f(v)) + (unit ? " " + esc(unit) : "")}</b>`;
    tip.style.left = `${Math.max(50, Math.min(w - 50, x(i)))}px`;
    tip.style.top = `${v === null ? pad.t + 20 : y(v) - 6}px`;
    tip.style.opacity = "1";
    if (dot && v !== null) { dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(v)); dot.setAttribute("opacity", "1"); }
  };
  const leave = () => {
    tip.style.opacity = "0";
    hl.classList.remove("on");
    dot?.setAttribute("opacity", "0");
  };
  wrap.addEventListener("pointermove", move);
  wrap.addEventListener("pointerdown", move);
  wrap.addEventListener("pointerleave", leave);
}

// ======================================================================
// Router
// ======================================================================
const state = { day: today(), nutDay: today(), trendDays: 30, trainTab: "workouts", conversation: null };
const TITLES = { vandaag: "Vandaag", training: "Training", voeding: "Voeding", trends: "Trends", vraag: "Vraag het", instellingen: "Instellingen" };
const ACCENT = { vandaag: "--move", training: "--strength", voeding: "--fuel", trends: "--heart", vraag: "--sleep" };

async function route() {
  const name = (location.hash.replace(/^#\/?/, "") || "vandaag").split("/")[0];
  const fn = ROUTES[name] || ROUTES.vandaag;
  $("#title").textContent = TITLES[name] || "Vandaag";
  document.querySelectorAll(".tabbar a").forEach((a) => {
    if (a.dataset.tab === name) {
      a.setAttribute("aria-current", "page");
      a.style.setProperty("--accent", `var(${ACCENT[name]})`);
    } else a.removeAttribute("aria-current");
  });
  document.body.dataset.route = name;
  $(".composer")?.remove();
  view.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
  window.scrollTo(0, 0);
  try {
    await fn();
  } catch (e) {
    console.error(e);
    showError(e);
  }
}

// ======================================================================
// Vandaag
// ======================================================================
function statRow({ name, value, unit = "", dec = 0, goal = null, avg = null, color, higherIsBetter = true, display }) {
  const v = num(value);
  const shown = display ?? (v === null ? null : fmt(v, dec));
  let bar = "";
  let left = "";
  if (goal && v !== null) {
    const pct = Math.max(0, Math.min(100, (v / goal) * 100));
    bar = `<div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div>`;
    left = `${Math.round((v / goal) * 100)}% van ${display && unit === "" ? hours(goal) : fmt(goal, dec) + (unit ? " " + unit : "")}`;
  }
  let right = "";
  const a = num(avg);
  if (a !== null && v !== null && a !== 0) {
    const diff = v - a;
    const rel = Math.abs(diff / a);
    const cls = rel < 0.03 ? "neutral" : (diff > 0) === higherIsBetter ? "up" : "down";
    const sign = diff > 0 ? "+" : "−";
    const dtxt = display ? hours(Math.abs(diff)) : fmt(Math.abs(diff), dec);
    right = `<span class="delta ${cls}">${sign}${dtxt} vs. 7d-gem.</span>`;
  } else if (a !== null) {
    right = `<span>7d-gem. ${display ? hours(a) : fmt(a, dec)}</span>`;
  }
  return `<div class="stat" style="--c:${color}">
    <span class="name">${esc(name)}</span>
    <span class="num ${shown === null ? "none" : ""}">${shown === null ? "–" : esc(shown)}${shown !== null && unit ? `<small>${esc(unit)}</small>` : ""}</span>
    ${bar}
    ${left || right ? `<div class="sub"><span>${left}</span>${right}</div>` : ""}
  </div>`;
}

function activityItem(a) {
  const strength = a.kind === "strength";
  const color = strength ? DOMAIN.strength : DOMAIN.move;
  const time = (a.start_local || "").slice(11, 16);
  const meta = strength
    ? `${relDay(a.day)}, ${time} · ${fmt(a.duration_min)} min · ${fmt(a.exercises)} oefeningen`
    : `${relDay(a.day)}, ${time} · ${fmt(a.duration_min)} min${a.avg_hr ? ` · gem. ${fmt(a.avg_hr)} bpm` : ""}`;
  const right = strength
    ? `${fmt(a.volume_kg)}<small>kg volume</small>`
    : a.distance_km
      ? `${fmt(a.distance_km, 2)}<small>km</small>`
      : `${fmt(a.active_kcal)}<small>kcal</small>`;
  return `<button class="item" style="--c:${color}" data-kind="${a.kind}" data-id="${esc(a.id)}" aria-expanded="false">
    <span class="swatch"></span>
    <span><div class="t">${esc(a.title || "Training")}</div><div class="m">${esc(meta)}</div></span>
    <span class="r">${right}</span>
  </button>`;
}

async function toggleActivity(btn) {
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.nextElementSibling?.classList.contains("detail") && btn.nextElementSibling.remove();
  btn.setAttribute("aria-expanded", String(!open));
  if (open) return;
  const det = document.createElement("div");
  det.className = "detail";
  det.innerHTML = `<p class="muted small">Laden…</p>`;
  btn.after(det);
  if (btn.dataset.kind !== "strength") {
    det.innerHTML = `<p class="muted small">Cardio-training uit Apple Health (bv. via Garmin).</p>`;
    return;
  }
  try {
    const d = await rpc("get_hevy_workout", { p_id: btn.dataset.id });
    const rows = (d.exercises || [])
      .map((e) => {
        const sets = (e.sets || [])
          .map((s) => {
            const txt = s.kg != null ? `${fmt(s.kg, 1)}×${s.reps ?? "–"}` : s.duration_s ? `${fmt(s.duration_s)}s` : s.reps != null ? `${s.reps} reps` : "–";
            return s.type === "warmup" ? `<span class="set-warm">${txt}</span>` : txt;
          })
          .join(", ");
        return `<tr><td><div class="ex-name">${esc(e.exercise)}</div><div class="ex-sets">${sets}</div></td>
          <td>${e.best_1rm ? `1RM ≈ ${fmt(e.best_1rm, 1)} kg` : ""}</td></tr>`;
      })
      .join("");
    det.innerHTML = rows ? `<table>${rows}</table>` : `<p class="muted small">Geen sets gevonden.</p>`;
  } catch (e) {
    det.innerHTML = `<p class="warn small">${esc(e.message)}</p>`;
  }
}

function bindActivityList(root) {
  root.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".item[data-kind]");
    if (btn) toggleActivity(btn);
  });
}

async function renderToday() {
  const d = await rpc("get_dashboard", { p_day: state.day });
  const t = d.today || {};
  const a = d.avg7 || {};
  const g = d.goals || {};
  const isToday = state.day === today();

  const nothing = !d.series?.length && !d.recent?.length;
  view.innerHTML = `
    <div class="daynav">
      <button id="prev" aria-label="Vorige dag">‹</button>
      <span class="label">${esc(dayLabel(state.day))}</span>
      <button id="next" aria-label="Volgende dag" ${isToday ? "disabled" : ""}>›</button>
    </div>
    ${nothing ? onboardingCard() : ""}
    <div class="board">
      <section class="domain" style="--c:${DOMAIN.move}">
        <h2>Beweging</h2>
        ${statRow({ name: "Stappen", value: t.steps, goal: g.steps, avg: a.steps, color: DOMAIN.move })}
        ${statRow({ name: "Actieve energie", value: t.active_kcal, unit: "kcal", goal: g.active_kcal, avg: a.active_kcal, color: DOMAIN.move })}
        ${t.cardio_min || t.strength_min ? statRow({ name: "Getraind", value: (num(t.cardio_min) || 0) + (num(t.strength_min) || 0), unit: "min", color: DOMAIN.move }) : ""}
      </section>
      <section class="domain" style="--c:${DOMAIN.sleep}">
        <h2>Herstel</h2>
        ${statRow({ name: "Slaap", value: t.sleep_h, display: t.sleep_h == null ? null : hours(t.sleep_h), goal: g.sleep_h, avg: a.sleep_h, color: DOMAIN.sleep })}
        ${t.deep_sleep_h != null ? `<div class="sub muted small" style="margin:-6px 0 8px">Diep ${hours(t.deep_sleep_h)} · REM ${hours(t.rem_sleep_h)}</div>` : ""}
        ${statRow({ name: "Rusthartslag", value: t.resting_hr, unit: "bpm", avg: a.resting_hr, color: DOMAIN.heart, higherIsBetter: false })}
        ${statRow({ name: "HRV", value: t.hrv_ms, unit: "ms", avg: a.hrv_ms, color: DOMAIN.heart })}
      </section>
      <section class="domain" style="--c:${DOMAIN.fuel}">
        <h2>Voeding</h2>
        ${statRow({ name: "Calorieën", value: t.kcal_in, unit: "kcal", goal: g.kcal_in, avg: a.kcal_in, color: DOMAIN.fuel })}
        ${statRow({ name: "Eiwit", value: t.protein_g, unit: "g", goal: g.protein_g, avg: a.protein_g, color: DOMAIN.fuel })}
        ${t.kcal_in != null ? `<div class="sub muted small" style="margin:-4px 0 10px">Koolhydraten ${fmt(t.carbs_g)} g · Vet ${fmt(t.fat_g)} g · Vezels ${fmt(t.fiber_g)} g</div>` : ""}
      </section>
      <section class="domain" style="--c:${DOMAIN.heart}">
        <h2>Lichaam</h2>
        ${statRow({
          name: t.weight_kg != null ? "Gewicht" : `Gewicht${d.last_weight ? ` (${shortDate(d.last_weight.day)})` : ""}`,
          value: t.weight_kg ?? d.last_weight?.kg, unit: "kg", dec: 1, color: DOMAIN.heart,
        })}
      </section>
    </div>

    <h2 class="section-title">Laatste trainingen</h2>
    <div class="list" id="recent">${(d.recent || []).map(activityItem).join("") || `<div class="empty">Nog geen trainingen gesynchroniseerd.</div>`}</div>

    <p class="muted small" style="margin-top:18px">
      Apple Health: ${esc(timeAgo(d.sync?.apple_health?.last_success))} ·
      Hevy: ${esc(timeAgo(d.sync?.hevy?.last_success))}${d.sync?.hevy?.last_error ? ` <span class="warn">(fout)</span>` : ""}
    </p>`;

  $("#prev").onclick = () => { state.day = addDays(state.day, -1); renderToday(); };
  $("#next").onclick = () => { if (!isToday) { state.day = addDays(state.day, 1); renderToday(); } };
  bindActivityList($("#recent"));
}

function onboardingCard() {
  return `<div class="panel" style="margin-bottom:12px">
    <h3>Welkom! Nog geen data binnen.</h3>
    <p class="hint">Koppel je bronnen in Instellingen: de Health Auto Export-app voor Apple Health, en je Hevy API-key.</p>
    <a class="btn" href="#/instellingen" style="display:inline-block;text-decoration:none">Naar instellingen</a>
  </div>`;
}

// ======================================================================
// Training
// ======================================================================
async function renderTraining() {
  const tab = state.trainTab;
  view.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <div class="seg" role="group" aria-label="Weergave">
        <button data-t="workouts" aria-pressed="${tab === "workouts"}">Trainingen</button>
        <button data-t="exercises" aria-pressed="${tab === "exercises"}">Oefeningen</button>
      </div>
      <button class="btn ghost" id="syncHevy" style="margin-bottom:14px">Sync Hevy</button>
    </div>
    <div id="tcontent"><div class="skeleton"></div></div>`;
  view.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { state.trainTab = b.dataset.t; renderTraining(); }));
  $("#syncHevy").onclick = () => syncHevy($("#syncHevy"), false, renderTraining);
  const box = $("#tcontent");

  if (tab === "workouts") {
    const list = await rpc("get_activities", { p_limit: 60, p_offset: 0 });
    box.innerHTML = list.length
      ? `<div class="list" id="acts">${list.map(activityItem).join("")}</div>`
      : `<div class="empty"><strong>Nog geen trainingen.</strong>Stel je Hevy API-key in bij Instellingen en synchroniseer. Cardio komt binnen via Apple Health.</div>`;
    if (list.length) bindActivityList($("#acts"));
  } else {
    const ex = await rpc("get_exercises");
    if (!ex.length) {
      box.innerHTML = `<div class="empty"><strong>Nog geen oefeningen.</strong>Zodra Hevy gesynchroniseerd is, zie je hier je progressie per oefening.</div>`;
      return;
    }
    box.innerHTML = `<div class="list" id="exlist">${ex
      .map((e) => `<button class="item" style="--c:${DOMAIN.strength}" data-ex="${esc(e.exercise)}">
        <span class="swatch"></span>
        <span><div class="t">${esc(e.exercise)}</div><div class="m">${fmt(e.sessions)}× · laatst ${esc(shortDate(e.last_day))}${e.muscle ? ` · ${esc(e.muscle)}` : ""}</div></span>
        <span class="r">${e.best_1rm ? fmt(e.best_1rm, 1) : fmt(e.max_kg, 1)}<small>${e.best_1rm ? "beste 1RM kg" : "max kg"}</small></span>
      </button>`)
      .join("")}</div>`;
    $("#exlist").addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-ex]");
      if (!b) return;
      if (b.nextElementSibling?.classList.contains("detail")) { b.nextElementSibling.remove(); return; }
      const det = document.createElement("div");
      det.className = "detail";
      det.style.paddingLeft = "16px";
      det.innerHTML = `<p class="muted small">Laden…</p>`;
      b.after(det);
      const hist = await rpc("get_exercise_history", { p_exercise: b.dataset.ex });
      const hasRm = hist.some((h) => h.best_1rm);
      det.innerHTML = `<p class="small muted" style="margin:8px 0 4px">${hasRm ? "Geschatte 1RM per training (kg)" : "Zwaarste set per training (kg)"}</p><div class="c"></div>
        <table style="margin-top:8px">${hist.slice(-5).reverse()
          .map((h) => `<tr><td>${esc(shortDate(h.day))}</td><td>${h.top_kg != null ? `${fmt(h.top_kg, 1)} kg × ${h.top_reps ?? "–"}` : `${fmt(h.sets)} sets`}</td></tr>`).join("")}</table>`;
      mountChart(det.querySelector(".c"), {
        points: hist.map((h) => ({ x: h.day, y: hasRm ? h.best_1rm : h.top_kg })),
        color: DOMAIN.strength, type: "line", unit: "kg", dec: 1, zero: false, height: 140,
      });
    });
  }
}

async function syncHevy(btn, full, after) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Bezig…";
  try {
    const r = await invoke("sync-hevy", { full });
    toast(r.complete === false ? `Deels gesynchroniseerd (${r.updated}), de rest volgt automatisch` : `Hevy gesynchroniseerd: ${r.updated} bijgewerkt`);
    after?.();
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ======================================================================
// Voeding
// ======================================================================
async function renderNutrition() {
  const d = await rpc("get_nutrition_day", { p_day: state.nutDay });
  const by = Object.fromEntries((d.nutrients || []).map((n) => [n.metric, n]));
  const g = d.goals || {};
  const kcal = num(by.dietary_energy?.value);
  const p = num(by.protein?.value), c = num(by.carbohydrates?.value), f = num(by.total_fat?.value);
  const macroK = (p || 0) * 4 + (c || 0) * 4 + (f || 0) * 9;
  const pct = (v, k) => (macroK > 0 && v != null ? `${Math.round((v * k / macroK) * 100)}% van kcal` : "");
  const isToday = state.nutDay === today();
  const micros = (d.nutrients || []).filter((n) => !["dietary_energy", "protein", "carbohydrates", "total_fat"].includes(n.metric));

  view.innerHTML = `
    <div class="daynav">
      <button id="prev" aria-label="Vorige dag">‹</button>
      <span class="label">${esc(isToday ? "Vandaag, " + dayLabel(state.nutDay, { day: "numeric", month: "long" }) : dayLabel(state.nutDay))}</span>
      <button id="next" aria-label="Volgende dag" ${isToday ? "disabled" : ""}>›</button>
    </div>
    ${kcal === null ? `<div class="empty"><strong>Niets gelogd op deze dag.</strong>Voeding komt binnen via Apple Health (uit je voedings-app) bij de volgende export.</div>` : `
    <section class="domain" style="--c:${DOMAIN.fuel};padding-bottom:16px">
      <h2>Calorieën</h2>
      <div class="hero-num">${fmt(kcal)}<small>kcal</small></div>
      ${g.kcal_in ? `<div class="bar" style="--c:${DOMAIN.fuel}"><i style="width:${Math.min(100, (kcal / g.kcal_in) * 100)}%"></i></div>
      <div class="small muted" style="margin-top:6px">${Math.round((kcal / g.kcal_in) * 100)}% van je doel van ${fmt(g.kcal_in)} kcal</div>` : ""}
      <div class="macros">
        <div class="macro"><div class="v">${fmt(p)}<small> g</small></div><div class="l">Eiwit${g.protein_g ? ` / ${fmt(g.protein_g)}` : ""}<br>${pct(p, 4)}</div></div>
        <div class="macro"><div class="v">${fmt(c)}<small> g</small></div><div class="l">Koolhydraten<br>${pct(c, 4)}</div></div>
        <div class="macro"><div class="v">${fmt(f)}<small> g</small></div><div class="l">Vet<br>${pct(f, 9)}</div></div>
      </div>
    </section>

    <h2 class="section-title">Per moment</h2>
    <div class="panel">
      ${(d.meals || []).map((m) => `<div class="meal">
          <span><b>${esc(m.meal)}</b> <span class="muted small">vanaf ${String(m.first_hour).padStart(2, "0")}u</span></span>
          <span class="k">${fmt(m.kcal)} <span class="muted small">kcal</span></span>
          <span class="p">Eiwit ${fmt(m.protein_g)} g · Koolh. ${fmt(m.carbs_g)} g · Vet ${fmt(m.fat_g)} g</span>
        </div>`).join("") || `<p class="muted small">Geen tijdsinfo beschikbaar.</p>`}
      <p class="muted small" style="margin:8px 0 0">Moment afgeleid uit het uur van loggen (Apple Health bewaart geen maaltijdnamen).</p>
    </div>

    <h2 class="section-title">Alle voedingsstoffen</h2>
    <div class="panel">
      <details ${micros.length <= 8 ? "open" : ""}>
        <summary>${micros.length} gelogde waarden</summary>
        <table class="nutrients">${micros.map((n) => `<tr><td>${esc(n.label)}</td><td>${fmt(n.value, n.value < 10 ? 1 : 0)} ${esc(n.unit || "")}</td></tr>`).join("")}</table>
      </details>
    </div>`}
  `;
  $("#prev").onclick = () => { state.nutDay = addDays(state.nutDay, -1); renderNutrition(); };
  $("#next").onclick = () => { if (!isToday) { state.nutDay = addDays(state.nutDay, 1); renderNutrition(); } };
}

// ======================================================================
// Trends
// ======================================================================
function weekly(rows, key, how = "avg") {
  const buckets = new Map();
  for (const r of rows) {
    const d = new Date(r.day + "T12:00:00Z");
    const dow = (d.getUTCDay() + 6) % 7;
    const monday = addDays(r.day, -dow);
    if (!buckets.has(monday)) buckets.set(monday, []);
    const v = num(r[key]);
    if (v !== null) buckets.get(monday).push(v);
  }
  return [...buckets.entries()].sort().map(([wk, vs]) => ({
    x: wk,
    label: shortDate(wk),
    tip: `Week van ${shortDate(wk)}`,
    y: vs.length ? (how === "sum" ? vs.reduce((s, v) => s + v, 0) : vs.reduce((s, v) => s + v, 0) / vs.length) : null,
  }));
}

function fillDays(rows, from, to) {
  const map = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(map.get(d) || { day: d });
  return out;
}

async function renderTrends() {
  const days = state.trendDays;
  const to = today();
  const from = addDays(to, -(days - 1));
  const rows = fillDays(await rpc("get_range", { p_from: from, p_to: to }), from, to);
  const g = (await rpc("get_dashboard", { p_day: to })).goals || {};
  const byWeek = days > 90;

  const charts = [
    { key: "steps", title: "Stappen", color: DOMAIN.move, type: "bar", goal: g.steps },
    { key: "active_kcal", title: "Actieve energie", unit: "kcal", color: DOMAIN.move, type: "bar" },
    { key: "sleep_h", title: "Slaap", unit: "u", color: DOMAIN.sleep, type: "bar", dec: 1, goal: g.sleep_h },
    { key: "resting_hr", title: "Rusthartslag", unit: "bpm", color: DOMAIN.heart, type: "line", zero: false },
    { key: "hrv_ms", title: "HRV", unit: "ms", color: DOMAIN.heart, type: "line", zero: false },
    { key: "weight_kg", title: "Gewicht", unit: "kg", color: DOMAIN.heart, type: "line", zero: false, dec: 1 },
    { key: "kcal_in", title: "Calorieën gegeten", unit: "kcal", color: DOMAIN.fuel, type: "bar", goal: g.kcal_in },
    { key: "protein_g", title: "Eiwit", unit: "g", color: DOMAIN.fuel, type: "bar", goal: g.protein_g },
    { key: "strength_volume_kg", title: "Krachtvolume per week", unit: "kg", color: DOMAIN.strength, type: "bar", forceWeek: true, how: "sum" },
  ];

  view.innerHTML = `
    <div class="seg" role="group" aria-label="Periode">
      ${[30, 90, 365].map((n) => `<button data-d="${n}" aria-pressed="${n === days}">${n === 365 ? "1 jaar" : n + " dagen"}</button>`).join("")}
    </div>
    ${charts.map((c, i) => `<section class="panel">
        <div class="chart-head"><h3>${esc(c.title)}</h3><span class="now" id="avg${i}"></span></div>
        <div id="ch${i}"></div>
      </section>`).join("")}
    <p class="muted small">${byWeek ? "Bij 1 jaar tonen de grafieken weekgemiddelden." : "Tik of beweeg over een grafiek voor de exacte waarde."}</p>`;
  view.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { state.trendDays = Number(b.dataset.d); renderTrends(); }));

  charts.forEach((c, i) => {
    const week = byWeek || c.forceWeek;
    const pts = week ? weekly(rows, c.key, c.how || "avg") : rows.map((r) => ({ x: r.day, y: r[c.key] }));
    const vals = rows.map((r) => num(r[c.key])).filter((v) => v !== null);
    if (vals.length) {
      const avg = c.how === "sum"
        ? pts.map((p) => num(p.y)).filter((v) => v !== null).reduce((s, v, _, a) => s + v / a.length, 0)
        : vals.reduce((s, v) => s + v, 0) / vals.length;
      const shown = c.key === "sleep_h" ? hours(avg) : fmt(avg, c.dec ?? 0);
      $(`#avg${i}`).innerHTML = `${esc(shown)}<small>${c.how === "sum" ? "gem. per week" : "gemiddeld"}</small>`;
    }
    mountChart($(`#ch${i}`), {
      points: pts, color: c.color, type: c.type, unit: c.unit, dec: c.dec ?? 0, goal: c.goal ?? null,
      zero: c.zero ?? true, fmtY: c.key === "sleep_h" ? (v) => nf1.format(v) : undefined,
    });
  });
}

// ======================================================================
// Vraag (AI)
// ======================================================================
function md(src) {
  const lines = esc(src).split("\n");
  let html = "", list = null, table = [];
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
    html += "<table>" + rows.map((r, i) => {
      const cells = r.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => inline(c.trim()));
      const tag = i === 0 ? "th" : "td";
      return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
    }).join("") + "</table>";
    table = [];
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(l)) { flushList(); table.push(l); continue; }
    flushTable();
    let m;
    if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = l.match(/^#{1,4}\s+(.*)$/))) {
      flushList(); html += `<h4>${inline(m[1])}</h4>`;
    } else if (!l.trim()) {
      flushList();
    } else {
      flushList(); html += `<p>${inline(l)}</p>`;
    }
  }
  flushList(); flushTable();
  return html;
}

function msgHtml(m) {
  if (m.role === "user") return `<div class="msg user">${esc(m.content)}</div>`;
  const qs = m.meta?.queries || [];
  return `<div class="msg assistant">${md(m.content)}${qs.length ? `
    <details class="sources"><summary>Gebaseerd op ${qs.length} opzoeking${qs.length > 1 ? "en" : ""} in je data</summary>
      <ul>${qs.map((q) => `<li>${esc(q.purpose || "Query")}${q.error ? ` <span class="warn">(fout)</span>` : ` (${q.rows} rijen)`}</li>`).join("")}</ul>
    </details>` : ""}</div>`;
}

const SUGGESTIONS = [
  "Hoe sliep ik deze week vergeleken met vorige week?",
  "Haal ik genoeg eiwit op dagen dat ik train?",
  "Hoe evolueert mijn sterkste oefening de laatste 3 maanden?",
  "Is mijn rusthartslag lager na een week met veel slaap?",
  "Vat mijn laatste 7 dagen samen: wat ging goed, wat kan beter?",
];

async function renderAsk() {
  const chat = await rpc("get_chat", { p_conversation: state.conversation });
  state.conversation = chat.conversation_id || state.conversation;
  const msgs = chat.messages || [];
  view.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <span class="muted small">Op basis van je eigen data</span>
      <button class="btn ghost" id="newChat">Nieuw gesprek</button>
    </div>
    <div class="chat" id="chat">
      ${msgs.length ? msgs.map(msgHtml).join("") : `<div class="panel"><h3>Stel een vraag over je data</h3>
        <p class="hint">Bijvoorbeeld:</p>
        <div class="chips">${SUGGESTIONS.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>`}
    </div>`;
  const comp = document.createElement("div");
  comp.className = "composer";
  comp.innerHTML = `<form id="askForm"><textarea id="q" rows="1" placeholder="Vraag iets over je data…" aria-label="Vraag"></textarea>
    <button class="send" id="sendBtn" aria-label="Verstuur"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></form>`;
  document.body.appendChild(comp);
  const ta = $("#q");
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#askForm").requestSubmit(); } });
  $("#newChat").onclick = () => { state.conversation = crypto.randomUUID(); renderAskEmpty(); };
  $("#chat").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) ask(c.dataset.q); });
  $("#askForm").onsubmit = (e) => { e.preventDefault(); const v = ta.value.trim(); if (v) { ta.value = ""; ta.style.height = "auto"; ask(v); } };
  scrollChatEnd();
}

function renderAskEmpty() {
  $("#chat").innerHTML = `<div class="panel"><h3>Stel een vraag over je data</h3><p class="hint">Bijvoorbeeld:</p>
    <div class="chips">${SUGGESTIONS.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>`;
}

function scrollChatEnd() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

async function ask(q) {
  const box = $("#chat");
  if (box.querySelector(".panel")) box.innerHTML = "";
  box.insertAdjacentHTML("beforeend", msgHtml({ role: "user", content: q }));
  box.insertAdjacentHTML("beforeend", `<div class="thinking" id="thinking"><i></i>Ik zoek het op in je data…</div>`);
  $("#sendBtn").disabled = true;
  scrollChatEnd();
  try {
    if (!state.conversation) state.conversation = crypto.randomUUID();
    const r = await invoke("ask", { message: q, conversation_id: state.conversation });
    state.conversation = r.conversation_id;
    $("#thinking")?.remove();
    box.insertAdjacentHTML("beforeend", msgHtml({ role: "assistant", content: r.answer, meta: { queries: r.queries } }));
  } catch (e) {
    $("#thinking")?.remove();
    box.insertAdjacentHTML("beforeend", `<div class="msg assistant"><p class="warn">${esc(e.message)}</p>
      ${/API-key/.test(e.message) ? `<p><a href="#/instellingen">Stel je Claude API-key in</a></p>` : ""}</div>`);
  } finally {
    const b = $("#sendBtn");
    if (b) b.disabled = false;
    scrollChatEnd();
  }
}

// ======================================================================
// Instellingen
// ======================================================================
async function renderSettings() {
  const s = await rpc("get_settings");
  const { data: { user } } = await sb.auth.getUser();
  const goals = s.settings?.goals || {};
  const model = s.settings?.ai_model || "claude-sonnet-5-5";
  const ingestUrl = `${SUPABASE_URL}/functions/v1/ingest-health`;
  const sync = s.sync || {};
  const c = s.counts || {};

  view.innerHTML = `
    <section class="panel">
      <h3>Apple Health</h3>
      <p class="hint">Via de iOS-app <b>Health Auto Export</b> (REST API-automatisatie). Status: ${sync.apple_health?.last_success ? `<span class="ok">laatst ontvangen ${esc(timeAgo(sync.apple_health.last_success))}</span>` : `<span class="warn">nog niets ontvangen</span>`}</p>
      <div class="field"><label>URL</label>
        <div class="row"><input class="input mono" readonly value="${esc(ingestUrl)}" id="ingUrl"><button class="btn secondary" data-copy="ingUrl">Kopieer</button></div></div>
      <div class="field"><label>Header: <span class="mono">Authorization</span> = <span class="mono">Bearer &lt;token&gt;</span></label>
        <div class="row"><input class="input mono" readonly type="password" value="${esc(s.ingest_token)}" id="ingTok">
        <button class="btn secondary" id="showTok">Toon</button><button class="btn secondary" data-copy="ingTok">Kopieer</button></div></div>
      <details style="margin-top:6px"><summary>Instellen in Health Auto Export</summary>
        <ol class="steps-list">
          <li>Automations → nieuwe automatisatie → <b>REST API</b>.</li>
          <li>URL hierboven plakken. Bij Headers: key <span class="mono">Authorization</span>, value <span class="mono">Bearer</span> + spatie + token.</li>
          <li>Data type: <b>Health Metrics</b> (selecteer alles wat je wil) en een tweede automatisatie voor <b>Workouts</b>.</li>
          <li>Export format <b>JSON</b>, versie 2. Aggregate data: <b>aan</b>, interval <b>Hours</b>. Summarize sleep: <b>aan</b>.</li>
          <li>Sync cadence: elk uur (of zo vaak als je wil). Gebruik eerst "Manual export" met een periode om je historiek op te halen (bv. per maand).</li>
        </ol>
      </details>
      <div class="row" style="margin-top:10px"><button class="btn ghost" id="rotTok">Nieuw token maken</button></div>
    </section>

    <section class="panel">
      <h3>Hevy</h3>
      <p class="hint">API-key uit Hevy → Settings → Developer (vereist Hevy Pro). Status: ${s.secrets?.hevy_api_key ? `<span class="ok">ingesteld</span>` : `<span class="warn">niet ingesteld</span>`}
        ${sync.hevy ? ` · laatste sync ${esc(timeAgo(sync.hevy.last_success))}${sync.hevy.last_error ? ` · <span class="warn">${esc(sync.hevy.last_error)}</span>` : ""}` : ""}</p>
      <div class="row"><input class="input" type="password" id="hevyKey" placeholder="${s.secrets?.hevy_api_key ? "•••••••• (opgeslagen)" : "Plak je Hevy API-key"}" autocomplete="off">
        <button class="btn" id="saveHevy">Opslaan</button></div>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="syncNow">Nu synchroniseren</button>
        <button class="btn ghost" id="syncFull">Alles opnieuw ophalen</button>
      </div>
      <p class="hint" style="margin-top:8px">Synchroniseert automatisch elke 30 minuten.</p>
    </section>

    <section class="panel">
      <h3>AI (Claude)</h3>
      <p class="hint">API-key van console.anthropic.com. Status: ${s.secrets?.anthropic_api_key ? `<span class="ok">ingesteld</span>` : `<span class="warn">niet ingesteld</span>`}</p>
      <div class="row"><input class="input" type="password" id="aiKey" placeholder="${s.secrets?.anthropic_api_key ? "•••••••• (opgeslagen)" : "sk-ant-…"}" autocomplete="off">
        <button class="btn" id="saveAi">Opslaan</button></div>
      <div class="field"><label for="model">Model</label>
        <select class="input" id="model">
          ${[["claude-sonnet-5-5", "Claude Sonnet 5.5 (aanbevolen)"], ["claude-opus-5-5", "Claude Opus 5.5 (grondigst, duurder)"], ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (goedkoopst)"]]
            .map(([v, l]) => `<option value="${v}" ${v === model ? "selected" : ""}>${l}</option>`).join("")}
        </select></div>
    </section>

    <section class="panel">
      <h3>Doelen</h3>
      <div class="goals">
        ${[["steps", "Stappen per dag"], ["active_kcal", "Actieve kcal"], ["sleep_h", "Slaap (uren)"], ["kcal_in", "Calorieën (kcal)"], ["protein_g", "Eiwit (g)"]]
          .map(([k, l]) => `<div class="field"><label for="g_${k}">${l}</label><input class="input" inputmode="decimal" id="g_${k}" value="${esc(goals[k] ?? "")}"></div>`).join("")}
      </div>
      <button class="btn" id="saveGoals">Doelen opslaan</button>
    </section>

    <section class="panel">
      <h3>Data</h3>
      <dl class="kv">
        <dt>Metingen (Apple Health)</dt><dd>${fmt(c.samples)}</dd>
        <dt>Slaapnachten</dt><dd>${fmt(c.sleep_nights)}</dd>
        <dt>Workouts (Apple Health)</dt><dd>${fmt(c.workouts)}</dd>
        <dt>Hevy-trainingen</dt><dd>${fmt(c.hevy_workouts)}</dd>
        <dt>Eerste dag</dt><dd>${c.first_day ? esc(dayLabel(c.first_day, { day: "numeric", month: "short", year: "numeric" })) : "–"}</dd>
      </dl>
      <details style="margin-top:12px"><summary>Synclogboek</summary>
        <table class="nutrients">${(s.log || []).map((l) => `<tr><td>${esc(l.source)} <span class="muted small">${esc(timeAgo(l.received_at))}</span></td>
          <td class="small">${l.error ? `<span class="warn">${esc(l.error)}</span>` : esc(Object.entries(l.stats || {}).map(([k, v]) => `${k}: ${v}`).join(", "))}</td></tr>`).join("")}</table>
      </details>
    </section>

    <section class="panel">
      <h3>Account</h3>
      <p class="hint">Ingelogd als ${esc(user?.email)}</p>
      <button class="btn ghost" id="logout">Uitloggen</button>
    </section>`;

  view.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async () => {
    const inp = $("#" + b.dataset.copy);
    try { await navigator.clipboard.writeText(inp.value); toast("Gekopieerd"); }
    catch { inp.type = "text"; inp.select(); toast("Selecteer en kopieer handmatig"); }
  }));
  $("#showTok").onclick = () => { const i = $("#ingTok"); i.type = i.type === "password" ? "text" : "password"; };
  $("#rotTok").onclick = async () => {
    if (!confirm("Nieuw token maken? Je moet het daarna ook in Health Auto Export aanpassen.")) return;
    const t = await rpc("rotate_ingest_token");
    $("#ingTok").value = t;
    toast("Nieuw token aangemaakt");
  };
  const saveSecret = async (name, inputId) => {
    const v = $(inputId).value.trim();
    if (!v) return toast("Plak eerst een sleutel");
    await rpc("set_secret", { p_name: name, p_value: v });
    $(inputId).value = "";
    toast("Sleutel opgeslagen");
    renderSettings();
  };
  $("#saveHevy").onclick = () => saveSecret("hevy_api_key", "#hevyKey").catch((e) => toast(e.message));
  $("#saveAi").onclick = () => saveSecret("anthropic_api_key", "#aiKey").catch((e) => toast(e.message));
  $("#syncNow").onclick = () => syncHevy($("#syncNow"), false, renderSettings);
  $("#syncFull").onclick = () => syncHevy($("#syncFull"), true, renderSettings);
  $("#model").onchange = async (e) => { await rpc("set_setting", { p_key: "ai_model", p_value: e.target.value }); toast("Model opgeslagen"); };
  $("#saveGoals").onclick = async () => {
    const out = {};
    for (const k of ["steps", "active_kcal", "sleep_h", "kcal_in", "protein_g"]) {
      const v = num(String($("#g_" + k).value).replace(",", "."));
      if (v !== null) out[k] = v;
    }
    await rpc("set_setting", { p_key: "goals", p_value: out });
    toast("Doelen opgeslagen");
  };
  $("#logout").onclick = async () => { await sb.auth.signOut(); location.hash = ""; boot(); };
}

// ======================================================================
// Login
// ======================================================================
function renderLogin(msg = "") {
  $("#topbar").hidden = true;
  $("#tabbar").hidden = true;
  $(".composer")?.remove();
  let mode = "login";
  const draw = () => {
    view.innerHTML = `<div class="login">
      <div class="stripe" aria-hidden="true"><i style="background:var(--move)"></i><i style="background:var(--sleep)"></i><i style="background:var(--fuel)"></i><i style="background:var(--strength)"></i><i style="background:var(--heart)"></i></div>
      <h1 class="mark"><span>Health</span><span>Hub</span></h1>
      <p>Training, slaap, voeding en herstel op één plek.</p>
      <form id="lf">
        <div class="field"><label for="em">E-mail</label><input class="input" id="em" type="email" autocomplete="email" required></div>
        <div class="field"><label for="pw">Wachtwoord</label><input class="input" id="pw" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="8" required></div>
        <div class="error" id="err">${esc(msg)}</div>
        <button class="btn" style="width:100%" id="go">${mode === "login" ? "Inloggen" : "Account aanmaken"}</button>
      </form>
      <button class="link-btn" id="sw">${mode === "login" ? "Eerste keer? Account aanmaken" : "Ik heb al een account"}</button>
    </div>`;
    $("#sw").onclick = () => { mode = mode === "login" ? "signup" : "login"; msg = ""; draw(); };
    $("#lf").onsubmit = async (e) => {
      e.preventDefault();
      const email = $("#em").value.trim(), password = $("#pw").value;
      $("#go").disabled = true;
      $("#err").textContent = "";
      try {
        if (mode === "login") {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
          boot();
        } else {
          const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
          if (error) throw error;
          if (data.session) boot();
          else { mode = "login"; msg = ""; draw(); $("#err").innerHTML = `<span class="ok">Account aangemaakt. Bevestig via de mail die je kreeg en log daarna in.</span>`; }
        }
      } catch (er) {
        const m = er.message || String(er);
        $("#err").textContent = /Invalid login/.test(m) ? "E-mail of wachtwoord klopt niet." : /not confirmed/i.test(m) ? "Bevestig eerst je e-mailadres via de mail die je kreeg." : m;
        $("#go").disabled = false;
      }
    };
  };
  draw();
}

// ======================================================================
// Opstart
// ======================================================================
const ROUTES = {
  vandaag: renderToday,
  training: renderTraining,
  voeding: renderNutrition,
  trends: renderTrends,
  vraag: renderAsk,
  instellingen: renderSettings,
};

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  let owner = false;
  try { owner = await rpc("am_i_owner"); } catch { owner = false; }
  if (!owner) {
    await sb.auth.signOut();
    return renderLogin("Dit account heeft geen toegang. Alleen de eigenaar kan inloggen.");
  }
  $("#topbar").hidden = false;
  $("#tabbar").hidden = false;
  route();
}

$("#settingsBtn").onclick = () => (location.hash = "#/instellingen");
window.addEventListener("hashchange", () => { if (!$("#tabbar").hidden) route(); });
sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT" && !$("#tabbar").hidden) renderLogin(); });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

boot();
