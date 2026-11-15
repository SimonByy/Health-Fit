// Intervaltimer voor run-walk en intervallen (gratis). Zegt hardop "lopen" / "wandelen", piept en trilt;
// het scherm blijft aan. Loopt op de klok, dus hij raakt niet achter als de telefoon even traag is.
let C, wake = null, raf = null, audio = null;
const PRESETS = [
  { id: "rw22", name: "Run-walk 2/2", warm: 5, on: 2, off: 2, reps: 6, cool: 5, onL: "Joggen", offL: "Wandelen" },
  { id: "rw11", name: "Run-walk 1/1", warm: 5, on: 1, off: 1, reps: 10, cool: 5, onL: "Joggen", offL: "Wandelen" },
  { id: "rw41", name: "Run-walk 4/1", warm: 5, on: 4, off: 1, reps: 5, cool: 5, onL: "Joggen", offL: "Wandelen" },
  { id: "int", name: "Intervallen 6×2′", warm: 10, on: 2, off: 2, reps: 6, cool: 5, onL: "Stevig", offL: "Rustig" },
];
const KEY = "hh-timer";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || PRESETS[0]; } catch { return PRESETS[0]; } };
const save = (c) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* geen opslag */ } };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function steps(c) {
  const out = [];
  if (c.warm > 0) out.push({ l: "Opwarmen", s: c.warm * 60, k: "warm" });
  for (let i = 0; i < c.reps; i++) {
    out.push({ l: c.onL, s: c.on * 60, k: "on", n: i + 1 });
    if (c.off > 0 && (i < c.reps - 1 || c.cool <= 0)) out.push({ l: c.offL, s: c.off * 60, k: "off", n: i + 1 });
  }
  if (c.cool > 0) out.push({ l: "Uitlopen", s: c.cool * 60, k: "cool" });
  return out;
}
function say(t) {
  try {
    const u = new SpeechSynthesisUtterance(t); u.lang = "nl-BE";
    const v = speechSynthesis.getVoices().find((x) => /^nl/i.test(x.lang)); if (v) u.voice = v;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { /* geen spraak */ }
}
function beep(f = 880, ms = 180) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = f; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(0.25, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
    o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch { /* geen geluid */ }
}
async function lock(on) {
  try { if (on && "wakeLock" in navigator) wake = await navigator.wakeLock.request("screen"); else { await wake?.release(); wake = null; } } catch { /* niet ondersteund */ }
}

export function renderTimer(ctx) {
  C = ctx;
  let c = load();
  const setup = () => {
    const total = steps(c).reduce((a, s) => a + s.s, 0);
    C.view.innerHTML = `<section class="panel">
      <h2 style="margin:0 0 4px">Intervaltimer</h2>
      <p class="small muted" style="margin:0 0 10px">Zegt hardop wanneer je wisselt, ook met je scherm in je zak (laat de app open).</p>
      <div class="chips">${PRESETS.map((p) => `<button class="chip ${p.id === c.id ? "on" : ""}" data-p="${p.id}">${p.name}</button>`).join("")}</div>
      <div class="grid2" style="margin-top:10px">
        ${[["warm", "Opwarmen (min)"], ["reps", "Herhalingen"], ["on", `${c.onL} (min)`], ["off", `${c.offL} (min)`], ["cool", "Uitlopen (min)"]].map(([k, l]) =>
          `<div class="field"><label for="t_${k}">${l}</label><input class="input" id="t_${k}" inputmode="decimal" value="${c[k]}"></div>`).join("")}
      </div>
      <p class="small" style="margin:6px 0 10px">Totaal <b>${Math.round(total / 60)} min</b>.</p>
      <button class="btn big-start" id="tGo" style="width:100%">Start</button></section>`;
    C.view.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { c = { ...PRESETS.find((p) => p.id === b.dataset.p) }; save(c); setup(); }));
    C.view.querySelectorAll("input").forEach((i) => (i.onchange = () => {
      const k = i.id.slice(2), v = Math.max(0, Number(i.value.replace(",", ".")) || 0);
      c = { ...c, id: "eigen", [k]: k === "reps" ? Math.max(1, Math.round(v)) : v }; save(c); setup();
    }));
    C.view.querySelector("#tGo").onclick = run;
  };
  const run = () => {
    const st = steps(c); if (!st.length) return;
    const ends = []; let t = 0; for (const s of st) { t += s.s; ends.push(t); }
    const t0 = Date.now(); let idx = -1, paused = 0, pauseAt = null, warned = -1;
    lock(true); beep(660, 120);
    C.view.innerHTML = `<section class="panel tm-run">
      <div class="tm-phase" id="tmP"></div><div class="tm-big" id="tmT"></div><div class="small muted" id="tmN"></div>
      <div class="tm-bar"><i id="tmB"></i></div><div class="small muted" id="tmR"></div>
      <div class="row" style="margin-top:14px"><button class="btn secondary" id="tmPause">Pauze</button><button class="btn ghost" id="tmStop">Stoppen</button></div></section>`;
    const $ = (id) => C.view.querySelector(id);
    const stop = (msg) => { cancelAnimationFrame(raf); clearInterval(raf); lock(false); if (msg) { say(msg); beep(523, 400); } setup(); };
    $("#tmStop").onclick = () => { if (confirm("Timer stoppen?")) stop(); };
    $("#tmPause").onclick = () => {
      if (pauseAt) { paused += Date.now() - pauseAt; pauseAt = null; $("#tmPause").textContent = "Pauze"; say("verder"); }
      else { pauseAt = Date.now(); $("#tmPause").textContent = "Verder"; }
    };
    const tick = () => {
      if (!$("#tmT")) { clearInterval(raf); lock(false); return; }
      const el = ((pauseAt || Date.now()) - t0 - paused) / 1000;
      if (el >= t) return stop("Klaar, goed gedaan!");
      const i = ends.findIndex((e) => el < e);
      if (i !== idx) {
        idx = i; const s = st[i];
        $("#tmP").textContent = s.l; $("#tmP").className = `tm-phase ${s.k}`;
        $("#tmN").textContent = s.n ? `${s.n} van ${c.reps}` : "";
        say(s.n && s.k === "on" ? `${s.l}, ${s.n} van ${c.reps}` : s.l); beep(s.k === "on" ? 988 : 660); navigator.vibrate?.(s.k === "on" ? [200, 80, 200] : 300);
      }
      const left = ends[i] - el;
      if (left <= 3 && warned !== i && i < st.length - 1) { warned = i; beep(440, 90); }
      $("#tmT").textContent = mmss(Math.ceil(left));
      $("#tmB").style.width = `${(el / t) * 100}%`;
      $("#tmR").textContent = `Nog ${mmss(Math.ceil(t - el))} in totaal`;
    };
    raf = setInterval(tick, 100); tick();
  };
  setup();
  addEventListener("hashchange", () => { clearInterval(raf); lock(false); }, { once: true });
}
