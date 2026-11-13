// Feedback: Claude als coach. Per recente training (Garmin + Hevy) de belangrijkste cijfers en feedback,
// naast elkaar om door te swipen, plus de weekfeedback. Feedback wordt geschreven door de geplande taken.
let C;
let tab = "trainingen";
let cur = null;
const n = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const Z2 = [138, 152];
const RACE = "2027-06-21"; // zomer 2027 (richtdatum)

const ICON = { run: "🏃", loopband: "🚶", kracht: "🏋️", cardio: "❤️" };
const SPORT = { run: "Lopen", loopband: "Loopband", kracht: "Kracht", cardio: "Cardio" };

function pace(p) { p = n(p); if (!p) return null; const m = Math.floor(p), s = Math.round((p - m) * 60); return `${m}:${String(s === 60 ? 0 : s).padStart(2, "0")}`; }
function wdShort(d) { return new Date(d + "T12:00:00").toLocaleDateString("nl-BE", { weekday: "short", day: "numeric" }); }
function dLong(t) {
  const d = new Date((t.start_local || t.day + "T12:00:00"));
  return d.toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" }) + (t.start_local ? " · " + d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" }) : "");
}
const points = (s) => String(s || "").split(/\s*·\s*|\n+/).map((x) => x.trim()).filter(Boolean);

function hrBadge(hr) {
  hr = n(hr); if (!hr) return "";
  const cls = hr < Z2[0] ? "low" : hr <= Z2[1] ? "in" : "high";
  const lbl = cls === "in" ? "in zone 2" : cls === "high" ? "boven zone 2" : "onder zone 2";
  return `<span class="fb-zone ${cls}">${lbl}</span>`;
}

function stats(t) {
  const s = [];
  const add = (v, u, l) => { if (v != null && v !== "") s.push(`<div class="fb-stat"><b>${v}</b><span>${u ? `${u} · ` : ""}${l}</span></div>`); };
  add(n(t.duration_min) != null ? C.fmt(Math.round(t.duration_min)) : null, "min", "duur");
  if (t.sport === "kracht") {
    add(n(t.working_sets), "", "werksets");
    add(n(t.exercises), "", "oefeningen");
    add(n(t.volume_kg) != null ? C.fmt(t.volume_kg) : null, "kg", "volume");
  } else {
    add(n(t.distance_km) ? C.fmt(t.distance_km, 2) : null, "km", "afstand");
    add(pace(t.pace_min_per_km) && t.sport === "run" ? pace(t.pace_min_per_km) : null, "/km", "tempo");
    add(n(t.avg_hr), "bpm", "gem. hartslag");
    add(n(t.max_hr), "bpm", "max");
  }
  return `<div class="fb-stats">${s.join("")}</div>`;
}

function feedbackHtml(f, t) {
  if (!f) return `<div class="fb-wait"><span class="dot"></span>Claude kijkt deze training na en geeft binnen het uur feedback.</div>`;
  const list = (cls, title, txt) => { const p = points(txt); return p.length ? `<div class="fb-list ${cls}"><h4>${title}</h4><ul>${p.map((x) => `<li>${C.esc(x)}</li>`).join("")}</ul></div>` : ""; };
  return `${f.summary ? `<p class="fb-sum">${C.esc(f.summary)}</p>` : ""}
    ${list("good", "Goed", f.good)}
    ${list("better", "Kan beter", f.improve)}
    ${f.focus ? `<div class="fb-focus"><span>Volgende keer</span>${C.esc(f.focus)}</div>` : ""}`;
}

function card(t) {
  const f = t.feedback;
  const isZ = t.sport !== "kracht";
  return `<section class="panel fb-card" data-ref="${C.esc(t.ref)}">
    <div class="fb-head"><span class="fb-ic" aria-hidden="true">${ICON[t.sport] || "•"}</span>
      <div><h3>${C.esc(f?.title || t.title || SPORT[t.sport])}</h3><p class="small muted">${C.esc(dLong(t))}</p></div></div>
    ${stats(t)}
    ${isZ && n(t.avg_hr) ? `<div class="fb-hr">${hrBadge(t.avg_hr)}<span class="small muted">Jouw zone 2: ${Z2[0]}–${Z2[1]} bpm</span></div>` : ""}
    <div class="fb-body">${feedbackHtml(f, t)}</div>
  </section>`;
}

