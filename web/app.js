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

function toast(msg, ms = 2600, action = null) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ""}`;
  if (action) t.querySelector(".toast-btn").onclick = () => { t.classList.remove("show"); action.run(); };
  t.classList.toggle("has-action", !!action);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), action ? Math.max(ms, 5000) : ms);
}

// Snel loggen (water, cafeïne, gewicht) met ongedaan maken
async function quickLog(metric, value, label, after) {
  try {
    const r = await rpc("log_entry", { p_metric: metric, p_value: value });
    toast(label, 5000, {
      label: "Ongedaan maken",
      run: async () => { await rpc("void_entry", { p_metric: metric, p_ts: r.ts }); toast("Ongedaan gemaakt"); after?.(); },
    });
    after?.();
  } catch (e) {
    toast(e.message, 4000);
  }
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

// Gedeelde helpers voor de modules training (workout.js) en voeding (food.js)
const ctx = { rpc, invoke, toast, fmt, esc, view, today, addDays, shortDate, mountChart, SUPABASE_URL,
  importAppleHealth: (...a) => importAppleHealth(...a) };
const workoutMod = () => import("./workout.js");
const foodMod = () => import("./food.js");
const moreMod = () => import("./more.js");
// Datumknop in de dagnavigatie: opent de agenda
const calBtn = (label) => `<button class="label calbtn" id="calBtn" aria-label="Kies een dag in de agenda"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 7h16v13H4zM4 11h16M8 3v4M16 3v4"/></svg>${esc(label)}</button>`;
async function bindCal(current, onPick) {
  $("#calBtn")?.addEventListener("click", async () => (await moreMod()).openCalendar(ctx, { current, onPick }));
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
  const present = [...vals, ...points.map((p) => num(p.dot))].filter((v) => v !== null);
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
    // losse metingen (bv. dagelijkse wegingen rond de trendlijn)
    points.forEach((p, i) => { const v = num(p.dot); if (v !== null) svg += `<circle cx="${x(i)}" cy="${y(v)}" r="2.6" fill="${color}" opacity=".35"/>`; });
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
    tip.innerHTML = `${esc(p.tip ?? shortDate(p.x))}<br><b>${v === null ? "geen data" : esc(f(v)) + (unit ? " " + esc(unit) : "")}</b>${p.tip2 ? `<br><span>${esc(p.tip2)}</span>` : ""}`;
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
const TITLES = { vandaag: "Vandaag", training: "Training", voeding: "Voeding", trends: "Trends", vraag: "Vraag het", instellingen: "Instellingen", dagboek: "Dagboek", workout: "Training", koppelen: "Koppelen" };
const ACCENT = { workout: "--strength", dagboek: "--sleep", vandaag: "--move", training: "--strength", voeding: "--fuel", trends: "--heart", vraag: "--sleep" };

async function route() {
  let [name, param] = (location.hash.replace(/^#\/?/, "") || "vandaag").split("/");
  if (name === "log") { state.openWeight = param === "gewicht"; state.day = today(); name = "vandaag"; }
  const fn = ROUTES[name] || ROUTES.vandaag;
  $("#title").textContent = TITLES[name] || "Vandaag";
  document.querySelectorAll(".tabbar a").forEach((a) => {
    if (a.dataset.tab === (name === "workout" ? "training" : name)) {
      a.setAttribute("aria-current", "page");
      a.style.setProperty("--accent", `var(${ACCENT[name]})`);
    } else a.removeAttribute("aria-current");
  });
  document.body.dataset.route = name;
  $(".composer")?.remove();
  document.querySelectorAll(".sheet").forEach((el) => (el._close ? el._close() : el.remove()));
  view.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
  window.scrollTo(0, 0);
  try {
    await fn(param);
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
    det.innerHTML = (rows ? `<table>${rows}</table>` : `<p class="muted small">Geen sets gevonden.</p>`)
      + `<button class="linkbtn wdelw" style="color:var(--bad);margin-top:6px">Training verwijderen</button>`;
    det.querySelector(".wdelw").onclick = async () => {
      if (!confirm("Deze training verwijderen? (Een nieuwe Hevy-import kan ze terugzetten als ze daar nog staat.)")) return;
      await rpc("remove_workout", { p_id: btn.dataset.id });
      toast("Training verwijderd");
      route();
    };
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
  const [d, meas] = await Promise.all([rpc("get_dashboard", { p_day: state.day }), rpc("get_measurements").catch(() => ({}))]);
  const t = d.today || {};
  const a = d.avg7 || {};
  const g = d.goals || {};
  const isToday = state.day === today();
  const nothing = !d.series?.length && !d.recent?.length;
  const water = num(t.water_ml) || 0;
  const caff = num(t.caffeine_mg) || 0;
  const acts = d.day_activities || [];
  const ins = d.insight;
  let activeWorkout = null;
  try { activeWorkout = JSON.parse(localStorage.getItem("hh_active_workout") || "null"); } catch { /* */ }

  view.innerHTML = `
    <div class="daynav">
      <button id="prev" aria-label="Vorige dag">‹</button>
      ${calBtn(dayLabel(state.day))}
      <button id="next" aria-label="Volgende dag" ${isToday ? "disabled" : ""}>›</button>
    </div>
    ${nothing ? onboardingCard() : !d.sync?.apple_health?.last_success && isToday ? `<a class="panel lk-cta" href="#/koppelen">
        <span><b>Koppel Apple Gezondheid</b><br><span class="small muted">Stappen, slaap, hartslag en je Garmin-workouts binnenhalen. Stap voor stap, gratis.</span></span><span aria-hidden="true">›</span></a>` : ""}
    ${ins && isToday ? `<section class="panel insight ${ins.read_at ? "" : "unread"}">
        <details ${ins.read_at ? "" : "open"} id="insDet"><summary>${esc(ins.title)} <span class="muted small">${esc(shortDate(ins.created_at.slice(0, 10)))}</span></summary>
        <div class="md">${md(ins.content)}</div></details>
      </section>` : ""}
    <div class="board">
      <section class="domain" style="--c:${DOMAIN.move}">
        <h2>Beweging</h2>
        ${statRow({ name: "Stappen", value: t.steps, goal: g.steps, avg: a.steps, color: DOMAIN.move })}
        ${statRow({ name: "Actieve energie", value: t.active_kcal, unit: "kcal", goal: g.active_kcal, avg: a.active_kcal, color: DOMAIN.move })}
      </section>

      <section class="domain" style="--c:${DOMAIN.strength}">
        <h2>Training ${isToday ? "vandaag" : "deze dag"}</h2>
        ${acts.length ? `<div class="list flat" id="dayActs">${acts.map(activityItem).join("")}</div>`
          : `<p class="muted small" style="margin:6px 0 12px">Rustdag, nog geen training ${isToday ? "vandaag" : ""} geregistreerd.</p>`}
        ${isToday ? `<a class="btn secondary" href="#/training" style="display:inline-block;text-decoration:none;margin-bottom:12px">${activeWorkout ? "Training hervatten" : "Training starten"}</a>` : ""}
      </section>

      <section class="domain" style="--c:${DOMAIN.fuel}">
        <h2>Voeding</h2>
        ${statRow({ name: "Calorieën", value: t.kcal_in, unit: "kcal", goal: g.kcal_in, avg: a.kcal_in, color: DOMAIN.fuel })}
        ${statRow({ name: "Eiwit", value: t.protein_g, unit: "g", goal: g.protein_g, avg: a.protein_g, color: DOMAIN.fuel })}
        ${statRow({ name: "Koolhydraten", value: t.carbs_g, unit: "g", goal: g.carbs_g, avg: a.carbs_g, color: DOMAIN.fuel })}
        ${statRow({ name: "Vet", value: t.fat_g, unit: "g", goal: g.fat_g, avg: a.fat_g, color: DOMAIN.fuel })}
        <button class="btn secondary" id="addFood" style="margin:4px 0 12px">+ Voeding toevoegen</button>
      </section>

      <section class="domain" style="--c:${DOMAIN.heart}">
        <h2>Drinken</h2>
        <div class="quick">
          <div>
            <div class="name">Water</div>
            <div class="num">${fmt(water / 1000, 1)}<small>/ ${fmt((g.water_ml || 2500) / 1000, 1)} L</small></div>
            <div class="bar" aria-hidden="true" style="--c:${DOMAIN.heart}"><i style="width:${Math.min(100, (water / (g.water_ml || 2500)) * 100)}%"></i></div>
          </div>
          ${isToday ? `<button class="btn quick-btn" id="addWater" style="--c:${DOMAIN.heart}">+500 ml</button>` : ""}
        </div>
        <div class="quick">
          <div>
            <div class="name">Cafeïne</div>
            <div class="num">${fmt(caff)}<small>/ ${fmt(g.caffeine_mg || 400)} mg</small></div>
            <div class="bar" aria-hidden="true" style="--c:${caff > (g.caffeine_mg || 400) ? "var(--bad)" : DOMAIN.fuel}"><i style="width:${Math.min(100, (caff / (g.caffeine_mg || 400)) * 100)}%"></i></div>
          </div>
          ${isToday ? `<button class="btn quick-btn" id="addCaff" style="--c:${DOMAIN.fuel}">+50 mg</button>` : ""}
        </div>
      </section>

      <section class="domain" style="--c:${DOMAIN.move}">
        <h2>Gewoontes</h2>
        <div id="habitBox"></div>
      </section>

      <section class="domain" style="--c:${DOMAIN.sleep}">
        <h2>Herstel</h2>
        ${statRow({ name: "Slaap", value: t.sleep_h, display: t.sleep_h == null ? null : hours(t.sleep_h), goal: g.sleep_h, avg: a.sleep_h, color: DOMAIN.sleep })}
        ${t.deep_sleep_h != null ? `<div class="sub muted small" style="margin:-6px 0 8px">Diep ${hours(t.deep_sleep_h)} · REM ${hours(t.rem_sleep_h)}</div>` : ""}
        ${statRow({ name: "Rusthartslag", value: t.resting_hr, unit: "bpm", avg: a.resting_hr, color: DOMAIN.heart, higherIsBetter: false })}
        ${statRow({ name: "HRV", value: t.hrv_ms, unit: "ms", avg: a.hrv_ms, color: DOMAIN.heart })}
      </section>

      <section class="domain" style="--c:${DOMAIN.move}">
        <h2>Lichaam</h2>
        ${statRow({
          name: t.weight_kg != null ? "Gewicht" : `Gewicht${d.last_weight ? ` (${shortDate(d.last_weight.day)})` : ""}`,
          value: t.weight_kg ?? d.last_weight?.kg, unit: "kg", dec: 1, color: DOMAIN.move,
        })}
        ${meas.waist_circumference ? `<div class="sub muted small" style="margin:-4px 0 8px">Taille ${fmt(meas.waist_circumference.points.at(-1).value, 1)} cm (${esc(shortDate(meas.waist_circumference.points.at(-1).day))})${meas.body_fat_percentage ? ` · vet ${fmt(meas.body_fat_percentage.points.at(-1).value, 1)}%` : ""}</div>` : ""}
        <div id="weightBox">${isToday ? `<div class="row" style="margin:4px 0 12px"><button class="btn secondary" id="logWeight">Gewicht loggen</button><button class="btn ghost" id="logMeas">Alle maten</button></div>` : ""}</div>
      </section>

      <section class="domain" style="--c:${DOMAIN.sleep}">
        <h2>Dagboek</h2>
        ${d.journal ? `<p class="journal-snip">${esc(d.journal.length > 220 ? d.journal.slice(0, 220) + "…" : d.journal)}</p>`
          : `<p class="muted small" style="margin:6px 0 8px">${isToday ? "Hoe was je dag? Spreek het in of typ het." : "Geen dagboek voor deze dag."}</p>`}
        <a class="btn secondary" href="#/dagboek/${state.day}" style="display:inline-block;text-decoration:none;margin-bottom:12px">${d.journal ? "Openen" : "Vertel over je dag"}</a>
      </section>
    </div>

    <p class="muted small" style="margin-top:18px">
      <a href="#/koppelen">Apple Health: ${esc(timeAgo(d.sync?.apple_health?.last_success))}</a>
      ${d.sync?.hevy_csv ? ` · Hevy-import: ${esc(timeAgo(d.sync.hevy_csv.last_success))}` : ""}
    </p>`;

  const reload = () => renderToday();
  bindCal(state.day, (d) => { state.day = d; renderToday(); });
  moreMod().then((M) => M.renderHabits(ctx, state.day, $("#habitBox"))).catch(() => {});
  $("#logMeas")?.addEventListener("click", async () => (await moreMod()).openMeasurements(ctx, {
    last: { weight_body_mass: d.last_weight?.kg, ...Object.fromEntries(Object.entries(meas).map(([k, v]) => [k, v.points.at(-1)?.value])) }, after: reload }));
  $("#prev").onclick = () => { state.day = addDays(state.day, -1); renderToday(); };
  $("#next").onclick = () => { if (!isToday) { state.day = addDays(state.day, 1); renderToday(); } };
  if ($("#dayActs")) bindActivityList($("#dayActs"));
  $("#addWater")?.addEventListener("click", () => quickLog("dietary_water", 500, "500 ml water gelogd", reload));
  $("#addCaff")?.addEventListener("click", () => quickLog("dietary_caffeine", 50, "50 mg cafeïne gelogd", reload));
  $("#logWeight")?.addEventListener("click", () => openWeightForm(d.last_weight?.kg));
  $("#addFood").onclick = async () => (await foodMod()).openAddFood(ctx, { day: state.day, after: reload });
  $("#insDet")?.addEventListener("toggle", (e) => { if (e.target.open && !ins.read_at) rpc("mark_insight_read", { p_id: ins.id }).catch(() => {}); });
  if (ins && !ins.read_at && isToday) rpc("mark_insight_read", { p_id: ins.id }).catch(() => {});
  if (state.openWeight) { state.openWeight = false; openWeightForm(d.last_weight?.kg); }
}

function openWeightForm(last) {
  const box = $("#weightBox");
  if (!box) return;
  box.innerHTML = `<form class="row" id="wf" style="margin:4px 0 12px">
      <input class="input" id="wv" type="number" inputmode="decimal" step="0.1" min="20" max="400" placeholder="kg" value="${last ?? ""}" aria-label="Gewicht in kg" style="max-width:140px">
      <button class="btn" type="submit">Opslaan</button>
      <button class="btn ghost" type="button" id="wc">Annuleren</button>
    </form>`;
  const inp = $("#wv");
  inp.focus();
  inp.select();
  $("#wc").onclick = () => renderToday();
  $("#wf").onsubmit = (e) => {
    e.preventDefault();
    const v = num(String(inp.value).replace(",", "."));
    if (!v) return toast("Vul een gewicht in");
    quickLog("weight_body_mass", v, `${fmt(v, 1)} kg gelogd`, () => renderToday());
  };
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function onboardingCard() {
  return `<div class="panel" style="margin-bottom:12px">
    <h3>Welkom! Nog geen data binnen.</h3>
    <p class="hint">Koppel Apple Health in Instellingen (gratis: export importeren en de Opdrachten-automatisering) en importeer je Hevy-trainingen.</p>
    <a class="btn" href="#/koppelen" style="display:inline-block;text-decoration:none">Koppel-assistent openen</a>
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
        <button data-t="muscles" aria-pressed="${tab === "muscles"}">Spiergroepen</button>
      </div>
      <label class="btn ghost" style="margin-bottom:14px;cursor:pointer">Hevy importeren<input type="file" id="hevyCsv" accept=".csv,text/csv" hidden></label>
    </div>
    <div id="wstart"></div>
    <div id="tcontent"><div class="skeleton"></div></div>`;
  if (tab === "workouts") renderWorkoutStart($("#wstart"));
  view.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { state.trainTab = b.dataset.t; renderTraining(); }));
  $("#hevyCsv").onchange = (e) => importHevyFile(e.target.files?.[0], renderTraining);
  const box = $("#tcontent");

  if (tab === "muscles") return renderMuscles(box);
  if (tab === "workouts") {
    const list = await rpc("get_activities", { p_limit: 60, p_offset: 0 });
    box.innerHTML = list.length
      ? `<div class="list" id="acts">${list.map(activityItem).join("")}</div>`
      : `<div class="empty"><strong>Nog geen trainingen.</strong>Cardio komt binnen via Apple Health. Krachttraining: exporteer in Hevy (Profiel → Instellingen → Export &amp; Import Data → Export workouts) en tik op "Hevy importeren".</div>`;
    if (list.length) bindActivityList($("#acts"));
  } else {
    const [ex, W] = await Promise.all([rpc("get_exercises"), workoutMod()]);
    if (!ex.length) {
      box.innerHTML = `<div class="empty"><strong>Nog geen oefeningen.</strong>Importeer je Hevy-export om je progressie per oefening te zien.</div>`;
      return;
    }
    box.innerHTML = `<div class="list" id="exlist">${ex
      .map((e) => `<button class="item" style="--c:${DOMAIN.strength}" data-ex="${esc(e.exercise)}">
        <span class="swatch"></span>
        <span><div class="t">${esc(e.exercise)}</div><div class="m">${fmt(e.sessions)}× · laatst ${esc(shortDate(e.last_day))}${e.muscle ? ` · ${esc(W.MUSCLES[e.muscle] || e.muscle)}` : ""}</div></span>
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
      det.innerHTML = `<button class="linkbtn exset" style="margin-top:6px">⚙ Spiergroep, herhalingsbereik en stap</button>
        <p class="small muted" style="margin:8px 0 4px">${hasRm ? "Geschatte 1RM per training (kg)" : "Zwaarste set per training (kg)"}</p><div class="c"></div>
        <table style="margin-top:8px">${hist.slice(-5).reverse()
          .map((h) => `<tr><td>${esc(shortDate(h.day))}</td><td>${h.top_kg != null ? `${fmt(h.top_kg, 1)} kg × ${h.top_reps ?? "–"}` : `${fmt(h.sets)} sets`}</td></tr>`).join("")}</table>`;
      det.querySelector(".exset").onclick = async () => (await workoutMod()).editExercisePref(ctx, b.dataset.ex, renderTraining);
      mountChart(det.querySelector(".c"), {
        points: hist.map((h) => ({ x: h.day, y: hasRm ? h.best_1rm : h.top_kg })),
        color: DOMAIN.strength, type: "line", unit: "kg", dec: 1, zero: false, height: 140,
      });
    });
  }
}

// ---------- Werksets per spiergroep ----------
async function renderMuscles(box) {
  const [rows, W] = await Promise.all([rpc("get_muscle_volume", { p_weeks: 4 }), workoutMod()]);
  const weekStart = (() => { const d = new Date(today() + "T12:00:00Z"); const wd = (d.getUTCDay() + 6) % 7; return addDays(today(), -wd); })();
  const muscles = {};
  for (const r of rows) {
    const m = (muscles[r.muscle] ||= { cur: 0, prev: 0 });
    if (r.week_start === weekStart) m.cur += Number(r.working_sets);
    else m.prev += Number(r.working_sets) / 4;
  }
  const list = Object.entries(muscles).filter(([k]) => k !== "other").sort((a, b) => b[1].prev - a[1].prev || b[1].cur - a[1].cur);
  if (!list.length) { box.innerHTML = `<div class="empty"><strong>Nog geen trainingen in de laatste weken.</strong></div>`; return; }
  const scaleMax = Math.max(22, ...list.map(([, v]) => Math.max(v.cur, v.prev)));
  const pct = (v) => (v / scaleMax) * 100;
  const dayNo = (new Date(today() + "T12:00:00Z").getUTCDay() + 6) % 7 + 1;
  box.innerHTML = `<section class="panel">
      <h3>Werksets per spiergroep</h3>
      <p class="hint">Balk = deze week (dag ${dayNo} van 7) · streep = gemiddelde van de 4 weken ervoor. Groene zone: 10–20 sets per week, vaak aangeraden voor spiergroei.</p>
      ${list.map(([k, v]) => `<div class="mv">
        <div class="mv-h"><span>${esc(W.MUSCLES[k] || k)}</span><span><b>${fmt(v.cur)}</b> <span class="muted">· gem. ${fmt(v.prev, 1)}</span></span></div>
        <div class="mv-bar"><i class="zone" style="left:${pct(10)}%;width:${pct(20) - pct(10)}%"></i><i class="cur" style="width:${pct(v.cur)}%"></i><i class="avg" style="left:${pct(v.prev)}%"></i></div>
      </div>`).join("")}
      <p class="small muted" style="margin:10px 0 0">Spiergroep klopt niet? Tik in Oefeningen op de oefening → ⚙.</p>
    </section>`;
}

// ---------- Training starten: leeg, schema of herhalen ----------
async function renderWorkoutStart(box) {
  const W = await workoutMod();
  const active = W.activeWorkout();
  if (active) {
    box.innerHTML = `<section class="panel wstart" style="--c:${DOMAIN.strength}">
      <h3>${esc(active.title)} loopt</h3>
      <p class="hint">Gestart om ${new Date(active.start).toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" })} · ${active.exercises.length} oefeningen</p>
      <a class="btn" href="#/workout" style="display:inline-block;text-decoration:none">Training hervatten</a></section>`;
    return;
  }
  const [tpls, last] = await Promise.all([rpc("get_templates").catch(() => []), rpc("get_activities", { p_limit: 15, p_offset: 0 }).catch(() => [])]);
  const lastStrength = last.filter((a) => a.kind === "strength").slice(0, 3);
  box.innerHTML = `<section class="panel wstart" style="--c:${DOMAIN.strength}">
      <button class="btn" id="wEmpty" style="width:100%">Lege training starten</button>
      <div class="sub-h" style="display:flex;justify-content:space-between;align-items:center">Schema's <button class="linkbtn" id="tplNew">+ Nieuw schema</button></div>
      ${tpls.length ? tpls.map((t, i) => `<div class="tpl" data-i="${i}">
          <button class="tpl-main" data-act="start"><b>${esc(t.name)}</b><span class="small muted">${esc((t.exercises || []).map((e) => e.title).slice(0, 4).join(", "))}${t.exercises?.length > 4 ? "…" : ""}</span></button>
          <button class="icon-btn" data-act="edit" aria-label="${esc(t.name)} bewerken">✎</button></div>`).join("")
        : `<p class="muted small" style="margin:4px 0">Nog geen schema's. Maak er een, of bewaar een training als schema na het afronden.</p>`}
      ${lastStrength.length ? `<div class="sub-h">Herhaal een recente training</div><div class="chips">${lastStrength.map((a) =>
        `<button class="chip" data-repeat="${esc(a.id)}">${esc(a.title || "Training")} · ${esc(shortDate(a.day))}</button>`).join("")}</div>` : ""}
    </section>`;
  $("#wEmpty").onclick = () => W.startWorkout(ctx);
  $("#tplNew").onclick = () => W.editTemplate(ctx, null, renderTraining);
  box.querySelectorAll(".tpl").forEach((row) => {
    const t = tpls[Number(row.dataset.i)];
    row.querySelector('[data-act="start"]').onclick = () => W.startWorkout(ctx, { template: t });
    row.querySelector('[data-act="edit"]').onclick = () => W.editTemplate(ctx, t, renderTraining);
  });
  box.querySelectorAll("[data-repeat]").forEach((b) => (b.onclick = () => W.startWorkout(ctx, { repeatOf: b.dataset.repeat })));
}

// ---------- Hevy CSV-import (werkt zonder Hevy Pro) ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  mrt: 3, mei: 5, okt: 10 };
function zonedToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(guess));
  const g = (k) => Number(parts.find((p) => p.type === k).value);
  const asTz = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return new Date(guess - (asTz - guess)).toISOString();
}
function parseHevyDate(s) {
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (m && MONTHS[m[2].toLowerCase()]) return zonedToUtc(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return /Z|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s).toISOString() : zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

function hevyCsvToWorkouts(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) throw new Error("Leeg bestand");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  const need = ["title", "start_time", "exercise_title"];
  for (const n of need) if (col(n) < 0) throw new Error(`Dit lijkt geen Hevy-export (kolom "${n}" ontbreekt)`);
  const v = (r, name) => { const i = col(name); return i < 0 ? "" : (r[i] ?? "").trim(); };
  const n = (x) => (x === "" ? null : Number(String(x).replace(",", ".")));
  const map = new Map();
  for (const r of rows.slice(1)) {
    const key = `${v(r, "title")}|${v(r, "start_time")}`;
    const start = parseHevyDate(v(r, "start_time"));
    if (!start) continue;
    if (!map.has(key)) {
      map.set(key, { id: "csv-" + hash(key), title: v(r, "title"), description: v(r, "description"),
        start_time: start, end_time: parseHevyDate(v(r, "end_time")) || start, exercises: [], _ex: new Map() });
    }
    const w = map.get(key);
    const exKey = `${v(r, "exercise_title")}|${v(r, "superset_id")}`;
    if (!w._ex.has(exKey)) {
      const ex = { index: w.exercises.length, title: v(r, "exercise_title"), notes: v(r, "exercise_notes"),
        superset_id: v(r, "superset_id") || null, exercise_template_id: null, sets: [] };
      w._ex.set(exKey, ex);
      w.exercises.push(ex);
    }
    const ex = w._ex.get(exKey);
    let kg = n(v(r, "weight_kg"));
    if (kg === null && col("weight_lbs") >= 0) { const lb = n(v(r, "weight_lbs")); kg = lb === null ? null : lb * 0.45359237; }
    const km = n(v(r, "distance_km"));
    const mi = col("distance_miles") >= 0 ? n(v(r, "distance_miles")) : null;
    ex.sets.push({
      index: n(v(r, "set_index")) ?? ex.sets.length,
      type: v(r, "set_type") || "normal",
      weight_kg: kg, reps: n(v(r, "reps")),
      distance_meters: km !== null ? km * 1000 : mi !== null ? mi * 1609.344 : null,
      duration_seconds: n(v(r, "duration_seconds")), rpe: n(v(r, "rpe")),
    });
  }
  return [...map.values()].map(({ _ex, ...w }) => w);
}

async function importHevyFile(file, after) {
  if (!file) return;
  try {
    const workouts = hevyCsvToWorkouts(await file.text());
    if (!workouts.length) throw new Error("Geen trainingen gevonden in het bestand");
    toast(`Importeren: ${workouts.length} trainingen…`, 10000);
    let done = 0;
    for (let i = 0; i < workouts.length; i += 40) {
      await rpc("import_hevy_workouts", { p: workouts.slice(i, i + 40) });
      done += Math.min(40, workouts.length - i);
    }
    toast(`${done} Hevy-trainingen geïmporteerd`);
    after?.();
  } catch (e) {
    toast(e.message, 6000);
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
  const [d, energy] = await Promise.all([rpc("get_nutrition_day", { p_day: state.nutDay }), rpc("get_energy", { p_days: 28 }).catch(() => null)]);
  const maint = energy?.estimate?.maintenance_kcal;
  const by = Object.fromEntries((d.nutrients || []).map((n) => [n.metric, n]));
  const g = d.goals || {};
  const kcal = num(by.dietary_energy?.value);
  const p = num(by.protein?.value), c = num(by.carbohydrates?.value), f = num(by.total_fat?.value), fib = num(by.fiber?.value);
  const isToday = state.nutDay === today();
  const micros = (d.nutrients || []).filter((n) => !["dietary_energy", "protein", "carbohydrates", "total_fat"].includes(n.metric));
  const macro = (label, v, goal) => `<div class="macro">
      <div class="v">${fmt(v)}<small> g</small></div>
      <div class="l">${label}${goal ? ` / ${fmt(goal)}` : ""}</div>
      ${goal ? `<div class="bar" style="--c:${DOMAIN.fuel}"><i style="width:${Math.min(100, ((v || 0) / goal) * 100)}%"></i></div>` : ""}
    </div>`;

  view.innerHTML = `
    <div class="daynav">
      <button id="prev" aria-label="Vorige dag">‹</button>
      ${calBtn(isToday ? "Vandaag, " + dayLabel(state.nutDay, { day: "numeric", month: "long" }) : dayLabel(state.nutDay))}
      <button id="next" aria-label="Volgende dag" ${isToday ? "disabled" : ""}>›</button>
    </div>
    <section class="domain" style="--c:${DOMAIN.fuel};padding-bottom:16px">
      <h2>Calorieën</h2>
      <div class="hero-num">${fmt(kcal ?? 0)}<small>${g.kcal_in ? `/ ${fmt(g.kcal_in)} ` : ""}kcal</small></div>
      ${g.kcal_in ? `<div class="bar" style="--c:${DOMAIN.fuel}"><i style="width:${Math.min(100, ((kcal || 0) / g.kcal_in) * 100)}%"></i></div>
      <div class="small muted" style="margin-top:6px">${kcal != null && kcal < g.kcal_in ? `Nog ${fmt(g.kcal_in - kcal)} kcal over` : kcal != null ? `${fmt(kcal - g.kcal_in)} kcal boven je doel` : "Nog niets gelogd"}${maint ? ` · je onderhoud ≈ ${fmt(maint)} kcal` : ""}</div>` : ""}
      <div class="macros" style="grid-template-columns:repeat(4,1fr)">
        ${macro("Eiwit", p, g.protein_g)}${macro("Koolh.", c, g.carbs_g)}${macro("Vet", f, g.fat_g)}${macro("Vezels", fib, g.fiber_g)}
      </div>
    </section>
    <button class="btn" id="addFood" style="width:100%;margin:2px 0 12px">+ Voeding toevoegen</button>

    <h2 class="section-title">Gelogd in Health Hub</h2>
    <div class="panel" id="foodLog"><div class="skeleton" style="height:40px"></div></div>

    <div class="row" style="justify-content:space-between;align-items:baseline"><h2 class="section-title">Mijn recepten</h2><button class="linkbtn" id="newRecipe">+ Nieuw recept</button></div>
    <div class="panel" id="recipes"><div class="skeleton" style="height:30px"></div></div>

    ${kcal !== null ? `<h2 class="section-title">Per moment (alle bronnen)</h2>
    <div class="panel">
      ${(d.meals || []).map((m) => `<div class="meal">
          <span><b>${esc(m.meal)}</b> <span class="muted small">vanaf ${String(m.first_hour).padStart(2, "0")}u</span></span>
          <span class="k">${fmt(m.kcal)} <span class="muted small">kcal</span></span>
          <span class="p">Eiwit ${fmt(m.protein_g)} g · Koolh. ${fmt(m.carbs_g)} g · Vet ${fmt(m.fat_g)} g</span>
        </div>`).join("") || `<p class="muted small">Geen tijdsinfo beschikbaar.</p>`}
      <p class="muted small" style="margin:8px 0 0">Bevat ook voeding uit Apple Health; moment afgeleid uit het uur van loggen.</p>
    </div>

    <h2 class="section-title">Alle voedingsstoffen</h2>
    <div class="panel">
      <details ${micros.length <= 8 ? "open" : ""}>
        <summary>${micros.length} gelogde waarden</summary>
        <table class="nutrients">${micros.map((n) => `<tr><td>${esc(n.label)}</td><td>${fmt(n.value, n.value < 10 ? 1 : 0)} ${esc(n.unit || "")}</td></tr>`).join("")}</table>
      </details>
    </div>` : ""}
  `;
  $("#prev").onclick = () => { state.nutDay = addDays(state.nutDay, -1); renderNutrition(); };
  $("#next").onclick = () => { if (!isToday) { state.nutDay = addDays(state.nutDay, 1); renderNutrition(); } };
  bindCal(state.nutDay, (dd) => { state.nutDay = dd; renderNutrition(); });
  const F = await foodMod();
  $("#addFood").onclick = () => F.openAddFood(ctx, { day: state.nutDay, after: renderNutrition });
  $("#newRecipe").onclick = () => F.openAddFood(ctx, { day: state.nutDay, after: renderNutrition, start: "recipe" });
  await Promise.all([F.renderFoodLog(ctx, state.nutDay, $("#foodLog"), renderNutrition), F.renderRecipes(ctx, state.nutDay, $("#recipes"), renderNutrition)]);
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
  const [range, dash, energy, meas] = await Promise.all([
    rpc("get_range", { p_from: from, p_to: to }), rpc("get_dashboard", { p_day: to }), rpc("get_energy", { p_days: 28 }).catch(() => null),
    rpc("get_measurements").catch(() => ({}))]);
  const rows = fillDays(range, from, to);
  const g = dash.goals || {};
  const trendBy = Object.fromEntries((energy?.series || []).map((r) => [r.day, r.trend]));
  const byWeek = days > 90;

  const charts = [
    { key: "steps", title: "Stappen", color: DOMAIN.move, type: "bar", goal: g.steps },
    { key: "active_kcal", title: "Actieve energie", unit: "kcal", color: DOMAIN.move, type: "bar" },
    { key: "sleep_h", title: "Slaap", unit: "u", color: DOMAIN.sleep, type: "bar", dec: 1, goal: g.sleep_h },
    { key: "resting_hr", title: "Rusthartslag", unit: "bpm", color: DOMAIN.heart, type: "line", zero: false },
    { key: "hrv_ms", title: "HRV", unit: "ms", color: DOMAIN.heart, type: "line", zero: false },
    { key: "weight_kg", title: "Gewicht (trend)", unit: "kg", color: DOMAIN.heart, type: "line", zero: false, dec: 1, trend: true },
    { key: "kcal_in", title: "Calorieën gegeten", unit: "kcal", color: DOMAIN.fuel, type: "bar", goal: g.kcal_in },
    { key: "protein_g", title: "Eiwit", unit: "g", color: DOMAIN.fuel, type: "bar", goal: g.protein_g },
    { key: "strength_volume_kg", title: "Krachtvolume per week", unit: "kg", color: DOMAIN.strength, type: "bar", forceWeek: true, how: "sum" },
  ];

  view.innerHTML = `
    <div class="seg" role="group" aria-label="Periode">
      ${[30, 90, 365].map((n) => `<button data-d="${n}" aria-pressed="${n === days}">${n === 365 ? "1 jaar" : n + " dagen"}</button>`).join("")}
    </div>
    ${energyPanel(energy)}
    ${charts.map((c, i) => `<section class="panel">
        <div class="chart-head"><h3>${esc(c.title)}</h3><span class="now" id="avg${i}"></span></div>
        <div id="ch${i}"></div>
      </section>`).join("")}
    <div id="measCharts"></div>
    <p class="muted small">${byWeek ? "Bij 1 jaar tonen de grafieken weekgemiddelden." : "Tik of beweeg over een grafiek voor de exacte waarde."}</p>`;
  view.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { state.trendDays = Number(b.dataset.d); renderTrends(); }));

  charts.forEach((c, i) => {
    const week = byWeek || c.forceWeek;
    const pts = c.trend && !byWeek
      ? rows.map((r) => ({ x: r.day, y: trendBy[r.day] ?? null, dot: r.weight_kg,
          tip2: r.weight_kg != null ? `gewogen ${fmt(r.weight_kg, 1)} kg` : "" }))
      : week ? weekly(rows, c.key, c.how || "avg") : rows.map((r) => ({ x: r.day, y: r[c.key] }));
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

  // lichaamsmaten (alle metingen, niet beperkt tot de gekozen periode)
  const mlist = Object.entries(meas).filter(([, v]) => v.points?.length);
  $("#measCharts").innerHTML = mlist.map(([k, v], i) => {
    const pts = v.points, last = pts.at(-1), first = pts[0];
    const diff = pts.length > 1 ? last.value - first.value : null;
    return `<section class="panel"><div class="chart-head"><h3>${esc(v.label)}</h3>
      <span class="now">${fmt(last.value, 1)}<small>${esc(v.unit)}${diff != null ? ` · ${diff > 0 ? "+" : diff < 0 ? "−" : ""}${fmt(Math.abs(diff), 1)} sinds ${esc(shortDate(first.day))}` : ""}</small></span></div>
      <div id="mc${i}"></div></section>`;
  }).join("");
  mlist.forEach(([, v], i) => mountChart($(`#mc${i}`), {
    points: v.points.map((p) => ({ x: p.day, y: p.value })), color: DOMAIN.move, type: "line", unit: v.unit, dec: 1, zero: false, height: 120 }));
}

