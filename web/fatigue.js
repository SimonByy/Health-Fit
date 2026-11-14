// Spiervermoeidheid: lichaamskaart voor- en achterkant. Kleur = hoe vermoeid een spiergroep nog is
// (werksets van de laatste 7 dagen, uitdovend met een halfwaardetijd van ±36 uur). Tik op een spier voor de uitleg.
let C;
const NAMES = { chest: "Borst", lats: "Lats", upper_back: "Bovenrug", lower_back: "Onderrug", traps: "Trapezius", shoulders: "Schouders",
  biceps: "Biceps", triceps: "Triceps", forearms: "Onderarmen", quadriceps: "Quadriceps", hamstrings: "Hamstrings", glutes: "Bilspieren",
  calves: "Kuiten", abductors: "Abductoren", adductors: "Adductoren", abdominals: "Buikspieren" };

// Eenvoudige, symmetrische vormen per spiergroep (viewBox 120 × 250 per figuur)
const sym = (f) => [f(1), f(-1)];
const mirror = (d) => d.replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g, (m, x, y) => `${120 - Number(x)} ${y}`);
const P = (d) => [d, mirror(d)];
const FRONT = {
  shoulders: sym((s) => `<ellipse cx="${60 - s * 25}" cy="52" rx="9" ry="9"/>`),
  chest: P("M59 46 L45 46 Q38 56 44 68 Q52 71 59 68 Z").map((d) => `<path d="${d}"/>`),
  biceps: sym((s) => `<ellipse cx="${60 - s * 30}" cy="76" rx="5.5" ry="12"/>`),
  forearms: sym((s) => `<ellipse cx="${60 - s * 33}" cy="104" rx="4.5" ry="13"/>`),
  abdominals: [`<rect x="51" y="71" width="18" height="40" rx="6"/>`],
  abductors: sym((s) => `<ellipse cx="${60 - s * 16}" cy="118" rx="5" ry="8"/>`),
  adductors: sym((s) => `<ellipse cx="${60 - s * 5}" cy="138" rx="3.5" ry="14"/>`),
  quadriceps: sym((s) => `<ellipse cx="${60 - s * 14}" cy="150" rx="8" ry="24"/>`),
  calves: sym((s) => `<ellipse cx="${60 - s * 14}" cy="202" rx="5.5" ry="18"/>`),
};
const BACK = {
  traps: [`<path d="M60 34 L46 47 L60 64 L74 47 Z"/>`],
  shoulders: sym((s) => `<ellipse cx="${60 - s * 25}" cy="52" rx="9" ry="9"/>`),
  upper_back: [`<path d="M50 60 L70 60 L69 82 L51 82 Z"/>`],
  lats: P("M49 62 Q40 72 46 98 L53 94 L51 64 Z").map((d) => `<path d="${d}"/>`),
  lower_back: [`<rect x="52" y="86" width="16" height="22" rx="4"/>`],
  triceps: sym((s) => `<ellipse cx="${60 - s * 30}" cy="76" rx="5.5" ry="12"/>`),
  forearms: sym((s) => `<ellipse cx="${60 - s * 33}" cy="104" rx="4.5" ry="13"/>`),
  glutes: sym((s) => `<ellipse cx="${60 - s * 9}" cy="124" rx="9.5" ry="11"/>`),
  hamstrings: sym((s) => `<ellipse cx="${60 - s * 13}" cy="158" rx="8" ry="22"/>`),
  calves: sym((s) => `<ellipse cx="${60 - s * 14}" cy="203" rx="6.5" ry="18"/>`),
};
// Neutraal silhouet: hoofd, nek, romp, handen, voeten
const BODY = `<circle cx="60" cy="17" r="11"/><rect x="55" y="27" width="10" height="9" rx="3"/>
  <path d="M42 42 Q60 36 78 42 L80 112 Q60 122 40 112 Z"/>
  <circle cx="27" cy="121" r="4.5"/><circle cx="93" cy="121" r="4.5"/>
  <path d="M38 118 L59 124 L57 228 L42 228 Z"/><path d="M82 118 L61 124 L63 228 L78 228 Z"/>
  <ellipse cx="47" cy="234" rx="8" ry="4"/><ellipse cx="73" cy="234" rx="8" ry="4"/>`;

