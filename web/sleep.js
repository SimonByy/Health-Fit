// Bedtijd-coach (gratis): wekker door de week en in het weekend + slaapdoel → wanneer je in bed moet liggen.
let C;
const DEF = { wake_weekday: "07:00", wake_weekend: "09:00", remind: false, lead_min: 30 };
const FALL_ASLEEP = 15; // minuten om in slaap te vallen

export function bedtime(s, sleepH, now = new Date()) {
  s = { ...DEF, ...(s || {}) };
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const wk = [0, 6].includes(tomorrow.getDay());
  const wake = wk ? s.wake_weekend : s.wake_weekday;
  const [h, m] = wake.split(":").map(Number);
  const w = new Date(tomorrow); w.setHours(h, m, 0, 0);
  const bed = new Date(w - ((Number(sleepH) || 8) * 60 + FALL_ASLEEP) * 6e4);
  return { bed, wake, weekend: wk };
}
const hm = (d) => d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" });

// Kaart op Vandaag, alleen 's avonds
export async function renderBedCard(ctx, el, goals) {
  C = ctx;
  const now = new Date();
  if (now.getHours() < 18) { el.innerHTML = ""; return; }
  const s = await C.rpc("get_setting", { p_key: "sleep" }).catch(() => null);
  if (!s) { el.innerHTML = ""; return; }
  const b = bedtime(s, goals?.sleep_h, now);
  const left = Math.round((b.bed - now) / 6e4);
  el.innerHTML = `<section class="panel bed-card">
    <div><span class="small muted">Bedtijd vanavond</span><b>${hm(b.bed)}</b></div>
    <p class="small" style="margin:0">${left > 60 ? `Nog ${Math.floor(left / 60)} u ${left % 60} min.` : left > 0 ? `Nog ${left} min: schermen weg en licht dimmen.` : "Tijd om te gaan slapen."}
      Wekker ${C.esc(b.wake)}${b.weekend ? " (weekend)" : ""}, ${C.fmt(goals?.sleep_h || 8, 1)} u slaap.</p></section>`;
}

export async function renderSleepSettings(ctx, el) {
  C = ctx;
  const s = { ...DEF, ...((await C.rpc("get_setting", { p_key: "sleep" }).catch(() => null)) || {}) };
  const goals = (await C.rpc("get_setting", { p_key: "goals" }).catch(() => null)) || {};
  const draw = () => {
    const b = bedtime(s, goals.sleep_h);
    el.innerHTML = `<p class="hint">Vul in wanneer je wekker gaat. Met je slaapdoel (${C.fmt(goals.sleep_h || 8, 1)} u, aan te passen bij Doelen) rekent de app uit wanneer je in bed moet liggen; 's avonds staat dat op Vandaag.</p>
      <div class="grid2">
        <div class="field"><label for="slW">Wekker ma–vr</label><input class="input" type="time" id="slW" value="${C.esc(s.wake_weekday)}"></div>
        <div class="field"><label for="slE">Wekker za–zo</label><input class="input" type="time" id="slE" value="${C.esc(s.wake_weekend)}"></div>
      </div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span>Melding voor bedtijd</span>
        <label class="switch"><input type="checkbox" id="slR" ${s.remind ? "checked" : ""} aria-label="Melding voor bedtijd"><span></span></label></div>
      <div class="field" ${s.remind ? "" : "hidden"} id="slLeadF"><label for="slL">Hoeveel minuten vooraf</label>
        <select class="input" id="slL">${[15, 30, 45, 60].map((m) => `<option ${m === Number(s.lead_min) ? "selected" : ""}>${m}</option>`).join("")}</select></div>
      <p class="small" style="margin:8px 0 0">Vanavond in bed om <b>${hm(b.bed)}</b> (wekker ${C.esc(b.wake)}).</p>`;
    const save = async () => {
      s.wake_weekday = el.querySelector("#slW").value || "07:00"; s.wake_weekend = el.querySelector("#slE").value || "09:00";
      s.remind = el.querySelector("#slR").checked; s.lead_min = Number(el.querySelector("#slL").value) || 30;
      try { await C.rpc("set_setting", { p_key: "sleep", p_value: s }); C.toast("Opgeslagen"); draw(); } catch (e) { C.toast(e.message, 5000); }
    };
    el.querySelectorAll("input,select").forEach((i) => (i.onchange = save));
  };
  draw();
}