// Energiebalans: echt onderhoud uit inname + gewichtstrend
function energyPanel(e) {
  const est = e?.estimate;
  if (!est) return "";
  const signed = (v, dec = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), dec);
  if (est.maintenance_kcal == null) {
    return `<section class="panel energy" style="--c:${DOMAIN.fuel}">
      <h3>Energiebalans</h3>
      <p class="hint" style="margin:4px 0 0">Nog niet te berekenen. ${esc(est.note)}</p>
      <p class="small muted" style="margin:6px 0 0">Nodig over 28 dagen: voeding op minstens 14 dagen en een paar wegingen per week. Dan berekent de app je echte onderhoud uit wat je eet en hoe je gewicht evolueert.</p>
    </section>`;
  }
  const conf = { hoog: "betrouwbaar", redelijk: "redelijk", laag: "ruwe schatting" }[est.confidence] || est.confidence;
  return `<section class="panel energy" style="--c:${DOMAIN.fuel}">
      <div class="chart-head"><h3>Je onderhoud</h3><span class="pill ${esc(est.confidence)}">${esc(conf)}</span></div>
      <div class="hero-num" style="font-size:52px;margin-top:2px">${fmt(est.maintenance_kcal)}<small>kcal/dag</small></div>
      <div class="egrid">
        <div><b>${fmt(est.avg_intake_kcal)}</b><span>gem. gegeten</span></div>
        <div><b>${signed(est.weekly_change_kg)}</b><span>kg/week (trend)</span></div>
        ${est.device_estimate_kcal ? `<div><b>${fmt(est.device_estimate_kcal)}</b><span>schatting horloge</span></div>` : ""}
      </div>
      ${e.goal_kcal && e.expected_weekly_change_kg != null ? `<p class="small" style="margin:10px 0 0">Met je doel van ${fmt(e.goal_kcal)} kcal verwacht je <b>${signed(e.expected_weekly_change_kg)} kg per week</b>.</p>` : ""}
      <p class="small muted" style="margin:6px 0 0">Laatste 28 volledige dagen (${esc(shortDate(est.window_start))} – ${esc(shortDate(est.window_end))}): ${est.logged_days} dagen gelogd, ${est.weigh_ins} wegingen. ${esc(est.note)}</p>
    </section>`;
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
    <details class="sources"><summary>${qs.some((q) => q.summary) ? qs.filter((q) => q.summary).map((q) => esc(q.summary)).join(" · ") : `Gebaseerd op ${qs.length} opzoeking${qs.length > 1 ? "en" : ""} in je data`}</summary>
      <ul>${qs.map((q) => `<li>${esc(q.summary || q.purpose || "Opzoeking")}${q.error ? ` <span class="warn">(fout)</span>` : q.rows != null ? ` (${q.rows} rijen)` : ""}</li>`).join("")}</ul>
    </details>` : ""}</div>`;
}

