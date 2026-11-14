// Training delen als afbeelding (1080×1350, past in een Instagram-story of een chat). Alles gebeurt op het toestel.
const INK = "#ECEAE3", PAPER = "#1E211F", SURF = "#282C29", MUTED = "#A9A79F";
const PLATES = ["#D6533F", "#4B82C3", "#DDB040", "#4E9F69", "#CFC9BA"];

const bestSet = (e) => e.sets.filter((s) => s.type !== "warmup" && Number(s.kg) >= 0 && Number(s.reps) > 0)
  .sort((a, b) => Number(b.kg) * (1 + Number(b.reps) / 30) - Number(a.kg) * (1 + Number(a.reps) / 30))[0];
const nl = (v, d = 0) => Number(v || 0).toLocaleString("nl-BE", { maximumFractionDigits: d, minimumFractionDigits: d });

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

export async function workoutImage(done, summary = {}, records = []) {
  try { await Promise.all([document.fonts.load('800 100px "Archivo"'), document.fonts.load('500 40px "Archivo"')]); } catch { /* standaardletter */ }
  const W = 1080, H = 1350, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  c.fillStyle = PAPER; c.fillRect(0, 0, W, H);
  // schijven langs de linkerkant, zoals op een stang
  PLATES.forEach((col, i) => { c.fillStyle = col; c.fillRect(0, 140 + i * 46, 22 - i * 3, 38); });

  const date = new Date(done.start || Date.now()).toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" });
  c.fillStyle = MUTED; c.font = '500 34px "Archivo", system-ui, sans-serif'; c.fillText(date, 80, 150);
  c.fillStyle = INK; c.font = '800 92px "Archivo", system-ui, sans-serif'; c.fillText(fit(c, done.title || "Training", W - 160), 80, 250);

  // drie cijfers
  const stats = [[summary.duration_min, "minuten"], [summary.volume_kg, "kg volume"], [summary.working_sets, "werksets"]];
  stats.forEach(([v, l], i) => {
    const x = 80 + i * 320;
    c.fillStyle = SURF; c.fillRect(x, 300, 290, 170);
    const txt = v == null ? "–" : nl(v);
    let fs = 76; do { c.font = `800 ${fs}px "Archivo", system-ui, sans-serif`; fs -= 4; } while (c.measureText(txt).width > 246 && fs > 30);
    c.fillStyle = INK; c.fillText(txt, x + 24, 400);
    c.fillStyle = MUTED; c.font = '500 30px "Archivo", system-ui, sans-serif'; c.fillText(l, x + 24, 446);
  });

  // oefeningen met beste set
  let y = 560;
  c.fillStyle = MUTED; c.font = '600 30px "Archivo", system-ui, sans-serif'; c.fillText("Beste set per oefening", 80, y); y += 24;
  const prs = new Set(records.map((r) => r.exercise));
  const ex = (done.exercises || []).slice(0, 8);
  for (const e of ex) {
    const b = bestSet(e); y += 74;
    c.fillStyle = prs.has(e.title) ? PLATES[2] : INK;
    c.font = '600 40px "Archivo", system-ui, sans-serif';
    const right = b ? (Number(b.kg) > 0 ? `${Number(b.kg).toLocaleString("nl-BE", { maximumFractionDigits: 2 })} kg × ${b.reps}` : `${b.reps} reps`) : `${e.sets.length} sets`;
    c.font = '700 40px "Archivo", system-ui, sans-serif';
    const rw = c.measureText(right).width;
    c.fillText(right, W - 80 - rw, y);
    c.font = '500 40px "Archivo", system-ui, sans-serif';
    c.fillText(fit(c, (prs.has(e.title) ? "PR  " : "") + e.title, W - 200 - rw), 80, y);
    c.fillStyle = "#3A403B"; c.fillRect(80, y + 24, W - 160, 2);
  }
  if ((done.exercises || []).length > ex.length) { y += 64; c.fillStyle = MUTED; c.font = '500 30px "Archivo", system-ui, sans-serif'; c.fillText(`+ ${done.exercises.length - ex.length} oefeningen`, 80, y); }

  c.fillStyle = MUTED; c.font = '600 30px "Archivo", system-ui, sans-serif'; c.fillText("Health Hub", 80, H - 70);
  return await new Promise((ok) => cv.toBlob(ok, "image/png"));
}

export async function shareWorkout(C, done, summary, records) {
  const blob = await workoutImage(done, summary, records);
  if (!blob) return C.toast("Afbeelding maken lukte niet");
  const file = new File([blob], `training-${new Date().toISOString().slice(0, 10)}.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: done.title || "Training" }); return; }
    catch (e) { if (e?.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  C.toast("Afbeelding gedownload");
}
