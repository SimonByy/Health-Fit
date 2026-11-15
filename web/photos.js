// Voortgangsfoto's (gratis). Blijven ALLEEN op dit toestel (IndexedDB); niets gaat naar de server.
let C;
const DB = "hh-photos", STORE = "photos";
function db() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((ok, ko) => {
    const t = d.transaction(STORE, mode), st = t.objectStore(STORE);
    const res = fn(st);
    t.oncomplete = () => ok(res?.result ?? res); t.onerror = () => ko(t.error);
  });
}
const all = () => tx("readonly", (s) => s.getAll());
const put = (p) => tx("readwrite", (s) => s.put(p));
const del = (id) => tx("readwrite", (s) => s.delete(id));

// Verkleinen naar max 1280 px zodat het toestel niet volloopt
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  return await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.85));
}
const POSES = [["voor", "Voorkant"], ["zij", "Zijkant"], ["achter", "Achterkant"]];
const dateTxt = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("nl-BE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export async function renderPhotos(ctx) {
  C = ctx;
  let list = [];
  try { list = (await all()).sort((a, b) => b.day.localeCompare(a.day)); }
  catch { C.view.innerHTML = `<section class="panel"><p>Foto's bewaren lukt niet in deze browser (privémodus?).</p></section>`; return; }
  let pose = sessionStorage.getItem("hh-pose") || "voor";
  const urls = [];
  const url = (b) => { const u = URL.createObjectURL(b); urls.push(u); return u; };
  const draw = () => {
    const mine = list.filter((p) => p.pose === pose);
    const first = mine[mine.length - 1], last = mine[0];
    C.view.innerHTML = `
      <section class="panel">
        <h2 style="margin:0 0 4px">Voortgangsfoto's</h2>
        <p class="small muted" style="margin:0 0 10px">Je foto's blijven alleen op dit toestel; ze gaan niet naar de server en zitten niet in een back-up. Tip: zelfde plek, licht en uur, één keer per maand.</p>
        <div class="chips" role="tablist">${POSES.map(([k, l]) => `<button class="chip ${k === pose ? "on" : ""}" data-pose="${k}" role="tab" aria-selected="${k === pose}">${l}</button>`).join("")}</div>
        <label class="btn" style="display:block;text-align:center;margin-top:10px">Foto toevoegen<input type="file" accept="image/*" capture="environment" id="phIn" hidden></label>
      </section>
      ${first && last && first !== last ? `<section class="panel">
        <h3 style="margin:0 0 8px">Vergelijk</h3>
        <div class="ph-cmp" id="cmp"><img src="${url(first.blob)}" alt="Eerste foto"><div class="ph-top" id="top"><img src="${url(last.blob)}" alt="Laatste foto"></div><span class="ph-line" id="line"></span></div>
        <input type="range" id="sl" min="0" max="100" value="50" aria-label="Schuif tussen voor en na" style="width:100%">
        <div class="row small muted" style="justify-content:space-between"><span>${dateTxt(first.day)}</span><span>${dateTxt(last.day)}</span></div>
      </section>` : ""}
      <section class="panel">${mine.length ? `<div class="ph-grid">${mine.map((p) => `<figure><img src="${url(p.blob)}" alt="${C.esc(dateTxt(p.day))}" loading="lazy">
          <figcaption class="small"><span>${C.esc(dateTxt(p.day))}${p.kg ? ` · ${C.fmt(p.kg, 1)} kg` : ""}</span><button class="icon-btn" data-del="${p.id}" aria-label="Verwijderen">✕</button></figcaption></figure>`).join("")}</div>`
        : `<p class="small muted" style="margin:0">Nog geen foto's van je ${POSES.find((x) => x[0] === pose)[1].toLowerCase()}.</p>`}</section>`;
    C.view.querySelectorAll("[data-pose]").forEach((b) => (b.onclick = () => { pose = b.dataset.pose; sessionStorage.setItem("hh-pose", pose); draw(); }));
    const sl = C.view.querySelector("#sl");
    if (sl) sl.oninput = () => { C.view.querySelector("#top").style.clipPath = `inset(0 0 0 ${sl.value}%)`; C.view.querySelector("#line").style.left = sl.value + "%"; };
    sl?.oninput();
    C.view.querySelector("#phIn").onchange = async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      try {
        const blob = await shrink(f);
        const kg = await C.rpc("get_weight_series", { p_days: 14 }).then((w) => w?.[w.length - 1]?.kg ?? null).catch(() => null);
        const p = { id: crypto.randomUUID(), day: C.today(), pose, blob, kg };
        await put(p); list.unshift(p); C.toast("Foto bewaard op dit toestel"); draw();
      } catch (err) { C.toast("Foto bewaren lukte niet: " + err.message, 5000); }
    };
    C.view.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      if (!confirm("Deze foto verwijderen?")) return;
      await del(b.dataset.del); list = list.filter((p) => p.id !== b.dataset.del); draw();
    }));
  };
  draw();
  addEventListener("hashchange", () => urls.forEach((u) => URL.revokeObjectURL(u)), { once: true });
}
