// Koppel-assistent: Apple Gezondheid stap voor stap koppelen, met live controle.
const METRICS = [
  ["step_count", "Stappen", "Som", true],
  ["active_energy", "Actieve energie", "Som", true],
  ["resting_heart_rate", "Rusthartslag", "Gemiddelde", true],
  ["heart_rate_variability", "Hartslagvariabiliteit (HRV)", "Gemiddelde", false],
  ["basal_energy_burned", "Rustenergie", "Som", false],
  ["weight_body_mass", "Gewicht", "Gemiddelde", false],
];
const LABEL = Object.fromEntries(METRICS.map(([k, l]) => [k, l]));
LABEL.sleep_hours = "Slaap (uren)";

let poll = null;

export async function renderLink(C) {
  clearInterval(poll);
  const [st, s] = await Promise.all([C.rpc("get_link_status"), C.rpc("get_settings")]);
  const url = `${C.SUPABASE_URL}/functions/v1/ingest-health`;
  const bearer = `Bearer ${s.ingest_token}`;
  const ok = (b) => `<span class="lk-badge ${b ? "on" : ""}">${b ? "✓" : "–"}</span>`;
  const cov = st.coverage || {};
  const hasExport = !!st.export?.at;
  const hasShortcut = !!st.shortcut?.received_at;

  C.view.innerHTML = `
    <section class="panel lk-hero">
      <h3>Apple Gezondheid koppelen</h3>
      <p class="hint" style="margin:4px 0 10px">Health Hub is een web-app, dus Apple laat je hem niet aanvinken bij Gezondheid → Apps. Daarom werkt het zo: je <b>Garmin</b> schrijft naar Gezondheid, en Gezondheid geeft de gegevens via een <b>export</b> (historiek) en de app <b>Opdrachten</b> (elke dag) door.</p>
      <div class="lk-status">
        <div>${ok(cov.last_day)}<b>Gegevens</b><span>${cov.last_day ? `tot ${C.esc(C.shortDate(cov.last_day))}` : "nog niets"}</span></div>
        <div>${ok(hasExport)}<b>Historiek</b><span>${hasExport ? C.esc(timeAgo(st.export.at)) : "nog niet"}</span></div>
        <div>${ok(hasShortcut)}<b>Elke dag</b><span>${hasShortcut ? `${st.shortcut_runs_7d}× deze week` : "nog niet"}</span></div>
      </div>
    </section>

    <section class="panel lk-step">
      <div class="lk-num">1</div>
      <h3>Garmin → Gezondheid <span class="muted small">1 min, eenmalig</span></h3>
      <ol class="steps-list">
        <li>Open <b>Garmin Connect</b> → <b>Meer</b> (☰ of •••) → <b>Instellingen</b> → <b>Gekoppelde apps</b> → <b>Apple Gezondheid</b>.</li>
        <li>Zet <b>alles</b> aan (activiteiten, stappen, slaap, hartslag, gewicht…) en bevestig in het venster van Apple met <b>Schakel alle categorieën in</b>.</li>
        <li>Controle: open <b>Gezondheid</b> → <b>Overzicht</b> → <b>Stappen</b> → helemaal onderaan <b>Gegevensbronnen en toegang</b>: Garmin Connect moet erbij staan.</li>
      </ol>
      ${st.sources?.length ? `<p class="small ok" style="margin:8px 0 0">Ontvangen bronnen (30 d): ${st.sources.map((x) => C.esc(x.source)).join(", ")}</p>` : ""}
    </section>

    <section class="panel lk-step">
      <div class="lk-num">2</div>
      <h3>Historiek importeren <span class="muted small">5 min</span></h3>
      <p class="small" style="margin:4px 0 0">Haalt alles binnen: stappen, slaap met fasen, hartslag, HRV, workouts van je Garmin.</p>
      <ol class="steps-list">
        <li>Open <b>Gezondheid</b> en tik rechtsboven op je <b>profielfoto</b> (of initialen).</li>
        <li>Scroll naar onder → <b>Exporteer alle gezondheidsgegevens</b> → <b>Exporteer</b>. Dit duurt een tot enkele minuten.</li>
        <li>Kies <b>Bewaar in Bestanden</b> → bv. <i>Op mijn iPhone</i> → <b>Bewaar</b>.</li>
        <li>Kom terug hier en kies het bestand <b>export.zip</b>:</li>
      </ol>
      <div class="row" style="margin-top:8px">
        <select class="input" id="ahSince" style="max-width:170px" aria-label="Periode">
          <option value="3">Laatste 3 maanden</option><option value="6" selected>Laatste 6 maanden</option>
          <option value="12">Laatste 12 maanden</option><option value="0">Alles</option>
        </select>
        <label class="btn" style="cursor:pointer">export.zip kiezen<input type="file" id="ahFile" accept=".zip,.xml,application/zip,text/xml" hidden></label>
      </div>
      <div id="ahProg" class="small muted" style="margin-top:8px"></div>
      <div class="lk-tip">
        <b>Zonder dagelijkse automatisering?</b> Herhaal dit gewoon wekelijks; dubbels worden herkend.
        ${st.routine ? `<span class="ok">Herinnering staat aan (${C.esc(st.routine.title)}).</span>` : `<button class="linkbtn" id="mkReminder">Herinner me elke zondag om 10:00</button>`}
      </div>
    </section>

    <section class="panel lk-step">
      <div class="lk-num">3</div>
      <h3>Elke dag automatisch <span class="muted small">optioneel, 10 min eenmalig</span></h3>
      <p class="small" style="margin:4px 0 0">De iPhone-app <b>Opdrachten</b> (Shortcuts, standaard op je iPhone) leest je dagtotalen en stuurt ze naar Health Hub. Je bouwt de opdracht één keer.</p>

      <h4 class="sub-h">A. Kopieer eerst deze twee waarden</h4>
      <div class="field"><label>URL</label><div class="row"><input class="input mono" readonly value="${C.esc(url)}" id="lkUrl"><button class="btn secondary" data-copy="lkUrl">Kopieer</button></div></div>
      <div class="field"><label>Waarde voor de header <span class="mono">Authorization</span></label><div class="row"><input class="input mono" readonly type="password" value="${C.esc(bearer)}" id="lkTok"><button class="btn secondary" data-copy="lkTok">Kopieer</button></div></div>

      <h4 class="sub-h">B. Maak de opdracht</h4>
      <ol class="steps-list">
        <li>Open <b>Opdrachten</b> → tab <b>Opdrachten</b> → <b>+</b> (rechtsboven). Tik bovenaan op de naam en noem hem <b>Health Hub sync</b>.</li>
        <li>Tik <b>Voeg taak toe</b> (of de zoekbalk onderaan), zoek <b>gezondheid</b> en kies <b>Zoek gezondheidsstalen</b> <span class="muted">(Engels: Find Health Samples; de Nederlandse naam kan iets anders zijn)</span>.</li>
        <li>In die taak: tik op het blauwe <b>Type</b> → kies <b>Stappen</b>. Tik <b>Voeg filter toe</b> → <b>Begindatum</b> → <b>is vandaag</b>. Zet <b>Groepeer op</b> op <b>Dag</b>.</li>
        <li>Voeg daaronder de taak <b>Bereken statistieken</b> (Calculate Statistics) toe en kies <b>Som</b>.</li>
        <li>Herhaal stap 2–4 voor elke meting in de tabel hieronder (✱ = aangeraden, de rest mag je overslaan).</li>
        <li>Voeg als laatste <b>Haal inhoud op van URL</b> (Get Contents of URL) toe. Plak de <b>URL</b>. Tik <b>›</b> (Toon meer):
          <ul>
            <li><b>Methode</b>: POST</li>
            <li><b>Headers</b> → <b>Voeg nieuwe header toe</b>: sleutel <span class="mono">Authorization</span>, tekst: plak de tweede waarde (begint met <span class="mono">Bearer</span>).</li>
            <li><b>Verzoekhoofdtekst</b>: <b>JSON</b>. Per meting: <b>Voeg nieuw veld toe</b> → <b>Getal</b> → sleutel uit de tabel (bv. <span class="mono">step_count</span>) → als waarde tik je de variabele <b>Statistieken</b> van de juiste meting aan (houd ingedrukt op de waarde → <b>Selecteer variabele</b>).</li>
          </ul></li>
        <li>Tik <b>▶</b> rechtsonder om te testen. Sta toegang tot Gezondheid toe en kies bij de vraag over delen <b>Sta altijd toe</b>. Kijk hieronder: binnen enkele seconden zie je wat er aankwam.</li>
      </ol>
      <table class="nutrients small lk-tbl" style="margin-top:8px">
        <tr><td><b>Type · statistiek</b></td><td><b>Sleutel (tik om te kopiëren)</b></td></tr>
        ${METRICS.map(([k, l, how, rec]) => `<tr><td>${rec ? "✱ " : ""}${l}<br><span class="muted">${how}</span></td><td><button class="linkbtn cpk" data-k="${k}" aria-label="Kopieer ${k}"><span class="mono">${k}</span> ⧉</button></td></tr>`).join("")}
      </table>

      <h4 class="sub-h">C. Laat hem vanzelf lopen</h4>
      <ol class="steps-list">
        <li>Opdrachten → tab <b>Automatisering</b> → <b>+</b> → <b>App</b>.</li>
        <li>Kies een app die je elke avond opent (bv. <b>WhatsApp</b> of <b>Instagram</b>), vink <b>Is geopend</b> aan en kies <b>Voer direct uit</b> → <b>Volgende</b>.</li>
        <li>Kies je opdracht <b>Health Hub sync</b>. Klaar.</li>
      </ol>
      <p class="small muted">Waarom geen vast uur? Met een vergrendelde iPhone mag Opdrachten Gezondheid niet lezen. Bij het openen van een app is je iPhone ontgrendeld. Vaak versturen is geen probleem: de dagtotalen worden gewoon bijgewerkt.</p>

      <div class="lk-live" id="lkLive" aria-live="polite"></div>
    </section>

    <section class="panel">
      <h3>Lukt het niet?</h3>
      <ul class="steps-list">
        <li><b>Niets ontvangen na ▶:</b> controleer of de header-sleutel exact <span class="mono">Authorization</span> is en de waarde met <span class="mono">Bearer </span>(met spatie) begint.</li>
        <li><b>Een meting ontbreekt:</b> er is vandaag nog geen data voor (bv. HRV meet je Garmin 's nachts). Lege metingen worden overgeslagen.</li>
        <li><b>Export importeren loopt vast:</b> kies een kortere periode, of open Health Hub op een computer en kies het bestand daar.</li>
        <li>Je kan de AI in "Vraag het" ook vragen wat er binnenkwam: "welke gegevens heb ik van gisteren?"</li>
      </ul>
    </section>`;

  C.view.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copy(C, C.view.querySelector("#" + b.dataset.copy).value)));
  C.view.querySelectorAll(".cpk").forEach((b) => (b.onclick = () => copy(C, b.dataset.k)));
  C.view.querySelector("#ahFile").onchange = (e) => C.importAppleHealth(e.target.files?.[0], Number(C.view.querySelector("#ahSince").value));
  C.view.querySelector("#mkReminder")?.addEventListener("click", async () => {
    await C.rpc("save_routine", { p: { title: "Importeer je Gezondheid-export", body: "2 minuten: Gezondheid → profielfoto → Exporteer alle gezondheidsgegevens",
      days: [7], time: "10:00", url: "/#/koppelen", kind: "notify" } });
    C.toast("Herinnering ingesteld: elke zondag 10:00");
    renderLink(C);
  });

  // live: wat kwam er laatst binnen via Opdrachten?
  const live = C.view.querySelector("#lkLive");
  let lastAt = st.shortcut?.received_at || null;
  const show = (sc, fresh) => {
    if (!sc) { live.innerHTML = `<div class="lk-wait"><i></i>Wacht op je eerste test (▶ in Opdrachten)…</div>`; return; }
    const got = sc.stats?.ontvangen || {};
    const unknown = sc.stats?.onbekend || [];
    const missing = METRICS.filter(([k, , , rec]) => rec && !(k in got)).map(([, l]) => l);
    live.innerHTML = `<div class="lk-got ${fresh ? "fresh" : ""}">
      <b>${fresh ? "✓ Zonet ontvangen" : `Laatst ontvangen ${C.esc(timeAgo(sc.received_at))}`}</b>
      ${Object.keys(got).length ? `<table class="nutrients small">${Object.entries(got).map(([k, v]) => `<tr><td>${C.esc(LABEL[k] || k)}</td><td>${C.fmt(v, v < 100 ? 1 : 0)}</td></tr>`).join("")}</table>`
        : `<p class="small warn">Er kwam een verzoek binnen, maar zonder bruikbare waarden. Controleer de JSON-velden (type Getal, variabele Statistieken).</p>`}
      ${missing.length ? `<p class="small muted">Nog niet ontvangen: ${missing.map(C.esc).join(", ")}${Object.keys(got).length ? " (kan ook betekenen: vandaag nog geen data)" : ""}.</p>` : ""}
      ${unknown.length ? `<p class="small warn">Onbekende sleutels genegeerd: ${unknown.map(C.esc).join(", ")}. Controleer de spelling.</p>` : ""}
    </div>`;
  };
  show(st.shortcut, false);
  poll = setInterval(async () => {
    if (!document.body.contains(live)) return clearInterval(poll);
    if (document.hidden) return;
    try {
      const s2 = await C.rpc("get_link_status");
      if (s2.shortcut?.received_at && s2.shortcut.received_at !== lastAt) { lastAt = s2.shortcut.received_at; show(s2.shortcut, true); navigator.vibrate?.(40); }
    } catch { /* stil */ }
  }, 5000);
}

async function copy(C, text) {
  try { await navigator.clipboard.writeText(text); C.toast("Gekopieerd"); }
  catch { C.toast("Kopiëren lukte niet; houd het veld ingedrukt om te kopiëren"); }
}

function timeAgo(ts) {
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 90) return "zonet";
  if (s < 3600) return `${Math.round(s / 60)} min geleden`;
  if (s < 86400) return `${Math.round(s / 3600)} u geleden`;
  return `${Math.round(s / 86400)} d geleden`;
}
