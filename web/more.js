// Agenda, gewoontes, lichaamsmaten en export.
const WD = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];
const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function sheetEl(label) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${label}"></div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet._close = close;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  return { sheet, card: sheet.firstElementChild, close };
}

// ---------------- agenda ----------------
export function openCalendar(C, { current, onPick }) {
  const { card, close } = sheetEl("Agenda");
  const t = C.today();
  let ym = current.slice(0, 7);
  const cache = {};

  async function draw() {
    const [y, m] = ym.split("-").map(Number);
    const first = `${ym}-01`;
    const dow = (new Date(first + "T12:00:00Z").getUTCDay() + 6) % 7; // 0 = maandag
    const start = C.addDays(first, -dow);
    const end = C.addDays(start, 41);
    card.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:nowrap">
        <button class="icon-btn" id="cPrev" aria-label="Vorige maand">‹</button>
        <h3 style="margin:0;text-transform:capitalize">${MONTHS[m - 1]} ${y}</h3>
        <button class="icon-btn" id="cNext" aria-label="Volgende maand" ${ym >= t.slice(0, 7) ? "disabled" : ""}>›</button>
        <button class="icon-btn" id="cClose" aria-label="Sluiten">✕</button></div>
      <div class="cal" id="cGrid">${WD.map((d) => `<span class="cal-wd">${d}</span>`).join("")}
        ${Array.from({ length: 42 }, (_, i) => C.addDays(start, i)).map((d) => `<button class="cal-d ${d.slice(0, 7) !== ym ? "out" : ""} ${d === t ? "today" : ""} ${d === current ? "sel" : ""}" data-d="${d}" ${d > t ? "disabled" : ""}>
          <span>${Number(d.slice(8))}</span><i class="dots"></i></button>`).join("")}</div>
      <div class="cal-legend"><span><i style="background:var(--strength)"></i>kracht</span><span><i style="background:var(--move)"></i>cardio</span><span><i style="background:var(--fuel)"></i>voeding</span><span><i style="background:var(--sleep)"></i>dagboek</span></div>
      <div class="row" style="margin-top:10px"><button class="btn secondary" id="cToday" style="flex:1">Naar vandaag</button></div>`;
    card.querySelector("#cClose").onclick = close;
    card.querySelector("#cPrev").onclick = () => { ym = C.addDays(first, -1).slice(0, 7); draw(); };
    card.querySelector("#cNext").onclick = () => { ym = C.addDays(C.addDays(first, 31), 0).slice(0, 7); if (ym <= t.slice(0, 7)) draw(); };
    card.querySelector("#cToday").onclick = () => { close(); onPick(t); };
    card.querySelector("#cGrid").onclick = (e) => {
      const b = e.target.closest(".cal-d"); if (!b || b.disabled) return;
      close(); onPick(b.dataset.d);
    };
    const key = start;
    try {
      cache[key] ||= await C.rpc("get_calendar", { p_from: start, p_to: end < t ? end : t });
      for (const r of cache[key]) {
        const el = card.querySelector(`.cal-d[data-d="${r.day}"] .dots`);
        if (!el) continue;
        el.innerHTML = (r.strength ? `<i style="background:var(--strength)"></i>` : "") + (r.cardio ? `<i style="background:var(--move)"></i>` : "")
          + (r.kcal ? `<i style="background:var(--fuel)"></i>` : "") + (r.journal ? `<i style="background:var(--sleep)"></i>` : "");
      }
    } catch { /* agenda werkt ook zonder stippen */ }
  }
  draw();
}

// ---------------- gewoontes ----------------
const HABIT_IDEAS = [["Creatine", "💊"], ["Vitamine D", "☀️"], ["Stretchen", "🧘"], ["10.000 stappen", "🚶"], ["Geen alcohol", "🚫"], ["Lezen", "📖"]];

// Voorraad: dagen over = porties over / porties per dag
const daysLeft = (h) => (h.stock_left == null ? null : Math.floor(Number(h.stock_left) / (Number(h.per_dose) || 1)));
const stockLow = (h) => daysLeft(h) != null && daysLeft(h) <= (h.stock_alert_days || 7);
const stockTxt = (h) => (daysLeft(h) <= 0 ? "op" : `nog ${daysLeft(h)} d`);

export async function renderHabits(C, day, box) {
  const list = await C.rpc("get_habits", { p_day: day });
  if (!list.length) {
    box.innerHTML = `<p class="muted small" style="margin:6px 0 8px">Vink dagelijks gewoontes of supplementen af en zie je reeks. Tik om toe te voegen:</p>
      <div class="chips" style="margin-bottom:12px">${HABIT_IDEAS.map(([n, e]) => `<button class="chip" data-new="${n}" data-e="${e}">${e} ${n}</button>`).join("")}</div>`;
    box.querySelectorAll("[data-new]").forEach((b) => (b.onclick = async () => {
      await C.rpc("save_habit", { p: { name: b.dataset.new, emoji: b.dataset.e } });
      renderHabits(C, day, box);
    }));
    return;
  }
  box.innerHTML = `<div class="habits">${list.map((h) => `<button class="habit ${h.done ? "on" : ""}" data-id="${h.id}" aria-pressed="${h.done}">
      <span class="he">${C.esc(h.emoji || "✓")}</span><span class="hn">${C.esc(h.name)}</span>
      <span class="hs">${stockLow(h) ? `<span class="warn">${stockTxt(h)}</span>` : h.streak >= 2 ? `🔥 ${h.streak}` : `${h.last7}/7`}</span></button>`).join("")}</div>
    <a class="small muted" href="#/instellingen" style="display:inline-block;margin:6px 0 12px">Gewoontes beheren</a>`;
  box.querySelectorAll(".habit").forEach((b) => (b.onclick = async () => {
    b.classList.toggle("on");
    try { await C.rpc("toggle_habit", { p_id: b.dataset.id, p_day: day }); navigator.vibrate?.(20); renderHabits(C, day, box); }
    catch (e) { b.classList.toggle("on"); C.toast(e.message); }
  }));
}

export async function renderHabitSettings(C, box) {
  const list = await C.rpc("get_habits", { p_day: C.today() });
  box.innerHTML = `${list.map((h) => `<div class="habit-set" data-id="${h.id}">
      <div class="hs-main"><div class="t">${C.esc(h.emoji || "")} ${C.esc(h.name)}</div>
        <div class="m">${h.last7}/7 deze week${h.streak >= 2 ? ` · reeks ${h.streak} dagen` : ""}${daysLeft(h) != null ? ` · <span class="${stockLow(h) ? "warn" : ""}">voorraad ${daysLeft(h) <= 0 ? "op" : `± ${daysLeft(h)} dagen`}</span>` : ""}</div></div>
      <label class="switch" title="Herinnering"><input type="checkbox" data-remind ${h.remind ? "checked" : ""} aria-label="Herinnering voor ${C.esc(h.name)}"><span></span></label>
      <button class="icon-btn" data-del aria-label="${C.esc(h.name)} verwijderen">✕</button>
      <div class="hs-time" ${h.remind ? "" : "hidden"}><span class="small muted">Herinner me om</span>
        <input class="input" type="time" data-time value="${C.esc(h.remind_time || "19:00")}" aria-label="Uur"></div>
      <button class="link-btn small" data-stock>${h.stock_left == null ? "Voorraad bijhouden" : "Voorraad aanpassen"}</button>
    </div>`).join("") || `<p class="muted small">Nog geen gewoontes.</p>`}
    <form class="row" id="hf" style="margin-top:10px">
      <input class="input" id="hE" placeholder="🙂" aria-label="Emoji" style="max-width:64px;flex:none;text-align:center">
      <input class="input" id="hN" placeholder="bv. Creatine 5 g" aria-label="Naam" required>
      <button class="btn" type="submit">Toevoegen</button></form>
    <p class="small muted" style="margin:8px 0 0">Met de schakelaar krijg je een melding op het gekozen uur, alleen als je het die dag nog niet afvinkte.</p>`;
  const idOf = (el) => el.closest("[data-id]").dataset.id;
  box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Gewoonte verwijderen? Je geschiedenis blijft bewaard.")) return;
    await C.rpc("save_habit", { p: { id: idOf(b), archived: true } });
    renderHabitSettings(C, box);
  }));
  box.querySelectorAll("[data-remind]").forEach((t) => (t.onchange = async () => {
    const row = t.closest("[data-id]"); const time = row.querySelector("[data-time]").value || "19:00";
    row.querySelector(".hs-time").hidden = !t.checked;
    await C.rpc("save_habit", { p: { id: idOf(t), remind: t.checked, remind_time: time } });
    C.toast(t.checked ? `Herinnering aan om ${time}` : "Herinnering uit");
  }));
  box.querySelectorAll("[data-time]").forEach((t) => (t.onchange = async () => {
    await C.rpc("save_habit", { p: { id: idOf(t), remind_time: t.value } });
    C.toast(`Herinnering om ${t.value}`);
  }));
  box.querySelectorAll("[data-stock]").forEach((b) => (b.onclick = () => {
    const h = list.find((x) => x.id === idOf(b));
    const { card, close } = sheetEl("Voorraad");
    card.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Voorraad: ${C.esc(h.name)}</h3><button class="icon-btn" id="sClose" aria-label="Sluiten">✕</button></div>
      <p class="hint" style="margin-top:8px">Vul in hoeveel je nu in huis hebt. Elke keer dat je afvinkt, gaat er één portie af. Je krijgt een melding als het bijna op is.</p>
      <div class="grid2">
        <div class="field"><label for="sQ">Porties in huis</label><input class="input" id="sQ" inputmode="decimal" value="${h.stock_left ?? ""}" placeholder="bv. 60"></div>
        <div class="field"><label for="sU">Eenheid (optioneel)</label><input class="input" id="sU" value="${C.esc(h.stock_unit || "")}" placeholder="bv. scoops"></div>
        <div class="field"><label for="sP">Porties per keer</label><input class="input" id="sP" inputmode="decimal" value="${h.per_dose ?? 1}"></div>
        <div class="field"><label for="sA">Melding bij (dagen over)</label><input class="input" id="sA" inputmode="numeric" value="${h.stock_alert_days ?? 7}"></div>
      </div>
      <p class="small muted">Tip creatine: een pot van 500 g met 5 g per dag = 100 porties.</p>
      <div class="row" style="margin-top:10px"><button class="btn" id="sSave">Opslaan</button>${h.stock_left != null ? `<button class="btn ghost" id="sOff">Niet meer bijhouden</button>` : ""}</div>`;
    const num = (id) => { const v = card.querySelector(id).value.replace(",", ".").trim(); return v === "" ? null : Number(v); };
    card.querySelector("#sClose").onclick = close;
    const save = async (stock) => {
      try {
        await C.rpc("set_habit_stock", { p_id: h.id, p_stock: stock, p_per_dose: num("#sP") || 1, p_alert_days: num("#sA") || 7, p_unit: card.querySelector("#sU").value });
        close(); C.toast(stock == null ? "Voorraad uit" : "Voorraad opgeslagen"); renderHabitSettings(C, box);
      } catch (e) { C.toast(e.message, 5000); }
    };
    card.querySelector("#sSave").onclick = () => { const q = num("#sQ"); if (q == null || q < 0 || isNaN(q)) return C.toast("Vul het aantal porties in"); save(q); };
    card.querySelector("#sOff")?.addEventListener("click", () => save(null));
  }));
  box.querySelector("#hf").onsubmit = async (e) => {
    e.preventDefault();
    await C.rpc("save_habit", { p: { name: box.querySelector("#hN").value, emoji: box.querySelector("#hE").value.trim() || null } });
    renderHabitSettings(C, box);
  };
}

