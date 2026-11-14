// Trainingsplanner: je doelen en voorkeuren + een weekplan dat je zelf aanpast of laat invullen.
// "Plan mijn week" werkt zonder AI: het verdeelt je kracht- en cardiosessies over je voorkeurdagen
// en draait door de routines van de gekozen map, vanaf de routine na je laatste training.
let C;
const WD = ["ma", "di", "wo", "do", "vr", "za", "zo"];
const WDL = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
const DAYPREF = [["kracht", "Kracht"], ["cardio", "Cardio"], ["beide", "Beide"], ["flex", "Flexibel"], ["rust", "Rust"]];
const CARDIO = [["lopen", "Lopen buiten"], ["loopband", "Loopband"], ["fietsen", "Fietsen"], ["zwemmen", "Zwemmen"], ["roeien", "Roeien"], ["wandelen", "Stevig wandelen"], ["crosstrainer", "Crosstrainer"]];
const FOCUS = [["zone2", "Vooral zone 2 (basis)"], ["mix", "Zone 2 + 1 keer intervallen"], ["intervallen", "Vooral intervallen"]];
const GOALKIND = [["uithouding", "Uithouding (bv. halve marathon)"], ["kracht", "Sterker worden"], ["spier", "Spiermassa"], ["vet", "Vet verliezen"], ["anders", "Iets anders"]];
const DEF = { goals: [], days: ["kracht", "kracht", "cardio", "kracht", "cardio", "kracht", "rust"], strength_per_week: 4, cardio_per_week: 2,
  cardio_types: ["lopen"], cardio_min: 40, focus: "zone2", folder_id: null, strength_min: 75 };
const monday = (iso) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
const label = (arr, k) => (arr.find((x) => x[0] === k) || [k, k])[1];

