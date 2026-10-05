// Import van de Apple Health-export (Gezondheid-app → profiel → "Exporteer alle gezondheidsgegevens").
// Leest export.zip (of export.xml) in stukken, telt alles op per uur en ontdubbelt bronnen
// (bv. iPhone + Garmin tellen allebei stappen: per uur nemen we de bron met de hoogste waarde).
import { Unzip, UnzipInflate } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

const HK = {
  StepCount: "step_count",
  ActiveEnergyBurned: "active_energy",
  BasalEnergyBurned: "basal_energy_burned",
  DistanceWalkingRunning: "walking_running_distance",
  DistanceCycling: "cycling_distance",
  DistanceSwimming: "swimming_distance",
  AppleExerciseTime: "apple_exercise_time",
  AppleStandTime: "apple_stand_time",
  FlightsClimbed: "flights_climbed",
  TimeInDaylight: "time_in_daylight",
  RestingHeartRate: "resting_heart_rate",
  HeartRate: "heart_rate",
  HeartRateVariabilitySDNN: "heart_rate_variability",
  WalkingHeartRateAverage: "walking_heart_rate_average",
  VO2Max: "vo2_max",
  RespiratoryRate: "respiratory_rate",
  OxygenSaturation: "blood_oxygen_saturation",
  BodyMass: "weight_body_mass",
  BodyFatPercentage: "body_fat_percentage",
  LeanBodyMass: "lean_body_mass",
  BodyMassIndex: "body_mass_index",
  DietaryEnergyConsumed: "dietary_energy",
  DietaryProtein: "protein",
  DietaryCarbohydrates: "carbohydrates",
  DietaryFatTotal: "total_fat",
  DietaryFatSaturated: "saturated_fat",
  DietaryFatMonounsaturated: "monounsaturated_fat",
  DietaryFatPolyunsaturated: "polyunsaturated_fat",
  DietaryFiber: "fiber",
  DietarySugar: "dietary_sugar",
  DietaryCholesterol: "cholesterol",
  DietarySodium: "sodium",
  DietaryPotassium: "potassium",
  DietaryCalcium: "calcium",
  DietaryIron: "iron",
  DietaryMagnesium: "magnesium",
  DietaryZinc: "zinc",
  DietaryVitaminA: "vitamin_a",
  DietaryVitaminC: "vitamin_c",
  DietaryVitaminD: "vitamin_d",
  DietaryVitaminB12: "vitamin_b12",
  DietaryWater: "dietary_water",
  DietaryCaffeine: "dietary_caffeine",
};
const AVG = new Set(["heart_rate", "resting_heart_rate", "heart_rate_variability", "walking_heart_rate_average", "vo2_max",
  "respiratory_rate", "blood_oxygen_saturation", "weight_body_mass", "body_fat_percentage", "lean_body_mass", "body_mass_index"]);
const SLEEP = {
  HKCategoryValueSleepAnalysisAsleepCore: "Core",
  HKCategoryValueSleepAnalysisAsleepDeep: "Deep",
  HKCategoryValueSleepAnalysisAsleepREM: "REM",
  HKCategoryValueSleepAnalysisAwake: "Awake",
  HKCategoryValueSleepAnalysisInBed: "In Bed",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "Asleep",
  HKCategoryValueSleepAnalysisAsleep: "Asleep",
};

function attrs(s) {
  const o = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2];
  return o;
}
const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// "2026-03-29 18:46:00 +0200" -> epoch ms
function toMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return Date.parse(s);
  const off = (m[7] === "-" ? -1 : 1) * (+m[8] * 60 + +m[9]);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000;
}

function convert(metric, value, unit) {
  let v = Number(value);
  if (!Number.isFinite(v)) return null;
  switch (unit) {
    case "kJ": v /= 4.184; break;
    case "Cal": break;
    case "m": if (metric.endsWith("distance")) v /= 1000; break;
    case "mi": v *= 1.609344; break;
    case "yd": v *= 0.0009144; break;
    case "lb": v *= 0.45359237; break;
    case "L": v *= 1000; break;
    case "fl_oz_us": v *= 29.5735; break;
    case "g": if (metric === "weight_body_mass" || metric === "lean_body_mass") v /= 1000; break;
    case "%": if (v <= 1) v *= 100; break;
  }
  return v;
}

export class HealthExportParser {
  constructor({ since }) {
    this.since = since;            // "YYYY-MM-DD" (lokale datum, string-vergelijking)
    this.carry = "";
    this.hours = new Map();        // metric|hourKey|source -> {sum, n, min, max}
    this.sleep = [];               // {st, en, stage, src}
    this.workouts = [];
    this.seenDiet = new Set();
    this.records = 0;
  }