// ---------------- lichaamsmaten ----------------
export const BODY = [
  ["weight_body_mass", "Gewicht", "kg"], ["body_fat_percentage", "Vetpercentage", "%"], ["waist_circumference", "Taille", "cm"],
  ["chest_circumference", "Borst", "cm"], ["arm_circumference", "Bovenarm", "cm"], ["thigh_circumference", "Dij", "cm"], ["hip_circumference", "Heup", "cm"],
];

export function openMeasurements(C, { last = {}, after } = {}) {
  const { card, close } = sheetEl("Metingen");
  card.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">Metingen loggen</h3><button class="icon-btn" id="mClose" aria-label="Sluiten">✕</button></div>
    <p class="hint" style="margin-top:8px">Vul in wat je gemeten hebt; lege velden worden overgeslagen. Meet omtrekken altijd op dezelfde plek, 's ochtends.</p>
    <div class="grid2">${BODY.map(([k, l, u]) => `<div class="field"><label for="m_${k}">${l} (${u})</label>
      <input class="input" id="m_${k}" inputmode="decimal" placeholder="${last[k] != null ? C.fmt(last[k], 1) : ""}"></div>`).join("")}</div>
    <button class="btn" id="mSave" style="width:100%;margin-top:8px">Opslaan</button>`;
  card.querySelector("#mClose").onclick = close;
  card.querySelector("#mSave").onclick = async (e) => {
    const vals = BODY.map(([k, l]) => [k, l, Number(String(card.querySelector("#m_" + k).value).replace(",", "."))]).filter(([, , v]) => v > 0);
    if (!vals.length) return C.toast("Vul minstens één waarde in");
    e.target.disabled = true;
    try {
      for (const [k, , v] of vals) await C.rpc("log_entry", { p_metric: k, p_value: v });
      close(); C.toast(`${vals.length} meting${vals.length > 1 ? "en" : ""} opgeslagen`); after?.();
    } catch (err) { e.target.disabled = false; C.toast(err.message, 5000); }
  };
  setTimeout(() => card.querySelector("input")?.focus(), 50);
}

// ---------------- export ----------------
export async function exportAll(C, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Bezig…";
  try {
    const data = await C.rpc("export_all");
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `health-hub-backup-${C.today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    C.toast(`Back-up gemaakt (${Math.round(blob.size / 1024)} kB)`);
  } catch (e) { C.toast(e.message, 5000); }
  finally { btn.disabled = false; btn.textContent = old; }
}