export async function renderPlanner(ctx, start) {
  C = ctx;
  const from = start || monday(C.today());
  const days = Array.from({ length: 7 }, (_, i) => C.addDays(from, i));
  const [prefsRaw, list, R] = await Promise.all([
    C.rpc("get_setting", { p_key: "training_prefs" }).catch(() => null),
    C.rpc("get_coach_week", { p_from: from }).catch(() => []),
    C.rpc("get_workout_routines").catch(() => ({ folders: [], routines: [] })),
  ]);
  const prefs = { ...DEF, ...(prefsRaw || {}) };
  const fmtRange = new Intl.DateTimeFormat("nl-BE", { day: "numeric", month: "short", timeZone: "UTC" }).formatRange(new Date(from + "T12:00:00Z"), new Date(days[6] + "T12:00:00Z"));
  const sessRow = (s) => `<div class="pl-sess ${s.category || (s.kind === "z2" ? "cardio" : s.kind === "rust" ? "rust" : "kracht")} ${s.status}" data-id="${s.id}">
      <span class="pl-k"></span>
      <span class="pl-t"><b>${C.esc(s.title.replace(/^[^\p{L}\d]+/u, ""))}</b>${s.duration_min ? `<small>${s.duration_min} min</small>` : ""}${s.status !== "gepland" ? `<small>${C.esc(s.status)}</small>` : ""}</span>
      ${s.routine_id && s.day === C.today() && s.status === "gepland" ? `<button class="btn small" data-go="${s.id}">Start</button>` : ""}
      <button class="icon-btn" data-edit="${s.id}" aria-label="Aanpassen">✎</button></div>`;

  C.view.innerHTML = `
    <section class="panel pl-head">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap">
        <button class="wnav" data-w="-7" aria-label="Vorige week">‹</button>
        <div style="text-align:center"><h2 style="margin:0">Weekplan</h2><span class="small muted">${C.esc(fmtRange)}</span></div>
        <button class="wnav" data-w="7" aria-label="Volgende week">›</button>
      </div>
      <button class="btn big-start" id="plAuto" style="margin-top:12px">Plan mijn week</button>
      <p class="small muted" style="margin:6px 0 0">Verdeelt ${prefs.strength_per_week}× kracht en ${prefs.cardio_per_week}× cardio over je voorkeurdagen. Wat je al deed blijft staan.</p>
    </section>
    <div class="pl-week">${days.map((d, i) => {
      const items = list.filter((s) => s.day === d);
      return `<section class="pl-day ${d === C.today() ? "today" : ""} ${d < C.today() ? "past" : ""}">
        <header><b>${WDL[i]}</b> <span class="muted small">${new Date(d + "T12:00:00Z").getUTCDate()}</span>
          <span class="pl-pref small">${label(DAYPREF, prefs.days[i])}</span></header>
        ${items.map(sessRow).join("") || `<p class="small muted pl-empty">rust</p>`}
        <button class="pl-add" data-add="${d}">+ sessie</button>
      </section>`;
    }).join("")}</div>

    <details class="set-group" id="plPrefs" ${prefsRaw ? "" : "open"}><summary>Doelen en voorkeuren</summary><div class="set-body">
      <h4 class="sub-h">Grote doelen</h4>
      <p class="small muted" style="margin:0 0 8px">Je coach houdt hier rekening mee bij het plannen (bv. "Halve marathon", juni 2027).</p>
      <div id="plGoals">${prefs.goals.map((g, i) => `<div class="pl-goal"><span><b>${C.esc(g.title)}</b><small>${C.esc(label(GOALKIND, g.kind))}${g.date ? ` · tegen ${C.esc(g.date)}` : ""}</small></span>
        <button class="icon-btn" data-gdel="${i}" aria-label="Verwijderen">✕</button></div>`).join("") || `<p class="small muted">Nog geen doelen.</p>`}</div>
      <div class="pl-goalform">
        <input class="input" id="gT" placeholder="bv. Halve marathon in 2 uur">
        <div class="row"><select class="input" id="gK">${GOALKIND.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
          <input class="input" id="gD" type="month" aria-label="Tegen wanneer"></div>
        <button class="btn secondary" id="gAdd">Doel toevoegen</button>
      </div>

      <h4 class="sub-h">Voorkeurdagen</h4>
      <p class="small muted" style="margin:0 0 8px">Tik op een dag om te wisselen: kracht, cardio, beide, flexibel of rust.</p>
      <div class="pl-days">${WD.map((w, i) => `<button type="button" class="pl-dp ${prefs.days[i]}" data-day="${i}" data-v="${prefs.days[i]}"><span>${w}</span><b>${label(DAYPREF, prefs.days[i])}</b></button>`).join("")}</div>

      <h4 class="sub-h">Hoeveel per week</h4>
      <div class="row">
        <label class="field" style="flex:1"><span class="small muted">Krachttrainingen</span><input class="input" id="pS" type="number" min="0" max="7" value="${prefs.strength_per_week}"></label>
        <label class="field" style="flex:1"><span class="small muted">Cardiosessies</span><input class="input" id="pC" type="number" min="0" max="7" value="${prefs.cardio_per_week}"></label>
      </div>
      <div class="row">
        <label class="field" style="flex:1"><span class="small muted">Duur kracht (min)</span><input class="input" id="pSm" type="number" min="20" max="180" step="5" value="${prefs.strength_min}"></label>
        <label class="field" style="flex:1"><span class="small muted">Duur cardio (min)</span><input class="input" id="pCm" type="number" min="10" max="240" step="5" value="${prefs.cardio_min}"></label>
      </div>

      <h4 class="sub-h">Soort cardio</h4>
      <div class="chips">${CARDIO.map(([k, l]) => `<label class="chip-cb"><input type="checkbox" value="${k}" ${prefs.cardio_types.includes(k) ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
      <div class="field" style="margin-top:8px"><label for="pF">Intensiteit</label><select class="input" id="pF">${FOCUS.map(([k, l]) => `<option value="${k}" ${prefs.focus === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>

      <h4 class="sub-h">Krachtroutines</h4>
      <div class="field"><label for="pR">Wissel af tussen de routines uit map</label><select class="input" id="pR"><option value="">Kies een map</option>
        ${(R.folders || []).map((f) => `<option value="${f.id}" ${prefs.folder_id === f.id ? "selected" : ""}>${C.esc(f.name)}</option>`).join("")}</select></div>
      ${(R.folders || []).length ? "" : `<p class="small muted">Nog geen mappen. Maak er een via Training → Training starten → Mijn routines.</p>`}
      <button class="btn" id="pSave" style="margin-top:10px">Voorkeuren opslaan</button>
    </div></details>`;

  const rerender = () => renderPlanner(ctx, from);
  C.view.querySelectorAll(".wnav").forEach((b) => (b.onclick = () => renderPlanner(ctx, C.addDays(from, Number(b.dataset.w)))));
  C.view.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editSession(list.find((s) => String(s.id) === b.dataset.edit), days, R, prefs, rerender)));
  C.view.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => editSession({ day: b.dataset.add }, days, R, prefs, rerender)));
  C.view.querySelectorAll("[data-go]").forEach((b) => (b.onclick = async () => {
    const s = list.find((x) => String(x.id) === b.dataset.go);
    const tpl = (R.routines || []).find((r) => r.id === s.routine_id);
    (await import("./workout.js")).startWorkout(C, tpl ? { template: tpl } : {});
  }));

  // voorkeuren
  C.view.querySelectorAll(".pl-dp").forEach((b) => (b.onclick = () => {
    const keys = DAYPREF.map((x) => x[0]); const nv = keys[(keys.indexOf(b.dataset.v) + 1) % keys.length];
    b.dataset.v = nv; b.className = `pl-dp ${nv}`; b.querySelector("b").textContent = label(DAYPREF, nv);
  }));
  const collect = () => ({
    ...prefs,
    days: [...C.view.querySelectorAll("[data-day]")].map((s) => s.dataset.v),
    strength_per_week: Math.max(0, Math.min(7, Number(C.view.querySelector("#pS").value) || 0)),
    cardio_per_week: Math.max(0, Math.min(7, Number(C.view.querySelector("#pC").value) || 0)),
    strength_min: Number(C.view.querySelector("#pSm").value) || 75,
    cardio_min: Number(C.view.querySelector("#pCm").value) || 40,
    cardio_types: [...C.view.querySelectorAll(".chip-cb input:checked")].map((i) => i.value),
    focus: C.view.querySelector("#pF").value,
    folder_id: C.view.querySelector("#pR").value || null,
  });
  const savePrefs = async (p, msg = "Voorkeuren opgeslagen") => { await C.rpc("set_setting", { p_key: "training_prefs", p_value: p }); C.toast(msg); };
  C.view.querySelector("#pSave").onclick = async () => { try { await savePrefs(collect()); rerender(); } catch (e) { C.toast(e.message, 5000); } };
  C.view.querySelector("#gAdd").onclick = async () => {
    const t = C.view.querySelector("#gT").value.trim(); if (!t) return C.toast("Geef je doel een naam");
    const p = collect(); p.goals = [...(p.goals || []), { title: t, kind: C.view.querySelector("#gK").value, date: C.view.querySelector("#gD").value || null }];
    await savePrefs(p, "Doel toegevoegd"); rerender();
  };
  C.view.querySelectorAll("[data-gdel]").forEach((b) => (b.onclick = async () => {
    const p = collect(); p.goals = p.goals.filter((_, i) => i !== Number(b.dataset.gdel)); await savePrefs(p, "Doel verwijderd"); rerender();
  }));

  // automatisch plannen
  C.view.querySelector("#plAuto").onclick = async (e) => {
    const p = collect();
    const planned = list.filter((s) => s.status === "gepland" && s.day >= C.today());
    if (planned.length && !confirm(`Er staan al ${planned.length} geplande sessies vanaf vandaag. Vervangen door een nieuw plan?`)) return;
    e.target.disabled = true;
    try {
      await savePrefs(p, "Plan wordt gemaakt…");
      for (const s of planned) await C.rpc("save_coach_session", { p: { id: s.id, delete: true } });
      const plan = buildPlan(p, days, list.filter((s) => s.status !== "gepland" || s.day < C.today()), R);
      for (const s of plan) await C.rpc("save_coach_session", { p: { ...s, source: "planner" } });
      C.toast(`${plan.length} sessies gepland`); rerender();
    } catch (er) { C.toast(er.message, 6000); e.target.disabled = false; }
  };
}