  push(text, final = false) {
    const buf = this.carry + text;
    let cut = final ? buf.length : buf.lastIndexOf("\n") + 1;
    // niet midden in een blok (Workout/Correlation) knippen
    for (const tag of ["Workout", "Correlation"]) {
      if (final) break;
      const open = buf.lastIndexOf(`<${tag} `, cut);
      if (open < 0) continue;
      const gt = buf.indexOf(">", open);
      if (gt >= 0 && buf[gt - 1] === "/") continue; // zelfsluitend
      const close = buf.indexOf(`</${tag}>`, open);
      if (close < 0 || close + tag.length + 3 > cut) cut = Math.min(cut, open);
    }
    this.carry = buf.slice(cut);
    this.scan(buf.slice(0, cut));
  }

  scan(part) {
    const reRec = /<Record\s([^>]*?)\/?>/g;
    let m;
    while ((m = reRec.exec(part))) this.record(m[1]);
    const reW = /<Workout\s([^>]*?)(\/>|>([\s\S]*?)<\/Workout>)/g;
    while ((m = reW.exec(part))) this.workout(m[1], m[3] || "");
  }

  record(raw) {
    const t = /type="([^"]+)"/.exec(raw)?.[1];
    if (!t) return;
    const sd = /startDate="([^"]+)"/.exec(raw)?.[1];
    if (!sd || sd.slice(0, 10) < this.since) return;
    if (t === "HKCategoryTypeIdentifierSleepAnalysis") {
      const a = attrs(raw);
      const stage = SLEEP[a.value];
      if (!stage) return;
      this.sleep.push({ st: a.startDate, en: a.endDate, stage, src: unesc(a.sourceName || "") });
      this.records++;
      return;
    }
    if (!t.startsWith("HKQuantityTypeIdentifier")) return;
    const metric = HK[t.slice(24)];
    if (!metric) return;
    const a = attrs(raw);
    if (metric.startsWith("dietary") || ["protein", "carbohydrates", "total_fat", "saturated_fat", "monounsaturated_fat",
      "polyunsaturated_fat", "fiber", "cholesterol", "sodium", "potassium", "calcium", "iron", "magnesium", "zinc"].includes(metric)
      || metric.startsWith("vitamin")) {
      const key = `${t}|${a.startDate}|${a.endDate}|${a.value}|${a.sourceName}`;
      if (this.seenDiet.has(key)) return; // voedingswaarden staan soms dubbel (ook in maaltijd-correlaties)
      this.seenDiet.add(key);
    }
    const v = convert(metric, a.value, a.unit);
    if (v === null) return;
    // uur-sleutel in lokale tijd van de meting: "YYYY-MM-DD HH" + offset
    const hourKey = `${sd.slice(0, 13)}:00:00 ${sd.slice(20)}`;
    const k = `${metric}|${hourKey}|${unesc(a.sourceName || "")}`;
    const h = this.hours.get(k);
    if (h) { h.sum += v; h.n++; if (v < h.min) h.min = v; if (v > h.max) h.max = v; }
    else this.hours.set(k, { sum: v, n: 1, min: v, max: v });
    this.records++;
  }

  workout(rawAttrs, inner) {
    const a = attrs(rawAttrs);
    if (!a.startDate || a.startDate.slice(0, 10) < this.since) return;
    const stats = {};
    const reS = /<WorkoutStatistics\s([^>]*?)\/?>/g;
    let m;
    while ((m = reS.exec(inner))) { const s = attrs(m[1]); stats[s.type] = s; }
    const dist = stats.HKQuantityTypeIdentifierDistanceWalkingRunning || stats.HKQuantityTypeIdentifierDistanceCycling
      || stats.HKQuantityTypeIdentifierDistanceSwimming;
    const kcal = stats.HKQuantityTypeIdentifierActiveEnergyBurned;
    const hr = stats.HKQuantityTypeIdentifierHeartRate;
    const durMin = a.durationUnit === "s" ? Number(a.duration) / 60 : a.durationUnit === "h" || a.durationUnit === "hr" ? Number(a.duration) * 60 : Number(a.duration);
    const type = (a.workoutActivityType || "Workout").replace("HKWorkoutActivityType", "").replace(/([a-z])([A-Z])/g, "$1 $2");
    const w = {
      id: "ah-" + hash(`${a.workoutActivityType}|${a.startDate}|${a.sourceName}`),
      name: type,
      start: a.startDate,
      end: a.endDate,
      duration: Number.isFinite(durMin) ? durMin * 60 : undefined,
      source: unesc(a.sourceName || ""),
    };
    if (dist?.sum) w.distance = { qty: Number(dist.sum), units: dist.unit };
    else if (a.totalDistance) w.distance = { qty: Number(a.totalDistance), units: a.totalDistanceUnit };
    if (kcal?.sum) w.activeEnergyBurned = { qty: Number(kcal.sum), units: kcal.unit === "Cal" ? "kcal" : kcal.unit };
    else if (a.totalEnergyBurned) w.activeEnergyBurned = { qty: Number(a.totalEnergyBurned), units: a.totalEnergyBurnedUnit === "Cal" ? "kcal" : a.totalEnergyBurnedUnit };
    if (hr?.average) w.heartRate = { avg: { qty: Number(hr.average), units: "bpm" }, max: hr.maximum ? { qty: Number(hr.maximum), units: "bpm" } : undefined };
    this.workouts.push(w);
  }

  // Resultaat als Health Auto Export-JSON, in batches
  result() {
    // 1) metrics: per metric+uur over bronnen samenvoegen
    const per = new Map(); // metric -> Map(hourKey -> {qty, min, max, avg, src})
    for (const [k, h] of this.hours) {
      const [metric, hourKey, src] = k.split("|");
      if (!per.has(metric)) per.set(metric, new Map());
      const mm = per.get(metric);
      const cur = mm.get(hourKey);
      if (AVG.has(metric)) {
        if (!cur) mm.set(hourKey, { sum: h.sum, n: h.n, min: h.min, max: h.max, src });
        else { cur.sum += h.sum; cur.n += h.n; cur.min = Math.min(cur.min, h.min); cur.max = Math.max(cur.max, h.max); }
      } else if (!cur || h.sum > cur.sum) {
        mm.set(hourKey, { sum: h.sum, src }); // som-metrics: bron met hoogste waarde (ontdubbelen)
      }
    }
    const metrics = [];
    for (const [metric, mm] of per) {
      const data = [];
      for (const [hourKey, v] of mm) {
        if (AVG.has(metric)) {
          const avg = v.sum / v.n;
          data.push({ date: hourKey, qty: avg, Min: v.min, Avg: avg, Max: v.max, source: v.src });
        } else data.push({ date: hourKey, qty: v.sum, source: v.src });
      }
      metrics.push({ name: metric, units: "", data });
    }
    // 2) slaap: per nacht de bron met de meeste slaap
    const nights = new Map();
    for (const s of this.sleep) {
      const end = toMs(s.en);
      const night = new Date(end + 12 * 3600e3).toISOString().slice(0, 10);
      const key = `${night}|${s.src}`;
      if (!nights.has(key)) nights.set(key, { night, src: s.src, asleep: 0, segs: [] });
      const n = nights.get(key);
      n.segs.push(s);
      if (s.stage !== "Awake" && s.stage !== "In Bed") n.asleep += end - toMs(s.st);
    }
    const best = new Map();
    for (const n of nights.values()) if (!best.has(n.night) || n.asleep > best.get(n.night).asleep) best.set(n.night, n);
    const sleepData = [];
    for (const n of best.values()) for (const s of n.segs) sleepData.push({ startDate: s.st, endDate: s.en, value: s.stage, source: s.src });
    if (sleepData.length) metrics.push({ name: "sleep_analysis", units: "hr", data: sleepData });

    // 3) batches van ~4000 regels
    const batches = [];
    let cur = { metrics: [], workouts: [] }, size = 0;
    const flush = () => { if (size) batches.push({ data: cur }); cur = { metrics: [], workouts: [] }; size = 0; };
    for (const m of metrics) {
      for (let i = 0; i < m.data.length; i += 4000) {
        const chunk = m.data.slice(i, i + 4000);
        if (size + chunk.length > 4000) flush();
        cur.metrics.push({ name: m.name, units: m.units, data: chunk });
        size += chunk.length;
      }
    }
    for (let i = 0; i < this.workouts.length; i += 300) { flush(); cur.workouts = this.workouts.slice(i, i + 300); size = cur.workouts.length; }
    flush();
    const stats = {
      records: this.records,
      metrics: metrics.filter((m) => m.name !== "sleep_analysis").length,
      hours: metrics.reduce((s, m) => s + (m.name === "sleep_analysis" ? 0 : m.data.length), 0),
      sleepNights: best.size,
      workouts: this.workouts.length,
    };
    return { batches, stats };
  }
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