const SUGGESTIONS = [
  "Hoe sliep ik deze week vergeleken met vorige week?",
  "Haal ik genoeg eiwit op dagen dat ik train?",
  "Hoe evolueert mijn sterkste oefening de laatste 3 maanden?",
  "Is mijn rusthartslag lager na een week met veel slaap?",
  "Vat mijn laatste 7 dagen samen: wat ging goed, wat kan beter?",
  "Stuur me elke maandag om 8u een melding om mijn gewicht te loggen",
  "Herinner me elke avond om 21u30 aan mijn dagboek",
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
// Dagboek (inspreken of typen)
// ======================================================================
async function renderJournal(param) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(param || "") ? param : today();
  const isToday = day === today();
  const list = await rpc("get_journal", { p_limit: 60 });
  const cur = list.find((j) => j.day === day);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  view.innerHTML = `
    <div class="daynav">
      <a class="navbtn" href="#/dagboek/${addDays(day, -1)}" aria-label="Vorige dag">‹</a>
      ${calBtn(dayLabel(day))}
      ${isToday ? `<span class="navbtn disabled" aria-hidden="true">›</span>` : `<a class="navbtn" href="#/dagboek/${addDays(day, 1)}" aria-label="Volgende dag">›</a>`}
    </div>
    <section class="panel">
      <h3>Hoe was je dag?</h3>
      <p class="hint">${SR ? "Tik op de microfoon en vertel. Je tekst verschijnt hieronder; pas aan waar nodig." : "Tik in het tekstvak op de microfoon van je toetsenbord om in te spreken."}</p>
      <textarea class="input journal" id="jt" rows="8" placeholder="Training, energie, stress, slaap, wat goed ging…">${esc(cur?.content || "")}</textarea>
      <div class="row" style="margin-top:10px">
        ${SR ? `<button class="btn secondary mic" id="mic" type="button" aria-pressed="false"><span class="dot"></span><span id="micL">Inspreken</span></button>` : ""}
        <button class="btn" id="saveJ">Opslaan</button>
        <span class="muted small" id="jStatus">${cur ? `Laatst bewaard ${esc(timeAgo(cur.updated_at))}` : ""}</span>
      </div>
    </section>
    <h2 class="section-title">Eerdere dagen</h2>
    <div class="list">${list.filter((j) => j.day !== day).map((j) => `<a class="item" style="--c:var(--sleep);text-decoration:none" href="#/dagboek/${j.day}">
        <span class="swatch"></span>
        <span><div class="t">${esc(dayLabel(j.day))}</div><div class="m">${esc(j.content.length > 110 ? j.content.slice(0, 110) + "…" : j.content)}</div></span><span></span>
      </a>`).join("") || `<div class="empty">Nog geen eerdere dagboekmomenten.</div>`}</div>`;

  bindCal(day, (d) => (location.hash = `#/dagboek/${d}`));
  const ta = $("#jt");
  let dirty = false;
  ta.addEventListener("input", () => { dirty = true; $("#jStatus").textContent = "Niet bewaard"; });
  const save = async () => {
    try {
      await rpc("save_journal", { p_day: day, p_text: ta.value, p_append: false });
      dirty = false;
      $("#jStatus").textContent = "Bewaard";
    } catch (e) { toast(e.message); }
  };
  $("#saveJ").onclick = save;

  if (SR) {
    let rec = null, base = "";
    const btn = $("#mic");
    const stop = () => { rec?.stop(); };
    btn.onclick = () => {
      if (rec) return stop();
      rec = new SR();
      rec.lang = "nl-BE";
      rec.continuous = true;
      rec.interimResults = true;
      base = ta.value ? ta.value.replace(/\s*$/, "") + " " : "";
      rec.onresult = (ev) => {
        let fin = "", inter = "";
        for (let i = 0; i < ev.results.length; i++) {
          const r = ev.results[i];
          (r.isFinal ? (fin += r[0].transcript) : (inter += r[0].transcript));
        }
        ta.value = base + fin + inter;
        dirty = true;
      };
      rec.onerror = (e) => toast(e.error === "not-allowed" ? "Geef de app toegang tot je microfoon" : "Inspreken gestopt: " + e.error);
      rec.onend = () => {
        rec = null;
        btn.setAttribute("aria-pressed", "false");
        $("#micL").textContent = "Inspreken";
        if (dirty) save();
      };
      rec.start();
      btn.setAttribute("aria-pressed", "true");
      $("#micL").textContent = "Stop";
    };
  }
  window.addEventListener("hashchange", () => { if (dirty) save(); }, { once: true });
}