// Verdeel de sessies over de week. Alleen dagen vanaf vandaag; dagen met een gedane training tellen mee.
export function buildPlan(p, days, keep, R) {
  const today = C.today();
  const free = days.map((d, i) => ({ d, i, pref: p.days[i] || "flex" })).filter((x) => x.d >= today && !keep.some((s) => s.day === x.d));
  const doneK = keep.filter((s) => s.status === "gedaan" && (s.category === "kracht" || !["z2", "rust"].includes(s.kind))).length;
  const doneC = keep.filter((s) => s.status === "gedaan" && (s.category === "cardio" || s.kind === "z2")).length;
  let needK = Math.max(0, p.strength_per_week - doneK), needC = Math.max(0, p.cardio_per_week - doneC);
  const out = [];
  const take = (wants) => free.filter((x) => wants.includes(x.pref) && !x.used);
  // kracht: eerst krachtdagen, dan beide, dan flexibel; nooit twee dagen kracht na elkaar als het anders kan
  const routines = (R.routines || []).filter((r) => p.folder_id && r.folder_id === p.folder_id);
  let ri = 0;
  for (const pool of [["kracht"], ["beide"], ["flex"]]) {
    for (const x of take(pool)) { if (!needK) break; x.used = "k"; needK--;
      const r = routines.length ? routines[ri++ % routines.length] : null;
      out.push({ day: x.d, category: "kracht", title: r ? r.name : "Krachttraining", routine_id: r?.id || null, duration_min: p.strength_min,
        details: r ? (r.exercises || []).map((e) => `${e.title}${e.sets ? ` ${e.sets}×${e.reps || ""}` : ""}`.replace(/×$/, " sets")).join(" · ") : null });
    }
  }
  // cardio: cardiodagen, beide (ook op een krachtdag), flexibel
  const types = p.cardio_types.length ? p.cardio_types : ["lopen"];
  let ci = 0, intervals = p.focus === "mix" ? 1 : p.focus === "intervallen" ? 99 : 0;
  for (const pool of [["cardio"], ["beide"], ["flex"]]) {
    for (const x of free.filter((f) => pool.includes(f.pref) && f.used !== "c")) { if (!needC) break;
      if (x.used === "k" && pool[0] !== "beide") continue;
      x.used = x.used ? x.used + "c" : "c"; needC--;
      const t = types[ci++ % types.length]; const iv = intervals-- > 0;
      out.push({ day: x.d, category: "cardio", cardio_type: t, duration_min: iv ? Math.min(p.cardio_min, 40) : p.cardio_min,
        title: `${label(CARDIO, t)} · ${iv ? "intervallen" : "zone 2"}`,
        details: iv ? "Opwarmen 10 min · 6× 2 min stevig + 2 min rustig · Afkoelen 5 min" : "Rustig tempo: je kan nog praten · Zone 2" });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

function editSession(s, days, R, prefs, after) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const cat = s.category || (s.kind === "z2" ? "cardio" : s.kind === "rust" ? "rust" : s.id ? "kracht" : "kracht");
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Sessie">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${s.id ? "Sessie aanpassen" : "Sessie toevoegen"}</h3>
      <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
    <div class="seg" style="margin:12px 0" role="group">${[["kracht", "Kracht"], ["cardio", "Cardio"]].map(([k, l]) => `<button type="button" data-cat="${k}" aria-pressed="${cat === k}">${l}</button>`).join("")}</div>
    <div class="field"><label for="eDay">Dag</label><select class="input" id="eDay">${days.map((d, i) => `<option value="${d}" ${d === s.day ? "selected" : ""}>${WDL[i]} ${new Date(d + "T12:00:00Z").getUTCDate()}</option>`).join("")}</select></div>
    <div id="eK" ${cat === "kracht" ? "" : "hidden"}>
      <div class="field"><label for="eR">Routine</label><select class="input" id="eR"><option value="">Zonder routine</option>
        ${(R.routines || []).map((r) => `<option value="${r.id}" ${r.id === s.routine_id ? "selected" : ""}>${C.esc(r.name)}</option>`).join("")}</select></div>
    </div>
    <div id="eC" ${cat === "cardio" ? "" : "hidden"}>
      <div class="field"><label for="eT">Soort</label><select class="input" id="eT">${CARDIO.map(([k, l]) => `<option value="${k}" ${k === s.cardio_type ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="eI">Intensiteit</label><select class="input" id="eI"><option value="zone 2">Zone 2</option><option value="intervallen" ${/interval/i.test(s.title || "") ? "selected" : ""}>Intervallen</option><option value="rustig">Herstel, rustig</option></select></div>
    </div>
    <div class="field"><label for="eM">Duur (min)</label><input class="input" id="eM" type="number" min="5" max="300" step="5" value="${s.duration_min || (cat === "cardio" ? prefs.cardio_min : prefs.strength_min)}"></div>
    <div class="field"><label for="eN">Titel (optioneel)</label><input class="input" id="eN" value="${C.esc(s.id ? s.title.replace(/^[^\p{L}\d]+/u, "") : "")}" placeholder="wordt automatisch ingevuld"></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="eSave">Opslaan</button>${s.id ? `<button class="btn danger" id="eDel">Verwijderen</button>` : ""}</div>
  </div>`;
  document.body.appendChild(sheet);
  const $ = (q) => sheet.querySelector(q);
  let c = cat;
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("[data-close]")) sheet.remove(); });
  sheet.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => {
    c = b.dataset.cat; sheet.querySelectorAll("[data-cat]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#eK").hidden = c !== "kracht"; $("#eC").hidden = c !== "cardio";
    $("#eM").value = c === "cardio" ? prefs.cardio_min : prefs.strength_min;
  }));
  $("#eSave").onclick = async () => {
    const r = (R.routines || []).find((x) => x.id === $("#eR").value);
    const t = $("#eT").value;
    const title = $("#eN").value.trim() || (c === "kracht" ? (r?.name || "Krachttraining") : `${label(CARDIO, t)} · ${$("#eI").value}`);
    const p = { id: s.id || undefined, day: $("#eDay").value, category: c, title, duration_min: Number($("#eM").value) || null,
      routine_id: c === "kracht" ? (r?.id || "") : "", cardio_type: c === "cardio" ? t : null,
      details: c === "kracht" && r ? (r.exercises || []).map((e) => `${e.title}${e.sets ? ` ${e.sets} sets` : ""}`).join(" · ") : (s.details ?? null) };
    try { await C.rpc("save_coach_session", { p }); sheet.remove(); C.toast("Opgeslagen"); after(); }
    catch (e) { C.toast(e.message, 5000); }
  };
  $("#eDel")?.addEventListener("click", async () => {
    if (!confirm("Deze sessie verwijderen?")) return;
    await C.rpc("save_coach_session", { p: { id: s.id, delete: true } }); sheet.remove(); after();
  });
}
