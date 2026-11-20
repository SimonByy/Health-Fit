// Spierbelasting: lichaamskaart voor- en achterkant in vier stijlen die de gebruiker zelf kiest.
// Groen = klaar, oranje = half belast, rood = belast. Werksets van de laatste 7 dagen, uitdovend met een
// halfwaardetijd van ±48 uur, met een minimum de eerste 1–2 dagen na een harde training. Tik op een spier voor het waarom.
import { BODY } from "./bodydata.js";
let C;
const NAMES = { chest: "Borst", lats: "Lats", upper_back: "Bovenrug en lats", lower_back: "Onderrug", traps: "Trapezius", shoulders: "Schouders",
  biceps: "Biceps", triceps: "Triceps", forearms: "Onderarmen", quadriceps: "Quadriceps", hamstrings: "Hamstrings", glutes: "Bilspieren",
  calves: "Kuiten", abductors: "Abductoren", adductors: "Adductoren", abdominals: "Buikspieren" };
const STYLES = [["vlak", "Vlak"], ["lijnen", "Lijnen"], ["belast", "Alleen belast"], ["lijst", "Met lijst"]];
const G = "#4E9F69", O = "#E08A3C", R = "#D6533F";
const step = (p) => (p >= 55 ? R : p >= 25 ? O : G);
const smooth = (p) => (p < 25 ? `color-mix(in srgb, ${O} ${Math.round((p / 25) * 100)}%, ${G})`
  : `color-mix(in srgb, ${R} ${Math.round(Math.min(1, (p - 25) / 50) * 100)}%, ${O})`);
const state = (p) => (p >= 55 ? "belast" : p >= 25 ? "half belast" : "klaar");
const hoursTo25 = (pct) => (pct > 25 ? Math.ceil(48 * Math.log2(pct / 25)) : 0);

let STYLE = null;
async function getStyle() {
  if (STYLE) return STYLE;
  try { STYLE = localStorage.getItem("hh-fatigue-style"); } catch { /* */ }
  const ui = await C.rpc("get_setting", { p_key: "ui" }).catch(() => null);
  STYLE = ui?.fatigue_style || STYLE || "vlak";
  return STYLE;
}
async function setStyle(s) {
  STYLE = s;
  try { localStorage.setItem("hh-fatigue-style", s); } catch { /* */ }
  const ui = (await C.rpc("get_setting", { p_key: "ui" }).catch(() => null)) || {};
  C.rpc("set_setting", { p_key: "ui", p_value: { ...ui, fatigue_style: s } }).catch(() => {});
}

function svg(pct, style) {
  const fill = (m) => {
    const p = pct(m);
    if (!m) return style === "lijnen" ? `fill="none"` : `fill="#3B403C"`;
    if (style === "lijnen") return `fill="${smooth(p)}" fill-opacity="${(0.25 + (p / 100) * 0.6).toFixed(2)}"`;
    if (style === "belast") return p >= 25 ? `fill="${step(p)}" fill-opacity=".8"` : `fill="#454B46"`;
    return `fill="${step(p)}" fill-opacity=".72"`;
  };
  const stroke = style === "lijnen" ? `stroke="var(--ink)" stroke-opacity=".55" stroke-width=".5"` : `stroke="var(--surface)" stroke-width=".6"`;
  const fig = (side, x) => `<g transform="translate(${x} 0)">${BODY[side].map(([m, polys]) => polys.map((pt) =>
    `<polygon points="${pt}" ${fill(m)} ${stroke}${m ? ` class="fm" data-m="${m}" tabindex="0" role="button" aria-label="${NAMES[m]}: ${pct(m)}%, ${state(pct(m))}"` : ""}/>`).join("")).join("")}</g>`;
  return `<svg viewBox="0 0 210 205" class="fmap" role="img" aria-label="Lichaamskaart met belasting per spiergroep">${fig("front", 0)}${fig("back", 110)}</svg>`;
}

