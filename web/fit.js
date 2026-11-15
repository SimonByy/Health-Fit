// Garmin-workoutbestand (.FIT) maken, volgens het FIT SDK "workout"-formaat. Zonder Garmin-koppeling:
// het bestand kopieer je via USB naar GARMIN/NewFiles op je horloge.
const CRC = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
function crc16(bytes, crc = 0) {
  for (const b of bytes) {
    let t = CRC[crc & 0xf]; crc = (crc >> 4) & 0x0fff; crc = crc ^ t ^ CRC[b & 0xf];
    t = CRC[crc & 0xf]; crc = (crc >> 4) & 0x0fff; crc = crc ^ t ^ CRC[(b >> 4) & 0xf];
  }
  return crc;
}
const ENUM = 0x00, U16 = 0x84, U32 = 0x86, U32Z = 0x8c, STR = 0x07;
const SIZE = { [ENUM]: 1, [U16]: 2, [U32]: 4, [U32Z]: 4 };
const INV = { [ENUM]: 0xff, [U16]: 0xffff, [U32]: 0xffffffff, [U32Z]: 0 };

class Writer {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  u32(v) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
  // velden: [nummer, basistype, grootte(alleen string)]
  define(local, global, fields) {
    this.u8(0x40 | local); this.u8(0); this.u8(0); this.u16(global); this.u8(fields.length);
    for (const [num, type, size] of fields) { this.u8(num); this.u8(type === STR ? size : SIZE[type]); this.u8(type); }
  }
  data(local, fields, values) {
    this.u8(local);
    fields.forEach(([, type, size], i) => {
      const v = values[i];
      if (type === STR) {
        const enc = new TextEncoder().encode(String(v ?? "")).slice(0, size - 1);
        for (let k = 0; k < size; k++) this.u8(k < enc.length ? enc[k] : 0);
      } else {
        const x = v == null ? INV[type] : v;
        if (SIZE[type] === 1) this.u8(x); else if (SIZE[type] === 2) this.u16(x); else this.u32(x);
      }
    });
  }
}

// Stap: { name, intensity: 'warmup'|'active'|'rest'|'cooldown'|'recovery', min, hr: [laag, hoog] } of { repeat: n, from: index }
const INT = { active: 0, rest: 1, warmup: 2, cooldown: 3, recovery: 4 };
export function workoutFit(name, steps) {
  const w = new Writer();
  const FID = [[0, ENUM], [1, U16], [2, U16], [3, U32Z], [4, U32]];
  w.define(0, 0, FID);
  const now = Math.floor(Date.now() / 1000) - 631065600; // FIT-tijd: seconden sinds 31/12/1989
  w.data(0, FID, [5, 255, 0, (Math.random() * 0xfffffffe + 1) >>> 0, now]);
  const WKT = [[8, STR, 32], [4, ENUM], [11, ENUM], [6, U16]];
  w.define(1, 26, WKT);
  w.data(1, WKT, [name, 1, 0, steps.length]);
  const STEP = [[254, U16], [0, STR, 24], [1, ENUM], [2, U32], [3, ENUM], [4, U32], [5, U32], [6, U32], [7, ENUM]];
  w.define(2, 27, STEP);
  steps.forEach((s, i) => {
    if (s.repeat) return w.data(2, STEP, [i, "", 6, s.from, null, s.repeat, null, null, null]);
    const dur = s.min ? [0, Math.round(s.min * 60000)] : [5, null]; // tijd in ms, of 'open' (lap-knop)
    const tgt = s.hr ? [1, 0, s.hr[0] + 100, s.hr[1] + 100] : [2, 0, null, null];
    w.data(2, STEP, [i, s.name || "", dur[0], dur[1], tgt[0], tgt[1], tgt[2], tgt[3], INT[s.intensity ?? "active"]]);
  });
  const data = new Uint8Array(w.b);
  const h = new Writer();
  h.u8(14); h.u8(0x10); h.u16(2132); h.u32(data.length); ".FIT".split("").forEach((c) => h.u8(c.charCodeAt(0)));
  const hc = crc16(h.b); h.u16(hc);
  const head = new Uint8Array(h.b);
  const all = new Uint8Array(head.length + data.length + 2);
  all.set(head); all.set(data, head.length);
  const c = crc16(all.subarray(0, head.length + data.length));
  all[all.length - 2] = c & 0xff; all[all.length - 1] = c >> 8;
  return all;
}

// Loopsessie uit het loopplan → stappen. z2 = [laag, hoog] hartslag.
export function runSteps(s, z2 = [138, 152]) {
  const hard = [z2[1] + 10, z2[1] + 25], tempo = [z2[1] + 5, z2[1] + 15];
  if (s.type === "interval") {
    const reps = Math.max(4, Math.min(8, Math.round((s.min - 15) / 4)));
    return [{ name: "Opwarmen", intensity: "warmup", min: 10, hr: z2 }, { name: "Stevig", intensity: "active", min: 2, hr: hard },
      { name: "Rustig", intensity: "recovery", min: 2, hr: z2 }, { repeat: reps, from: 1 }, { name: "Uitlopen", intensity: "cooldown", min: 5 }];
  }
  if (s.type === "tempo") {
    return [{ name: "Inlopen", intensity: "warmup", min: 10, hr: z2 }, { name: "Tempo", intensity: "active", min: Math.max(10, s.min - 15), hr: tempo },
      { name: "Uitlopen", intensity: "cooldown", min: 5 }];
  }
  if (s.type === "race") return [{ name: "Wedstrijd", intensity: "active" }];
  return [{ name: "Inlopen", intensity: "warmup", min: 5 }, { name: s.type === "long" ? "Lange duurloop" : "Zone 2", intensity: "active", min: Math.max(5, s.min - 10), hr: z2 },
    { name: "Uitlopen", intensity: "cooldown", min: 5 }];
}

export function downloadFit(name, steps) {
  const blob = new Blob([workoutFit(name, steps)], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\p{L}\d]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "workout"}.fit`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
