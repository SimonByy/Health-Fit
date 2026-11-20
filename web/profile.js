// Persoonlijk profiel: wat per persoon verschilt. Hartslagzones (Karvonen of % van max, of zelf ingevuld),
// max- en rusthartslag (berekend, gemeten of zelf), lichaam (voor energieverbruik) en voedingsdoelen per kg.
// Bewaard als setting "profile". Andere schermen halen de zones op met getZones().
let C;
const n = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const NAMES = ["Herstel", "Basis (zone 2)", "Tempo", "Drempel", "Maximaal"];
const DESC = ["heel rustig, wandelen, uitlopen", "praattempo: vetverbranding en uithouding", "stevig, korte zinnen", "rond je omslagpunt, 10–40 min vol te houden", "intervallen, sprints"];
// Ondergrens per zone in % (van hartslagreserve bij Karvonen, van max bij % max)
const BANDS = { karvonen: [50, 60, 70, 80, 90], pct_max: [50, 60, 70, 80, 90] };
const ACT = [["1.2", "Zittend (bureau, weinig beweging)"], ["1.375", "Licht actief (1–3 trainingen/week)"], ["1.55", "Actief (3–5 trainingen/week)"], ["1.725", "Zeer actief (6–7 trainingen/week)"], ["1.9", "Extreem (fysiek werk + dagelijks training)"]];

let cache = null;
export async function getProfile(ctx) {
  if (ctx) C = ctx;
  if (cache) return cache;
  const [p, m] = await Promise.all([C.rpc("get_setting", { p_key: "profile" }).catch(() => null), C.rpc("get_hr_profile").catch(() => ({}))]);
  cache = { p: p || {}, m: m || {} };
  return cache;
}
const ageOf = (p) => (n(p.birth_year) ? new Date().getFullYear() - n(p.birth_year) : null);

// Max- en rusthartslag volgens de gekozen bron
export function heartRates(p, m) {
  const age = ageOf(p);
  const calc = age ? Math.round(208 - 0.7 * age) : null;   // Tanaka (2001): betrouwbaarder dan 220 − leeftijd
  const mode = p.hr_max_mode || (n(m.max_hr) ? "gemeten" : "leeftijd");
  const max = mode === "zelf" && n(p.hr_max) ? n(p.hr_max) : mode === "gemeten" && n(m.max_hr) ? n(m.max_hr) : calc ?? n(m.max_hr) ?? 190;
  const rmode = p.hr_rest_mode || "gemeten";
  const rest = rmode === "zelf" && n(p.hr_rest) ? n(p.hr_rest) : n(m.rhr_14d) ?? n(p.hr_rest) ?? 60;
  return { max, rest, calc, mode, rmode, age };
}
export function zonesFor(p, m) {
  const { max, rest } = heartRates(p, m);
  const method = p.zone_method || "karvonen";
  if (method === "zelf" && Array.isArray(p.zones) && p.zones.length === 5 && p.zones.every((z) => n(z[0]) && n(z[1]))) return p.zones.map((z) => [n(z[0]), n(z[1])]);
  const lo = BANDS[method === "pct_max" ? "pct_max" : "karvonen"];
  const at = (pct) => Math.round(method === "pct_max" ? (max * pct) / 100 : rest + ((max - rest) * pct) / 100);
  return lo.map((l, i) => [at(l), i < 4 ? at(lo[i + 1]) - 1 : max]);
}
// Voor andere schermen: { max, rest, zones, z2: [laag, hoog] }
export async function getZones(ctx) {
  const { p, m } = await getProfile(ctx);
  const z = zonesFor(p, m);
  return { ...heartRates(p, m), zones: z, z2: z[1] };
}

// Mifflin-St Jeor rustverbruik × activiteit
function energy(p, m) {
  const w = n(p.weight_kg) ?? n(m.weight_kg), h = n(p.height_cm), a = ageOf(p);
  if (!w || !h || !a || !p.sex) return null;
  const bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === "m" ? 5 : p.sex === "v" ? -161 : -78);
  return { bmr: Math.round(bmr), tdee: Math.round(bmr * (n(p.activity) || 1.55)), w };
}