const shade = (pct) => pct == null || pct < 3 ? "#4A504B" : `color-mix(in srgb, var(--plate-red) ${Math.round(25 + pct * 0.75)}%, #4A504B)`;
const fresh = (pct) => pct >= 70 ? "nog erg vermoeid" : pct >= 40 ? "vermoeid" : pct >= 15 ? "licht vermoeid" : "hersteld";
// uren tot onder 25 % (halfwaardetijd 36 u)
const hoursTo25 = (pct) => (pct > 25 ? Math.ceil(36 * Math.log2(pct / 25)) : 0);

function figure(map, by, x, label) {
  const parts = Object.entries(map).map(([m, shapes]) => `<g class="fm" data-m="${m}" style="fill:${shade(by[m]?.pct)}" tabindex="0" role="button"
      aria-label="${NAMES[m]}: ${by[m] ? by[m].pct + "%" : "hersteld"}">${shapes.join("")}</g>`).join("");
  return `<g transform="translate(${x} 0)"><g class="fbody">${BODY}</g>${parts}
    <text x="60" y="248" text-anchor="middle" class="flabel">${label}</text></g>`;
}

export async function renderFatigue(ctx, box) {
  C = ctx;
  const rows = await C.rpc("get_muscle_fatigue").catch(() => []);
  const by = Object.fromEntries(rows.map((r) => [r.muscle, r]));
  const top = rows.filter((r) => r.pct >= 15).slice(0, 3);
  box.innerHTML = `<section class="panel fatigue">
      <h3>Spiervermoeidheid</h3>
      <p class="hint">${top.length ? `Het meest vermoeid: ${top.map((r) => `${NAMES[r.muscle] || r.muscle} ${r.pct}%`).join(", ")}. Tik op een spier voor het waarom.` : "Alles is hersteld. Tik op een spier voor details."}</p>
      <svg viewBox="0 0 250 252" class="fmap" role="img" aria-label="Lichaamskaart met vermoeidheid per spiergroep">
        ${figure(FRONT, by, 0, "voorkant")}${figure(BACK, by, 130, "achterkant")}
      </svg>
      <div class="flegend small muted"><span>hersteld</span><i></i><span>erg vermoeid</span></div>
    </section>`;
  box.querySelectorAll(".fm").forEach((g) => {
    const open = () => detail(g.dataset.m, by[g.dataset.m]);
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

function detail(m, r) {
  const s = document.createElement("div");
  s.className = "sheet";
  const pct = r?.pct ?? 0;
  const h = hoursTo25(pct);
  const byDay = {};
  for (const w of r?.why || []) (byDay[w.day] ||= { workout: w.workout, items: [] }).items.push(w);
  s.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${NAMES[m]}">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${NAMES[m] || m}</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <p style="margin:10px 0 4px"><b class="num" style="font-size:34px">${pct}%</b> <span class="muted">${fresh(pct)}</span></p>
    <p class="small muted" style="margin:0 0 10px">${r ? `${r.sets_7d} werksets in 7 dagen · laatst ${r.hours_since < 36 ? `${r.hours_since} uur` : `${Math.round(r.hours_since / 24)} dagen`} geleden.` : "Geen werksets in de laatste 7 dagen."}
      ${h ? ` Over ongeveer ${h < 30 ? `${h} uur` : `${Math.round(h / 24)} dagen`} is die spiergroep weer grotendeels hersteld.` : ""}</p>
    ${Object.entries(byDay).map(([day, g]) => `<h4 class="sub-h">${C.esc(C.shortDate(day))} · ${C.esc(g.workout || "Training")}</h4>
      ${g.items.map((w) => `<div class="meal"><span>${C.esc(w.exercise)}</span><span class="k">${w.sets} set${w.sets > 1 ? "s" : ""}<br><span class="small muted">+${w.share}%</span></span></div>`).join("")}`).join("")}
    <p class="small muted" style="margin-top:12px">Hoe het werkt: elke werkset telt mee en weegt na 36 uur nog maar half. Ongeveer 8 harde sets net gedaan = 100%. Het is een schatting op basis van je sets, geen meting.</p>
  </div>`;
  document.body.appendChild(s);
  s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) s.remove(); });
}
