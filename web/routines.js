// Training starten: lege training, mijn routines (in mappen), of een routine laten voorstellen door de coach.
let C;
const sheetEl = (html, label) => {
  const s = document.createElement("div");
  s.className = "sheet";
  s.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${label}">${html}</div>`;
  document.body.appendChild(s);
  s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) s.remove(); });
  return s;
};
const head = (t) => `<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h3 style="margin:0">${t}</h3>
  <button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>`;

export const SUGGEST_PROMPT = "Stel een trainingsroutine voor mij voor. Vraag eerst wat je moet weten (dagen per week, korte of lange sessies, doel, materiaal).";

export function openStartSheet(ctx) {
  C = ctx;
  const s = sheetEl(`${head("Training starten")}
    <div class="startw" style="margin-top:12px">
      <button class="tpl" data-a="empty"><span><b>Lege training</b><br><small>oefeningen kies je onderweg</small></span><span>＋</span></button>
      <button class="tpl" data-a="mine"><span><b>Mijn routines</b><br><small>je schema's, per map</small></span><span>›</span></button>
      <button class="tpl" data-a="ai"><span><b>Stel een routine voor</b><br><small>de coach bouwt een schema op maat</small></span><span>✦</span></button>
    </div>`, "Training starten");
  s.querySelector('[data-a="empty"]').onclick = async () => { s.remove(); (await import("./workout.js")).startWorkout(C); };
  s.querySelector('[data-a="mine"]').onclick = () => { s.remove(); openRoutines(C); };
  s.querySelector('[data-a="ai"]').onclick = async () => { s.remove(); (await import("./assistant.js")).openAssistant(C, { question: SUGGEST_PROMPT }); };
}

export async function openRoutines(ctx) {
  C = ctx;
  const s = sheetEl(`${head("Mijn routines")}<div id="rtBody" style="margin-top:10px"><div class="skeleton"></div></div>`, "Mijn routines");
  const body = s.querySelector("#rtBody");
  const draw = async () => {
    const d = await C.rpc("get_workout_routines");
    const folders = d.folders || [], routines = d.routines || [];
    const groups = [...folders.map((f) => ({ f, items: routines.filter((r) => r.folder_id === f.id) })),
      { f: null, items: routines.filter((r) => !r.folder_id || !folders.some((f) => f.id === r.folder_id)) }];
    const item = (r) => `<div class="rt-item">
        <button class="tpl" data-start="${r.id}"><span><b>${C.esc(r.name)}</b><br><small>${(r.exercises || []).length} oefeningen${r.note ? ` · ${C.esc(r.note)}` : ""}</small></span><span>▶</span></button>
        <button class="icon-btn" data-more="${r.id}" aria-label="Opties voor ${C.esc(r.name)}">⋯</button></div>`;
    body.innerHTML = `
      ${d.limit != null ? `<p class="small muted" style="margin:0 0 8px">${routines.length} van ${d.limit} routines (gratis). Met Premium onbeperkt.</p>` : ""}
      ${routines.length ? groups.filter((g) => g.f || g.items.length).map((g) => `
        <details class="rt-folder" open>
          <summary><b>${g.f ? C.esc(g.f.name) : "Zonder map"}</b> <span class="muted small">${g.items.length}</span>
            ${g.f ? `<button class="link-btn inline small" data-fedit="${g.f.id}">wijzig</button>` : ""}</summary>
          <div class="startw">${g.items.map(item).join("") || `<p class="small muted">Leeg.</p>`}</div>
        </details>`).join("")
        : `<p class="muted">Nog geen routines. Bewaar een training als routine, of laat de coach er een voorstellen.</p>`}
      <div class="row" style="margin-top:12px">
        <button class="btn secondary" id="rtFolder">Nieuwe map</button>
        <button class="btn ghost" id="rtAi">✦ Laat er een voorstellen</button>
      </div>`;
    body.querySelectorAll("[data-start]").forEach((b) => (b.onclick = async () => {
      s.remove(); (await import("./workout.js")).startWorkout(C, { template: routines.find((r) => r.id === b.dataset.start) });
    }));
    body.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => routineMenu(routines.find((r) => r.id === b.dataset.more), folders, draw)));
    body.querySelectorAll("[data-fedit]").forEach((b) => (b.onclick = async (e) => {
      e.preventDefault();
      const f = folders.find((x) => x.id === b.dataset.fedit);
      const name = prompt("Nieuwe naam voor de map (leeg laten = map verwijderen, routines blijven bestaan):", f.name);
      if (name === null) return;
      await C.rpc("save_workout_folder", { p: name.trim() ? { id: f.id, name: name.trim() } : { id: f.id, archived: true } });
      draw();
    }));
    body.querySelector("#rtFolder").onclick = async () => {
      const name = prompt("Naam van de map, bv. Push Pull Legs");
      if (name?.trim()) { await C.rpc("save_workout_folder", { p: { name: name.trim() } }); draw(); }
    };
    body.querySelector("#rtAi").onclick = async () => { s.remove(); (await import("./assistant.js")).openAssistant(C, { question: SUGGEST_PROMPT }); };
  };
  draw().catch((e) => { body.innerHTML = `<p class="warn">${C.esc(e.message)}</p>`; });
}