function weekCard(w) {
  const st = w.stats || {};
  const chip = (v, l) => (v == null ? "" : `<div class="fb-stat"><b>${C.esc(String(v))}</b><span>${l}</span></div>`);
  return `<section class="panel fb-week">
    <h3>${C.esc(w.title || "Week")}</h3>
    <div class="fb-stats">${chip(st.kracht_sessies, "krachttrainingen")}${chip(st.z2_min, "min zone 2")}${chip(st.z2_gem_hr, "gem. hartslag Z2")}${chip(st.kcal_gem, "kcal/dag")}${chip(st.eiwit_gem, "g eiwit/dag")}${chip(st.gewicht_gem, "kg gem.")}</div>
    ${feedbackHtml(w)}
  </section>`;
}

export async function renderFeedback(ctx) {
  C = ctx;
  C.view.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
  let D;
  try { D = await C.rpc("get_feedback_feed", { p_days: 21 }); }
  catch (e) { C.view.innerHTML = `<section class="empty"><p>${C.esc(e.message)}</p></section>`; return; }
  const weeksLeft = Math.max(0, Math.round((new Date(RACE + "T12:00:00") - new Date()) / (7 * 864e5)));
  const T = D.trainings || [];
  const W = D.weeks || [];
  const draw = () => {
    C.view.innerHTML = `
      <div class="fb-goal"><span class="fb-goal-ic" aria-hidden="true">🏁</span><div><b>Halve marathon · zomer 2027</b><span>nog ± ${weeksLeft} weken · nu: zone 2-basis opbouwen</span></div></div>
      <div class="seg" role="tablist">
        <button role="tab" aria-pressed="${tab === "trainingen"}" data-t="trainingen">Per training</button>
        <button role="tab" aria-pressed="${tab === "week"}" data-t="week">Per week</button>
      </div>
      <div id="fbBox"></div>`;
    C.view.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { tab = b.dataset.t; draw(); }));
    const box = C.view.querySelector("#fbBox");
    if (tab === "week") {
      box.innerHTML = W.length ? W.map(weekCard).join("")
        : `<section class="empty"><p><b>Nog geen weekfeedback.</b></p><p class="small muted">Elke zondagavond bekijkt je coach je week (kracht, zone 2, voeding, gewicht) en zet hij hier wat goed ging, wat beter kan en je focus voor volgende week.</p></section>`;
      return;
    }
    if (!T.length) { box.innerHTML = `<section class="empty"><p>Nog geen trainingen in de laatste 3 weken.</p></section>`; return; }
    if (!cur || !T.some((t) => t.ref === cur)) cur = T[0].ref;
    box.innerHTML = `
      <div class="fb-chips" id="fbChips">${T.map((t) => `<button class="fb-chip ${t.feedback ? "" : "nofb"}" data-go="${C.esc(t.ref)}"><span aria-hidden="true">${ICON[t.sport] || "•"}</span>${C.esc(wdShort(t.day))}</button>`).join("")}</div>
      <div class="mp-swipe fb-swipe" id="fbSwipe">${T.map(card).join("")}</div>`;
    const sw = box.querySelector("#fbSwipe"), chips = [...box.querySelectorAll(".fb-chip")];
    const mark = (ref) => { chips.forEach((c) => { const on = c.dataset.go === ref; c.classList.toggle("on", on); if (on) c.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }); }); cur = ref; };
    const go = (ref, smooth) => { const el = sw.querySelector(`[data-ref="${CSS.escape(ref)}"]`); if (!el) return;
      sw.scrollTo({ left: el.offsetLeft - sw.offsetLeft, behavior: smooth ? "smooth" : "auto" }); mark(ref); };
    chips.forEach((c) => (c.onclick = () => go(c.dataset.go, true)));
    let st; sw.addEventListener("scroll", () => { clearTimeout(st); st = setTimeout(() => {
      const i = Math.round(sw.scrollLeft / (sw.clientWidth || 1)); const t = T[Math.max(0, Math.min(T.length - 1, i))]; if (t && t.ref !== cur) mark(t.ref); }, 60); }, { passive: true });
    requestAnimationFrame(() => go(cur, false));
  };
  draw();
}