export async function renderProfileSettings(ctx, el) {
  C = ctx; cache = null;
  const { p, m } = await getProfile(ctx);
  const draw = () => {
    const hr = heartRates(p, m), z = zonesFor(p, m), method = p.zone_method || "karvonen", en = energy(p, m);
    const goals = p.protein_per_kg && en ? Math.round(n(p.protein_per_kg) * en.w) : null;
    const opt = (cur, v, l) => `<option value="${v}" ${String(cur) === String(v) ? "selected" : ""}>${l}</option>`;
    el.innerHTML = `
      <h4 class="sub-h" style="margin-top:0">Over jou</h4>
      <div class="grid2">
        <div class="field"><label for="pfBy">Geboortejaar</label><input class="input" id="pfBy" inputmode="numeric" placeholder="bv. 2004" value="${C.esc(p.birth_year ?? "")}"></div>
        <div class="field"><label for="pfSex">Geslacht</label><select class="input" id="pfSex">${opt(p.sex || "", "", "Kies…")}${opt(p.sex, "m", "Man")}${opt(p.sex, "v", "Vrouw")}${opt(p.sex, "x", "Liever niet zeggen")}</select></div>
        <div class="field"><label for="pfH">Lengte (cm)</label><input class="input" id="pfH" inputmode="numeric" value="${C.esc(p.height_cm ?? "")}"></div>
        <div class="field"><label for="pfW">Gewicht (kg)</label><input class="input" id="pfW" inputmode="decimal" placeholder="${m.weight_kg ? `laatst ${C.fmt(m.weight_kg, 1)}` : ""}" value="${C.esc(p.weight_kg ?? "")}"></div>
      </div>
      <div class="field"><label for="pfAct">Hoe actief ben je buiten je trainingen om?</label><select class="input" id="pfAct">${ACT.map(([v, l]) => opt(p.activity || "1.55", v, l)).join("")}</select></div>
      ${en ? `<div class="pf-calc"><span>Rustverbruik <b>${C.fmt(en.bmr)} kcal</b></span><span>Dagverbruik ± <b>${C.fmt(en.tdee)} kcal</b></span></div>
        <p class="small muted" style="margin:4px 0 0">Schatting (Mifflin-St Jeor). Je echte onderhoud uit wat je eet en weegt staat in Trends → Energiebalans en is preciezer.</p>` : `<p class="small muted">Vul geboortejaar, geslacht en lengte in voor een schatting van je verbruik.</p>`}

      <h4 class="sub-h">Hartslag</h4>
      <div class="field"><label for="pfMaxM">Maximale hartslag</label>
        <div class="row" style="flex-wrap:nowrap"><select class="input" id="pfMaxM">
          ${opt(hr.mode, "leeftijd", `Berekend uit leeftijd${hr.calc ? ` (${hr.calc})` : ""}`)}
          ${m.max_hr ? opt(hr.mode, "gemeten", `Hoogste gemeten (${m.max_hr})`) : ""}
          ${opt(hr.mode, "zelf", "Zelf invullen (bv. uit een test)")}</select>
          <input class="input" id="pfMax" inputmode="numeric" style="max-width:90px" aria-label="Maximale hartslag" value="${hr.mode === "zelf" ? C.esc(p.hr_max ?? "") : hr.max}" ${hr.mode === "zelf" ? "" : "disabled"}></div>
        ${hr.mode === "gemeten" && m.max_hr_top?.length ? `<p class="small muted" style="margin:4px 0 0">Uit: ${m.max_hr_top.map((x) => `${x.hr} (${C.esc(x.name || "training")}, ${C.esc(C.shortDate(x.day))})`).join(" · ")}. Eén uitschieter ver boven de rest is vaak een sensorfout: kies dan zelf invullen.</p>` : ""}
        ${hr.mode === "leeftijd" ? `<p class="small muted" style="margin:4px 0 0">208 − 0,7 × leeftijd (Tanaka). Kan bij jou 10 slagen hoger of lager liggen; een gemeten of geteste waarde is beter.</p>` : ""}</div>
      <div class="field"><label for="pfRestM">Rusthartslag</label>
        <div class="row" style="flex-wrap:nowrap"><select class="input" id="pfRestM">
          ${opt(hr.rmode, "gemeten", m.rhr_14d ? `Gemeten, gem. 14 dagen (${m.rhr_14d})` : "Gemeten (nog geen data)")}
          ${opt(hr.rmode, "zelf", "Zelf invullen")}</select>
          <input class="input" id="pfRest" inputmode="numeric" style="max-width:90px" aria-label="Rusthartslag" value="${hr.rmode === "zelf" ? C.esc(p.hr_rest ?? "") : hr.rest}" ${hr.rmode === "zelf" ? "" : "disabled"}></div></div>
      <div class="field"><label>Zones berekenen met</label>
        <div class="seg" role="group" aria-label="Methode">${[["karvonen", "Hartslagreserve"], ["pct_max", "% van max"], ["zelf", "Zelf"]].map(([k, l]) => `<button type="button" data-zm="${k}" aria-pressed="${method === k}">${l}</button>`).join("")}</div>
        <p class="small muted" style="margin:6px 0 0">${method === "karvonen" ? `Karvonen: rust + % × (max − rust) = ${hr.rest} + % × ${hr.max - hr.rest}. Houdt rekening met je fitheid; aangeraden.` : method === "pct_max" ? `Percentage van je max (${hr.max}). Eenvoudiger, maar zone 2 valt bij een lage rusthartslag vaak te laag.` : "Vul je eigen grenzen in, bv. uit een lactaattest of je Garmin-zones."}</p></div>
      <table class="pf-zones"><thead><tr><th>Zone</th><th>Van</th><th>Tot</th><th></th></tr></thead><tbody>
        ${z.map(([a, b], i) => `<tr class="z${i + 1}"><td><i></i><b>Z${i + 1}</b> ${NAMES[i]}<small>${DESC[i]}</small></td>
          <td>${method === "zelf" ? `<input class="input" inputmode="numeric" data-z="${i}-0" value="${a}" aria-label="Zone ${i + 1} van">` : a}</td>
          <td>${method === "zelf" ? `<input class="input" inputmode="numeric" data-z="${i}-1" value="${b}" aria-label="Zone ${i + 1} tot">` : b}</td><td class="muted small">bpm</td></tr>`).join("")}
      </tbody></table>
      <p class="small muted">Gebruikt voor je loopplan, de Garmin-workouts (⌚ .FIT) en de coach. Neem dezelfde grenzen over in Garmin Connect → Instellingen → Gebruikersinstellingen → Hartslagzones, dan kloppen ook de zones op je horloge.</p>

      <h4 class="sub-h">Voeding en training</h4>
      <div class="grid2">
        <div class="field"><label for="pfProt">Eiwit (g per kg)</label><input class="input" id="pfProt" inputmode="decimal" placeholder="1,6–2,2" value="${C.esc(p.protein_per_kg ?? "")}"></div>
        <div class="field"><label for="pfRestT">Rusttijd tussen sets (s)</label><select class="input" id="pfRestT">${[30, 45, 60, 90, 120, 150, 180, 240, 300].map((v) => opt(p.rest_sec || 90, v, v < 60 ? `${v} s` : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")} min`)).join("")}</select></div>
        <div class="field"><label for="pfRec">Herstel na krachttraining</label><select class="input" id="pfRec">${opt(p.recovery || "normaal", "snel", "Snel (getraind, jong)")}${opt(p.recovery || "normaal", "normaal", "Normaal")}${opt(p.recovery || "normaal", "traag", "Traag (beginner, weinig slaap, ouder)")}</select></div>
      </div>
      ${goals ? `<p class="small" style="margin:2px 0 8px">Bij ${C.fmt(en.w, 1)} kg is dat <b>${goals} g eiwit per dag</b>. <button class="linkbtn" id="pfToGoals">Zet als eiwitdoel${en ? ` (en ${C.fmt(en.tdee)} kcal)` : ""}</button></p>` : ""}
      <button class="btn" id="pfSave" style="width:100%">Profiel opslaan</button>`;
    bind();
  };
  const read = () => {
    const v = (id) => el.querySelector("#" + id)?.value.trim().replace(",", ".") ?? "";
    const num = (id) => (v(id) === "" ? null : Number(v(id)));
    Object.assign(p, { birth_year: num("pfBy"), sex: v("pfSex") || null, height_cm: num("pfH"), weight_kg: num("pfW"), activity: v("pfAct"),
      hr_max_mode: v("pfMaxM"), hr_rest_mode: v("pfRestM"), protein_per_kg: num("pfProt"), rest_sec: num("pfRestT"), recovery: v("pfRec") });
    if (p.hr_max_mode === "zelf") p.hr_max = num("pfMax");
    if (p.hr_rest_mode === "zelf") p.hr_rest = num("pfRest");
    const zi = el.querySelectorAll("[data-z]");
    if (zi.length) { const zs = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]; zi.forEach((x) => { const [a, b] = x.dataset.z.split("-").map(Number); zs[a][b] = Number(x.value) || 0; }); p.zones = zs; }
  };
  const bind = () => {
    ["pfMaxM", "pfRestM", "pfSex", "pfAct"].forEach((id) => (el.querySelector("#" + id).onchange = () => { read(); draw(); }));
    ["pfBy", "pfH", "pfW", "pfMax", "pfRest", "pfProt"].forEach((id) => (el.querySelector("#" + id).onchange = () => { read(); draw(); }));
    el.querySelectorAll("[data-zm]").forEach((b) => (b.onclick = () => {
      read();
      if (b.dataset.zm === "zelf" && !(Array.isArray(p.zones) && p.zones.length === 5)) p.zones = zonesFor({ ...p, zone_method: "karvonen" }, m);
      p.zone_method = b.dataset.zm; draw();
    }));
    el.querySelector("#pfSave").onclick = async () => {
      read();
      if (p.birth_year && (p.birth_year < 1920 || p.birth_year > new Date().getFullYear() - 10)) return C.toast("Geboortejaar klopt niet");
      if (p.hr_max_mode === "zelf" && !(p.hr_max >= 120 && p.hr_max <= 230)) return C.toast("Maximale hartslag: tussen 120 en 230");
      if (p.hr_rest_mode === "zelf" && !(p.hr_rest >= 30 && p.hr_rest <= 100)) return C.toast("Rusthartslag: tussen 30 en 100");
      if (p.zone_method === "zelf" && p.zones?.some((z, i) => !(z[0] > 60 && z[1] > z[0]) || (i && z[0] <= p.zones[i - 1][0])))
        return C.toast("Zones: elke zone moet hoger beginnen dan de vorige, en 'tot' boven 'van'", 5000);
      try { await C.rpc("set_setting", { p_key: "profile", p_value: p }); cache = null; C.toast("Profiel opgeslagen"); draw(); }
      catch (e) { C.toast(e.message, 5000); }
    };
    el.querySelector("#pfToGoals")?.addEventListener("click", async () => {
      read(); const en = energy(p, m); if (!en) return;
      const g = (await C.rpc("get_setting", { p_key: "goals" }).catch(() => null)) || {};
      g.protein_g = Math.round(n(p.protein_per_kg) * en.w); g.kcal_in = en.tdee;
      await C.rpc("set_setting", { p_key: "goals", p_value: g });
      C.toast(`Doelen: ${g.kcal_in} kcal en ${g.protein_g} g eiwit. Wil je afvallen of bijkomen, pas de kcal aan bij Doelen.`, 6000);
    });
  };
  draw();
}