function routineMenu(r, folders, after) {
  const s = sheetEl(`${head(C.esc(r.name))}
    <div class="field" style="margin-top:10px"><label for="rmName">Naam</label><input class="input" id="rmName" value="${C.esc(r.name)}"></div>
    <div class="field"><label for="rmFolder">Map</label><select class="input" id="rmFolder"><option value="">Zonder map</option>
      ${folders.map((f) => `<option value="${f.id}" ${f.id === r.folder_id ? "selected" : ""}>${C.esc(f.name)}</option>`).join("")}</select></div>
    <p class="small muted">${(r.exercises || []).map((e) => `${C.esc(e.title)} (${e.sets || 3}×${C.esc(e.reps || "")})`.replace("×)", ")")).join(" · ") || "Geen oefeningen."}</p>
    <div class="row"><button class="btn" id="rmSave">Opslaan</button><button class="btn danger" id="rmDel">Verwijderen</button></div>`, "Routine");
  s.querySelector("#rmSave").onclick = async () => {
    await C.rpc("save_template", { p: { id: r.id, name: s.querySelector("#rmName").value, folder_id: s.querySelector("#rmFolder").value || null } });
    s.remove(); C.toast("Routine opgeslagen"); after();
  };
  s.querySelector("#rmDel").onclick = async () => {
    if (!confirm(`Routine "${r.name}" verwijderen?`)) return;
    await C.rpc("save_template", { p: { id: r.id, archived: true } });
    s.remove(); C.toast("Routine verwijderd"); after();
  };
}

// Na een training: bewaren als nieuwe routine of de gestarte routine bijwerken
export async function saveAsRoutine(ctx, done, box) {
  C = ctx;
  const d = await C.rpc("get_workout_routines").catch(() => ({ folders: [], routines: [] }));
  const full = d.limit != null && (d.routines || []).length >= d.limit;
  const fromTpl = done.template_id && (d.routines || []).some((r) => r.id === done.template_id);
  box.innerHTML = `<h3>${fromTpl ? "Routine bijwerken" : "Opslaan als routine"}</h3>
    <p class="hint">${fromTpl ? "Veranderde je oefeningen of sets? Werk je routine bij, of bewaar dit als een nieuwe routine." : "Start deze training later opnieuw met dezelfde oefeningen."}</p>
    <div class="field"><label for="tplName">Naam</label><input class="input" id="tplName" value="${C.esc(done.title)}"></div>
    <div class="field"><label for="tplFolder">Map</label><select class="input" id="tplFolder"><option value="">Zonder map</option>
      ${(d.folders || []).map((f) => `<option value="${f.id}">${C.esc(f.name)}</option>`).join("")}</select></div>
    <div class="row">
      ${fromTpl ? `<button class="btn" id="tplUpd">Routine bijwerken</button>` : ""}
      <button class="btn ${fromTpl ? "secondary" : ""}" id="tplNew" ${full ? "disabled" : ""}>Nieuwe routine</button>
    </div>
    ${full ? `<p class="small muted">Je hebt al ${d.limit} routines (gratis maximum). Met Premium onbeperkt.</p>` : ""}`;
  if (fromTpl) {
    const cur = d.routines.find((r) => r.id === done.template_id);
    if (cur?.folder_id) box.querySelector("#tplFolder").value = cur.folder_id;
  }
  const exercises = done.exercises.map((e) => ({ title: e.title, muscle: e.muscle, rest_s: e.rest_s,
    sets: e.sets.filter((x) => x.type !== "warmup").length || e.sets.length }));
  const val = () => ({ name: box.querySelector("#tplName").value, folder_id: box.querySelector("#tplFolder").value || null, exercises });
  box.querySelector("#tplUpd")?.addEventListener("click", async () => {
    try { await C.rpc("save_template", { p: { id: done.template_id, ...val() } }); C.toast("Routine bijgewerkt"); box.querySelector("#tplUpd").disabled = true; }
    catch (e) { C.toast(e.message, 5000); }
  });
  box.querySelector("#tplNew").onclick = async () => {
    try { await C.rpc("save_template", { p: val() }); C.toast("Routine bewaard"); box.querySelector("#tplNew").disabled = true; }
    catch (e) { C.toast(e.message, 6000); }
  };
}