// Leest een File (zip of xml) en geeft { batches, stats } terug. onProgress(fractie 0..1)
export async function parseHealthExport(file, { since, onProgress } = {}) {
  const parser = new HealthExportParser({ since });
  const decoder = new TextDecoder();
  const isZip = /\.zip$/i.test(file.name) || file.type.includes("zip");
  let found = false;

  if (!isZip) {
    found = true;
    const reader = file.stream().getReader();
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      parser.push(decoder.decode(value, { stream: true }));
      onProgress?.(read / file.size);
    }
    parser.push(decoder.decode(), true);
  } else {
    let finished = false;
    const uz = new Unzip((f) => {
      const name = f.name.toLowerCase();
      if (found || !name.endsWith(".xml") || name.includes("cda") || !/(^|\/)export\.xml$|apple_health_export\/[^/]+\.xml$/.test(name)) return;
      found = true;
      f.ondata = (err, chunk, final) => {
        if (err) throw err;
        parser.push(decoder.decode(chunk, { stream: !final }), final);
        if (final) finished = true;
      };
      f.start();
    });
    uz.register(UnzipInflate);
    const reader = file.stream().getReader();
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { uz.push(new Uint8Array(0), true); break; }
      read += value.length;
      uz.push(value);
      onProgress?.(read / file.size);
      if (finished) break;
    }
  }
  if (!found) throw new Error("Geen export.xml gevonden. Kies het bestand export.zip uit de Gezondheid-app.");
  return parser.result();
}