// ======================================================================
// Instellingen
// ======================================================================
const DAY_NAMES = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const daysLabel = (ds) => {
  const a = [...ds].sort();
  if (a.length === 7) return "elke dag";
  if (a.join() === "1,2,3,4,5") return "weekdagen";
  if (a.join() === "6,7") return "weekend";
  return a.map((d) => DAY_NAMES[d - 1]).join(", ");
};

function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush(vapid) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Meldingen werken pas als je de app op je beginscherm zet (Safari → deel → Zet op beginscherm) en daar opent.");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Meldingen zijn niet toegestaan. Zet ze aan via iPhone-instellingen → Meldingen → Health Hub.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(vapid) });
  await rpc("save_push_subscription", { p: sub.toJSON(), p_ua: navigator.userAgent.slice(0, 200) });
}

async function pushState() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    return sub && Notification.permission === "granted" ? "on" : "off";
  } catch { return "off"; }
}

async function importAppleHealth(file, months) {
  if (!file) return;
  const box = $("#ahProg");
  const set = (h) => { if (box) box.innerHTML = h; };
  try {
    const { parseHealthExport } = await import("./healthimport.js");
    const since = months ? addDays(today(), -Math.round(months * 30.44)) : "1900-01-01";
    set(`Bestand lezen… 0%`);
    const t0 = Date.now();
    const { batches, stats } = await parseHealthExport(file, {
      since,
      onProgress: (p) => set(`Bestand lezen… ${Math.round(p * 100)}%`),
    });
    if (!stats.records && !stats.workouts) throw new Error("Geen bruikbare gegevens gevonden in deze periode.");
    for (let i = 0; i < batches.length; i++) {
      set(`Uploaden… ${i + 1}/${batches.length}`);
      await rpc("import_health_export", { p: batches[i] });
    }
    set(`<span class="ok">Klaar</span> in ${Math.round((Date.now() - t0) / 1000)} s: ${fmt(stats.hours)} uurwaarden over ${stats.metrics} metingen, ${stats.sleepNights} nachten slaap, ${stats.workouts} workouts.`);
    toast("Apple Health-gegevens geïmporteerd");
  } catch (e) {
    set(`<span class="warn">${esc(e.message)}</span>`);
  }
}

