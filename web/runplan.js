// Loopplan naar een wedstrijd (Premium), in de geest van Runna:
// fases basis → opbouw → piek → taper, wekelijkse opbouw van max ±10 %, elke 4e week lichter,
// een lange duurloop die groeit naar de wedstrijd toe, vanaf de opbouwfase één kwaliteitstraining per week.
// Startpunt = je echte runs van de laatste 4 weken. De AI-coach past elke week de omvang aan (adjust[week]).
export const RACES = [["5k", "5 km", 5, 45], ["10k", "10 km", 10, 70], ["hm", "Halve marathon", 21.1, 120], ["m", "Marathon", 42.2, 180]];
const WDL = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monday = (iso) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
const r5 = (x) => Math.max(10, Math.round(x / 5) * 5);

export function phaseOf(i, n) {
  if (i >= n - 1) return "wedstrijd";
  if (i >= n - 3) return "taper";
  const f = i / Math.max(1, n - 3);
  return f < 0.45 ? "basis" : f < 0.8 ? "opbouw" : "piek";
}
export const PHASE_TXT = {
  basis: "Basis: rustig volume opbouwen in zone 2.",
  opbouw: "Opbouw: langere duurloop en één keer per week intervallen.",
  piek: "Piek: je zwaarste weken, met tempoloop op wedstrijdtempo.",
  taper: "Taper: minder volume zodat je fris aan de start staat.",
  wedstrijd: "Wedstrijdweek: kort en rustig, en dan knallen.",
};

// Bouwt alle weken van nu tot de wedstrijd
export function buildRunPlan(rp, stats, today) {
  const race = RACES.find((r) => r[0] === rp.race) || RACES[2];
  const start = monday(rp.created || today), raceDay = rp.date;
  const n = Math.max(2, Math.round((new Date(monday(raceDay) + "T12:00:00Z") - new Date(start + "T12:00:00Z")) / (7 * 864e5)) + 1);
  const runs = Math.min(5, Math.max(2, rp.runs_per_week || 3));
  const longDay = rp.long_day ?? 6;
  const days = pickDays(runs, longDay, rp.days);
  let long = Math.max(25, rp.base_long_min ?? stats.longest_min_4w ?? 0);
  const peakLong = race[3];
  let weekly = Math.max(runs * 20, rp.base_week_min ?? stats.avg_week_min_4w ?? 0);
  const weeks = [];
  for (let i = 0; i < n; i++) {
    const phase = phaseOf(i, n);
    const recovery = (i + 1) % 4 === 0 && phase !== "taper" && phase !== "wedstrijd";
    if (i > 0 && !recovery && phase !== "taper" && phase !== "wedstrijd") {
      weekly = weekly * 1.08;
      long = Math.min(peakLong, long + (long < 60 ? 4 : 5));
    }
    const adj = Number(rp.adjust?.[i]?.factor) || 1;
    let wk = weekly * (recovery ? 0.75 : 1) * adj, lg = Math.min(long, weekly * 0.45) * (recovery ? 0.8 : 1) * adj;
    if (phase === "taper") { const t = i === n - 3 ? 0.7 : 0.55; wk = weekly * t; lg = Math.min(long, weekly * 0.45) * t; }
    const ws = addDays(start, i * 7);
    const sessions = [];
    if (phase === "wedstrijd") {
      const rdIdx = (new Date(raceDay + "T12:00:00Z").getUTCDay() + 6) % 7;
      days.filter((d) => d !== rdIdx && d < rdIdx).slice(-2).forEach((d, k) => sessions.push({ dow: d, type: "easy", min: k ? 20 : 30, title: "Rustige duurloop" }));
      sessions.push({ dow: rdIdx, type: "race", min: Math.round(race[3] * 0.85), title: `${race[1]} – wedstrijd` });
    } else {
      const quality = phase === "opbouw" || phase === "piek" ? (phase === "piek" ? "tempo" : "interval") : null;
      const others = days.filter((d) => d !== longDay);
      const rest = Math.max(runs - 1, 1);
      const eachEasy = Math.max(20, (wk - lg) / rest);
      others.forEach((d, k) => {
        if (quality && k === Math.floor(others.length / 2) && !recovery) sessions.push(quality === "interval"
          ? { dow: d, type: "interval", min: r5(Math.min(50, eachEasy + 5)), title: "Intervallen" }
          : { dow: d, type: "tempo", min: r5(Math.min(55, eachEasy + 5)), title: "Tempoloop" });
        else sessions.push({ dow: d, type: "easy", min: r5(eachEasy), title: "Rustige duurloop" });
      });
      sessions.push({ dow: longDay, type: "long", min: r5(lg), title: "Lange duurloop" });
    }
    sessions.sort((a, b) => a.dow - b.dow);
    weeks.push({ i, start: ws, phase, recovery, total: sessions.reduce((s, x) => s + x.min, 0), sessions, note: rp.adjust?.[i]?.note || null });
  }
  return { race, n, weeks };
}

function pickDays(runs, longDay, pref) {
  if (Array.isArray(pref) && pref.length >= runs) return [...new Set([longDay, ...pref])].slice(0, runs).sort((a, b) => a - b);
  // verspreid over de week, nooit twee dagen na elkaar als het kan, lange duurloop op zijn dag
  const pattern = { 2: [2], 3: [1, 3], 4: [0, 2, 4], 5: [0, 1, 3, 4] }[runs];
  return [longDay, ...pattern.map((o) => (longDay + 1 + o) % 7)].filter((v, i, a) => a.indexOf(v) === i).slice(0, runs).sort((a, b) => a - b);
}

export function sessionDetails(s, stats) {
  const easy = stats?.easy_pace ? `${Math.floor(stats.easy_pace)}:${String(Math.round((stats.easy_pace % 1) * 60)).padStart(2, "0")}/km of trager` : "praattempo";
  return {
    easy: `Zone 2, ${easy} · je kan nog praten`,
    long: "Heel rustig tempo, zone 2 · drink onderweg als het langer dan een uur is",
    interval: "10 min inlopen · 6× 3 min stevig + 2 min wandelen/joggen · 10 min uitlopen",
    tempo: "15 min inlopen · 2× 10 min op wedstrijdtempo met 3 min rustig · uitlopen",
    race: "Rustig starten, de eerste km's bewust trager dan je wil. Succes!",
  }[s.type];
}

export { WDL, monday, addDays };

// ---- Racevoorspelling (Riegel, T2 = T1 × (D2/D1)^1.06) en richttempo's ----
export const fmtTime = (sec) => { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`; };
export const fmtPace = (secPerKm) => `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, "0")}`;
export function parseTime(txt) {
  const p = String(txt || "").trim().split(":").map(Number); if (!p.length || p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 3600 + p[1] * 60 : null;
}
export function predictRace(runs, km) {
  const ok = (runs || []).filter((r) => Number(r.km) >= 2.5 && Number(r.min) > 0);
  if (!ok.length) return null;
  const best = ok.map((r) => ({ r, t: Number(r.min) * 60 * Math.pow(km / Number(r.km), 1.06) })).sort((a, b) => a.t - b.t)[0];
  const t5 = Number(best.r.min) * 60 * Math.pow(5 / Number(best.r.km), 1.06);
  const p5 = t5 / 5;  // seconden per km op 5 km
  return { sec: best.t, from: best.r, paces: {
    rustig: [p5 + 75, p5 + 120], tempo: [p5 + 20, p5 + 35], interval: [p5 - 5, p5 + 5] } };
}