export async function renderFatigue(ctx, box) {
  C = ctx;
  const [rows, style] = await Promise.all([C.rpc("get_muscle_fatigue").catch(() => []), getStyle()]);
  const by = Object.fromEntries(rows.map((r) => [r.muscle, r]));
  // lats hebben in dit model geen eigen vlak: ze tellen mee bij de bovenrug
  const pct = (m) => (m === "upper_back" ? Math.max(by.upper_back?.pct || 0, by.lats?.pct || 0) : by[m]?.pct || 0);
  const top = rows.filter((r) => r.pct >= 25).slice(0, style === "lijst" ? 6 : 3);
  const legend = `<div class="flegend small muted"><span><i style="background:${G}"></i>klaar</span><span><i style="background:${O}"></i>half belast</span><span><i style="background:${R}"></i>belast</span></div>`;
  const map = svg(pct, style === "lijst" ? "vlak" : style);
  box.innerHTML = `<section class="panel fatigue">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Spierbelasting</h3>
        <button class="btn ghost small" id="fStyle">Stijl</button></div>
      ${style === "lijst"
        ? `<div class="fl-wrap">${map}<ul class="fl-list">${(top.length ? top : rows.slice(0, 4)).map((r) => `<li data-m="${r.muscle}" tabindex="0" role="button"><span><i class="dot" style="background:${step(r.pct)}"></i>${NAMES[r.muscle] || r.muscle}</span><b>${r.pct}%</b></li>`).join("") || `<li class="muted">Alles is klaar.</li>`}</ul></div>`
        : `<p class="hint" style="margin-top:6px">${top.length ? `Nog belast: ${top.map((r) => `${NAMES[r.muscle] || r.muscle} ${r.pct}%`).join(", ")}.` : "Alles is klaar om te trainen."} Tik op een spier voor het waarom.</p>${map}`}
      ${legend}
    </section>`;
  const open = (m) => detail(m, m === "upper_back" && (by.lats?.pct || 0) > (by.upper_back?.pct || 0) ? by.lats : by[m]);
  box.querySelectorAll(".fm, .fl-list li[data-m]").forEach((el) => {
    el.addEventListener("click", () => open(el.dataset.m));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(el.dataset.m); } });
  });
  box.querySelector("#fStyle").onclick = () => chooseStyle(box);
}

function chooseStyle(box) {
  const s = document.createElement("div");
  s.className = "sheet";
  const demo = (m) => ({ chest: 70, shoulders: 40, biceps: 35, upper_back: 30, triceps: 28, quadriceps: 15, hamstrings: 18 }[m] || 0);
  s.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Stijl van de spierkaart">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Stijl van de kaart</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <div class="fstyles">${STYLES.map(([k, l]) => `<button class="fstyle ${k === STYLE ? "on" : ""}" data-s="${k}" aria-pressed="${k === STYLE}">
      ${svg(demo, k === "lijst" ? "vlak" : k)}<span>${l}</span></button>`).join("")}</div>
  </div>`;
  document.body.appendChild(s);
  s.addEventListener("click", async (e) => {
    if (e.target === s || e.target.closest("[data-close]")) return s.remove();
    const b = e.target.closest("[data-s]"); if (!b) return;
    await setStyle(b.dataset.s); s.remove(); renderFatigue(C, box);
  });
}

function detail(m, r) {
  const s = document.createElement("div");
  s.className = "sheet";
  const pct = r?.pct ?? 0;
  const h = r?.ready_in_h ?? hoursTo25(pct);
  const byDay = {};
  for (const w of r?.why || []) (byDay[w.day] ||= { workout: w.workout, items: [] }).items.push(w);
  s.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${NAMES[m]}">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${NAMES[r?.muscle] || NAMES[m] || m}</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <p style="margin:10px 0 4px"><b class="num" style="font-size:34px;color:${step(pct)}">${pct}%</b> <span class="muted">${state(pct)}</span></p>
    <p class="small muted" style="margin:0 0 10px">${r ? `${r.sets_7d} werksets in 7 dagen · laatst ${r.hours_since < 36 ? `${r.hours_since} uur` : `${Math.round(r.hours_since / 24)} dagen`} geleden.` : "Geen werksets in de laatste 7 dagen."}
      ${h ? ` Over ongeveer ${h < 30 ? `${h} uur` : `${Math.round(h / 24)} dagen`} is die spiergroep weer klaar.` : ""}</p>
    ${Object.entries(byDay).map(([day, g]) => `<h4 class="sub-h">${C.esc(C.shortDate(day))} · ${C.esc(g.workout || "Training")}</h4>
      ${g.items.map((w) => `<div class="meal"><span>${C.esc(w.exercise)}</span><span class="k">${w.sets} set${w.sets > 1 ? "s" : ""}<br><span class="small muted">+${w.share}%</span></span></div>`).join("")}`).join("")}
    <p class="small muted" style="margin-top:12px">Hoe het werkt: elke werkset telt mee en weegt na 48 uur nog maar half. Ongeveer 6 harde sets net gedaan = 100%. Trainde je een spier hard (4+ sets), dan staat ze de eerste 24 uur minstens op belast en tot 48 uur minstens op half belast. Onder 25% = klaar, tot 55% = half belast, daarboven = belast. Het is een schatting op basis van je sets, geen meting.</p>
  </div>`;
  document.body.appendChild(s);
  s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) s.remove(); });
}