async function renderSettings() {
  const [s, routines, pstate] = await Promise.all([rpc("get_settings"), rpc("get_routines"), pushState()]);
  const { data: { user } } = await sb.auth.getUser();
  const goals = s.settings?.goals || {};
  const model = s.settings?.ai_model || "claude-sonnet-5-5";
  const vapid = s.settings?.vapid_public;
  const ingestUrl = `${SUPABASE_URL}/functions/v1/ingest-health`;
  const sync = s.sync || {};
  const c = s.counts || {};

  view.innerHTML = `
    <section class="panel">
      <h3>Meldingen</h3>
      <p class="hint">${pstate === "on" ? `<span class="ok">Aan op dit toestel</span>` : pstate === "denied" ? `<span class="warn">Geblokkeerd</span>: zet ze aan via iPhone-instellingen → Meldingen → Health Hub.` : pstate === "unsupported" ? `Zet de app eerst op je beginscherm en open hem daar; daarna kan je meldingen aanzetten.` : "Nog niet aangezet op dit toestel."}</p>
      <div class="row">
        ${pstate !== "on" ? `<button class="btn" id="pushOn" ${pstate === "unsupported" ? "disabled" : ""}>Meldingen aanzetten</button>` : ""}
        <button class="btn secondary" id="pushTest" ${pstate !== "on" ? "disabled" : ""}>Testmelding</button>
      </div>
    </section>

    <section class="panel">
      <h3>Routines</h3>
      <p class="hint">Terugkerende meldingen. Maak ze hier of vraag het aan de AI, bv. <i>"Stuur me elke maandag om 8u een melding om mijn gewicht te loggen."</i></p>
      <div id="routineList">${routines.length ? routines.map((r) => `
        <div class="routine" data-id="${r.id}">
          <div>
            <div class="t">${esc(r.title)}${r.kind === "weekly_review" ? ` <span class="badge">AI</span>` : ""}</div>
            <div class="m">${esc(daysLabel(r.days))} om ${esc(r.time_local.slice(0, 5))}${r.body ? ` · ${esc(r.body)}` : ""}</div>
          </div>
          <label class="switch" title="Aan/uit"><input type="checkbox" data-act="toggle" ${r.active ? "checked" : ""}><span></span></label>
          <button class="icon-btn" data-act="del" aria-label="Verwijderen">✕</button>
        </div>`).join("") : `<p class="muted small">Nog geen routines.</p>`}
      </div>
      <details style="margin-top:10px"><summary>Nieuwe routine</summary>
        <form id="rf">
          <div class="field"><label for="rt">Titel</label><input class="input" id="rt" required placeholder="Log je gewicht"></div>
          <div class="field"><label for="rb">Tekst (optioneel)</label><input class="input" id="rb" placeholder="Stap even op de weegschaal"></div>
          <div class="field"><label>Dagen</label><div class="daypick">${DAY_NAMES.map((d, i) => `<label><input type="checkbox" value="${i + 1}" checked><span>${d}</span></label>`).join("")}</div></div>
          <div class="row">
            <div class="field" style="flex:1"><label for="rtime">Uur</label><input class="input" id="rtime" type="time" value="08:00" required></div>
            <div class="field" style="flex:1"><label for="rurl">Opent</label>
              <select class="input" id="rurl"><option value="/#/vandaag">Vandaag</option><option value="/#/log/gewicht">Gewicht loggen</option><option value="/#/dagboek">Dagboek</option><option value="/#/voeding">Voeding</option></select></div>
          </div>
          <button class="btn" type="submit">Routine toevoegen</button>
        </form>
      </details>
    </section>

    <section class="panel">
      <h3>Gewoontes en supplementen</h3>
      <p class="hint">Verschijnen op Vandaag om af te vinken, met je reeks. De AI kan ze ook zien.</p>
      <div id="habitSet"><div class="skeleton" style="height:30px"></div></div>
    </section>

    <section class="panel">
      <h3>Doelen</h3>
      <div class="goals">
        ${[["steps", "Stappen per dag"], ["active_kcal", "Actieve kcal"], ["sleep_h", "Slaap (uren)"], ["kcal_in", "Calorieën (kcal)"], ["protein_g", "Eiwit (g)"], ["carbs_g", "Koolhydraten (g)"], ["fat_g", "Vet (g)"], ["fiber_g", "Vezels (g)"], ["water_ml", "Water (ml)"], ["caffeine_mg", "Cafeïne max (mg)"]]
          .map(([k, l]) => `<div class="field"><label for="g_${k}">${l}</label><input class="input" inputmode="decimal" id="g_${k}" value="${esc(goals[k] ?? "")}"></div>`).join("")}
      </div>
      <button class="btn" id="saveGoals">Doelen opslaan</button>
    </section>

    <section class="panel">
      <h3>Apple Health</h3>
      <p class="hint">Status: ${sync.apple_health?.last_success ? `<span class="ok">laatst ontvangen ${esc(timeAgo(sync.apple_health.last_success))}</span>` : `<span class="warn">nog niets ontvangen</span>`}</p>
      <a class="btn" href="#/koppelen" style="display:inline-block;text-decoration:none;margin-bottom:8px">Koppel-assistent openen (stap voor stap)</a>

      <details class="why"><summary>Waarom kan ik Health Hub niet aanvinken in Gezondheid → Apps?</summary>
        <p class="small">Dat lijstje bevat alleen <b>echte iPhone-apps</b> (uit de App Store of zelf gebouwd met Xcode op een Mac). Health Hub is een web-app: Apple geeft websites geen toegang tot Gezondheid. Daarom gaat het via de twee gratis routes hieronder: de export (historiek) en een automatisering in Opdrachten (dagelijks). Opdrachten is wél een Apple-app met toegang: die leest je gegevens en stuurt ze door.</p>
        <p class="small">Alternatieven: een betalende export-app (Health Auto Export), of een eigen mini-iPhone-app. Die laatste vraagt een Mac met Xcode; met een gratis Apple-account moet je ze elke 7 dagen opnieuw installeren, met een ontwikkelaarsaccount (€99/jaar) niet.</p>
      </details>

      <h4 class="sub-h">1. Historiek en workouts: export importeren</h4>
      <p class="small">Gezondheid-app → je profielfoto → <b>Exporteer alle gezondheidsgegevens</b> → bewaar <i>export.zip</i> in Bestanden. Kies het hier. Tip: op een computer gaat het sneller (log daar in op dezelfde site).</p>
      <div class="row">
        <select class="input" id="ahSince" style="max-width:170px" aria-label="Periode">
          <option value="3">Laatste 3 maanden</option><option value="6" selected>Laatste 6 maanden</option>
          <option value="12">Laatste 12 maanden</option><option value="0">Alles</option>
        </select>
        <label class="btn" style="cursor:pointer">Export kiezen<input type="file" id="ahFile" accept=".zip,.xml,application/zip,text/xml" hidden></label>
      </div>
      <div id="ahProg" class="small muted" style="margin-top:8px"></div>

      <h4 class="sub-h">2. Elke dag automatisch: iOS Opdrachten (gratis)</h4>
      <p class="small">Een automatisering in de app <b>Opdrachten</b> stuurt je dagtotalen van vandaag door, telkens als je een gekozen app opent. Workouts en slaapfasen komen via de export hierboven.</p>
      <details><summary>Stap voor stap instellen</summary>
        <ol class="steps-list">
          <li>Opdrachten → <b>Automatisering</b> → <b>+</b> → <b>App</b> → kies een app die je elke avond opent (bv. WhatsApp) → <b>Is geopend</b> → <b>Voer direct uit</b>. <i>Waarom geen vast tijdstip? Als je iPhone vergrendeld is, kan Opdrachten je gezondheidsgegevens niet lezen. Bij het openen van een app is hij ontgrendeld. Vaker versturen is geen probleem: de dagtotalen worden gewoon bijgewerkt.</i></li>
          <li>Voeg <b>Opmaakdatum</b> toe (Format Date): datum = Huidige datum, notatie <b>Aangepast</b> → <span class="mono">yyyy-MM-dd</span>.</li>
          <li>Per meting in de tabel: actie <b>Zoek gezondheidsstalen</b> (Find Health Samples): type zoals hieronder, <b>Begindatum is vandaag</b>, <b>Groepeer op: Dag</b>. Daarna actie <b>Bereken statistieken</b> (Calculate Statistics) met <b>Som</b> of <b>Gemiddelde</b>.</li>
          <li>Voeg <b>Haal inhoud op van URL</b> (Get Contents of URL) toe: URL hieronder, methode <b>POST</b>, header <span class="mono">Authorization</span> = <span class="mono">Bearer</span> + spatie + token, verzoekbody <b>JSON</b>.</li>
          <li>In de JSON-body: veld <span class="mono">date</span> (tekst) = de opgemaakte datum; daarna per meting een veld (type <b>Getal</b>) met de sleutel uit de tabel en als waarde de statistiek.</li>
          <li>Test door de automatisering één keer met de hand te starten. In <b>Data → Synclogboek</b> hieronder zie je "opdrachten".</li>
        </ol>
        <table class="nutrients small">
          <tr><td><b>Type in Gezondheid</b></td><td><b>Berekening</b></td><td><b>JSON-sleutel</b></td></tr>
          ${[["Stappen", "Som", "step_count"], ["Actieve energie", "Som", "active_energy"], ["Rustenergie", "Som", "basal_energy_burned"],
             ["Afstand wandelen + hardlopen", "Som", "walking_running_distance"], ["Rusthartslag", "Gemiddelde", "resting_heart_rate"],
             ["Hartslagvariabiliteit", "Gemiddelde", "heart_rate_variability"], ["Energie (voeding)", "Som", "dietary_energy"],
             ["Eiwitten", "Som", "protein"], ["Koolhydraten", "Som", "carbohydrates"], ["Totaal vet", "Som", "total_fat"],
             ["Gewicht (optioneel)", "Gemiddelde", "weight_body_mass"]]
            .map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td class="mono">${c}</td></tr>`).join("")}
        </table>
        <p class="small muted">Slaap (optioneel): sleutel <span class="mono">sleep_hours</span> met het aantal uren. Eenheden: kcal, km, bpm, ms, g. Een dag die later via de export binnenkomt, vervangt de dagtotalen automatisch (niets telt dubbel).</p>
      </details>
      <div class="field" style="margin-top:10px"><label>URL</label>
        <div class="row"><input class="input mono" readonly value="${esc(ingestUrl)}" id="ingUrl"><button class="btn secondary" data-copy="ingUrl">Kopieer</button></div></div>
      <div class="field"><label>Token (header <span class="mono">Authorization: Bearer …</span>)</label>
        <div class="row"><input class="input mono" readonly type="password" value="${esc(s.ingest_token)}" id="ingTok">
        <button class="btn secondary" id="showTok">Toon</button><button class="btn secondary" data-copy="ingTok">Kopieer</button></div></div>

      <details style="margin-top:6px"><summary>Liever volledig automatisch? (Health Auto Export, betalend)</summary>
        <p class="small">Health Auto Export Premium ($6,99/jaar of $24,99 eenmalig) stuurt alles per uur, inclusief slaapfasen en workouts. Automations → REST API → zelfde URL en header, JSON versie 2, Aggregate data aan (Hours), Summarize sleep aan.</p>
      </details>
      <details style="margin-top:6px"><summary>Welke wearable?</summary>
        <p class="small">Alles wat naar Apple Health schrijft werkt: <b>Garmin</b> (Garmin Connect → Gekoppelde apps → Apple Health), <b>Apple Watch</b>, en apps zoals <b>Bevel</b>. <b>Fitbit</b> schrijft niet zelf naar Apple Health en heeft een brug-app nodig.</p>
      </details>
      <div class="row" style="margin-top:10px"><button class="btn ghost" id="rotTok">Nieuw token maken</button></div>
    </section>

    <section class="panel">
      <h3>Hevy</h3>
      <p class="hint">Zonder Hevy Pro: exporteer in Hevy via <b>Profiel → Instellingen → Export &amp; Import Data → Export workouts</b> en importeer het CSV-bestand hier. Opnieuw importeren overschrijft niets dubbel. ${sync.hevy_csv ? `Laatste import ${esc(timeAgo(sync.hevy_csv.last_success))}.` : ""}</p>
      <label class="btn" style="display:inline-block;cursor:pointer">CSV importeren<input type="file" id="hevyCsv2" accept=".csv,text/csv" hidden></label>
      <details style="margin-top:12px"><summary>Heb je Hevy Pro? (automatische sync)</summary>
        <p class="hint" style="margin-top:8px">API-key uit Hevy → Settings → Developer. Status: ${s.secrets?.hevy_api_key ? `<span class="ok">ingesteld</span>` : "niet ingesteld"}</p>
        <div class="row"><input class="input" type="password" id="hevyKey" placeholder="${s.secrets?.hevy_api_key ? "•••••••• (opgeslagen)" : "Plak je Hevy API-key"}" autocomplete="off">
          <button class="btn" id="saveHevy">Opslaan</button></div>
        <div class="row" style="margin-top:10px">
          <button class="btn secondary" id="syncNow">Nu synchroniseren</button>
          <button class="btn ghost" id="syncFull">Alles opnieuw ophalen</button>
        </div>
      </details>
    </section>

    <section class="panel">
      <h3>AI (Claude)</h3>
      <p class="hint">API-key van console.anthropic.com. Status: ${s.secrets?.anthropic_api_key ? `<span class="ok">ingesteld</span>` : `<span class="warn">niet ingesteld</span>`}</p>
      <div class="row"><input class="input" type="password" id="aiKey" placeholder="${s.secrets?.anthropic_api_key ? "•••••••• (opgeslagen)" : "sk-ant-…"}" autocomplete="off">
        <button class="btn" id="saveAi">Opslaan</button></div>
      <div class="field"><label for="model">Model</label>
        <select class="input" id="model">
          ${[["claude-sonnet-5-5", "Claude Sonnet 5.5 (aanbevolen)"], ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (goedkoopst)"], ["claude-opus-5-5", "Claude Opus 5.5 (grondigst, duurder)"]]
            .map(([v, l]) => `<option value="${v}" ${v === model ? "selected" : ""}>${l}</option>`).join("")}
        </select></div>
    </section>

    <section class="panel">
      <h3>Data</h3>
      <dl class="kv">
        <dt>Metingen (Apple Health + zelf gelogd)</dt><dd>${fmt(c.samples)}</dd>
        <dt>Slaapnachten</dt><dd>${fmt(c.sleep_nights)}</dd>
        <dt>Workouts (Apple Health)</dt><dd>${fmt(c.workouts)}</dd>
        <dt>Hevy-trainingen</dt><dd>${fmt(c.hevy_workouts)}</dd>
        <dt>Eerste dag</dt><dd>${c.first_day ? esc(dayLabel(c.first_day, { day: "numeric", month: "short", year: "numeric" })) : "–"}</dd>
      </dl>
      <div class="row" style="margin-top:12px">
        <button class="btn secondary" id="exportAll">Back-up downloaden (JSON)</button>
      </div>
      <p class="small muted" style="margin:6px 0 0">Alles wat je in de app logde plus je dagtotalen, trainingen en slaap. Bewaar het bv. maandelijks in iCloud Drive: het gratis Supabase-plan maakt geen back-ups die jij kan downloaden.</p>
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

  // meldingen
  $("#pushOn")?.addEventListener("click", async () => {
    try { await enablePush(vapid); toast("Meldingen staan aan"); renderSettings(); } catch (e) { toast(e.message, 7000); }
  });
  $("#pushTest").onclick = async () => {
    try { const r = await invoke("notify", { test: true }); toast(r.sent ? "Testmelding verstuurd" : "Geen toestel gevonden om naar te sturen", 4000); }
    catch (e) { toast(e.message, 5000); }
  };
  // routines
  $("#routineList").addEventListener("click", async (e) => {
    const row = e.target.closest(".routine");
    if (!row) return;
    const act = e.target.dataset.act;
    if (act === "del") {
      if (!confirm("Deze routine verwijderen?")) return;
      await rpc("save_routine", { p: { id: row.dataset.id, archived: true } });
      toast("Routine verwijderd");
      renderSettings();
    }
  });
  $("#routineList").addEventListener("change", async (e) => {
    if (e.target.dataset.act !== "toggle") return;
    const row = e.target.closest(".routine");
    await rpc("save_routine", { p: { id: row.dataset.id, active: e.target.checked } });
    toast(e.target.checked ? "Routine aan" : "Routine gepauzeerd");
  });
  $("#rf").onsubmit = async (e) => {
    e.preventDefault();
    const days = [...view.querySelectorAll(".daypick input:checked")].map((i) => Number(i.value));
    if (!days.length) return toast("Kies minstens één dag");
    try {
      await rpc("save_routine", { p: { title: $("#rt").value, body: $("#rb").value || null, days, time: $("#rtime").value, url: $("#rurl").value } });
      toast("Routine toegevoegd");
      renderSettings();
    } catch (er) { toast(er.message); }
  };
  // overige
  view.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async () => {
    const inp = $("#" + b.dataset.copy);
    try { await navigator.clipboard.writeText(inp.value); toast("Gekopieerd"); }
    catch { inp.type = "text"; inp.select(); toast("Selecteer en kopieer handmatig"); }
  }));
  $("#showTok").onclick = () => { const i = $("#ingTok"); i.type = i.type === "password" ? "text" : "password"; };
  $("#rotTok").onclick = async () => {
    if (!confirm("Nieuw token maken? Je moet het daarna ook in Health Auto Export aanpassen.")) return;
    $("#ingTok").value = await rpc("rotate_ingest_token");
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
  $("#ahFile").onchange = (e) => importAppleHealth(e.target.files?.[0], Number($("#ahSince").value));
  $("#hevyCsv2").onchange = (e) => importHevyFile(e.target.files?.[0], renderSettings);
  $("#saveHevy").onclick = () => saveSecret("hevy_api_key", "#hevyKey").catch((e) => toast(e.message));
  $("#saveAi").onclick = () => saveSecret("anthropic_api_key", "#aiKey").catch((e) => toast(e.message));
  $("#syncNow").onclick = () => syncHevy($("#syncNow"), false, renderSettings);
  $("#syncFull").onclick = () => syncHevy($("#syncFull"), true, renderSettings);
  $("#model").onchange = async (e) => { await rpc("set_setting", { p_key: "ai_model", p_value: e.target.value }); toast("Model opgeslagen"); };
  moreMod().then((M) => {
    M.renderHabitSettings(ctx, $("#habitSet"));
    $("#exportAll").onclick = (e) => M.exportAll(ctx, e.currentTarget);
  });
  $("#saveGoals").onclick = async () => {
    const out = {};
    for (const k of ["steps", "active_kcal", "sleep_h", "kcal_in", "protein_g", "carbs_g", "fat_g", "fiber_g", "water_ml", "caffeine_mg"]) {
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
  dagboek: renderJournal,
  workout: async () => (await workoutMod()).renderWorkout(ctx),
  koppelen: async () => (await import("./link.js")).renderLink(ctx),
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
