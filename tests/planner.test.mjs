import { JSDOM } from "jsdom";
const dom = new JSDOM(`<div id="v"></div>`, { url: "https://x.test/#/menu", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, history: dom.window.history, location: dom.window.location, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, requestAnimationFrame: (f) => setTimeout(f, 0), localStorage: dom.window.localStorage });
let confirmAns = true; globalThis.confirm = () => confirmAns;
dom.window.HTMLElement.prototype.scrollTo = function () {};
let fails = 0; const ok = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) fails++; };
const P = (k, p, c, f) => ({ kcal: k, protein: p, carbs: c, fat: f });
const I = (name, amount, unit, per, extra = {}) => ({ name, amount, unit, dept: "Overig", pantry: false, ...(per ? { food_id: "x" + name, food_name: "AH " + name, per100: per } : {}), ...extra });
const R = (id, name, t, ings, macros, extra = {}) => ({ id, name, meal_type: t, servings: 2, status: "klaar", favorite: false, disliked: false, ingredients: ings, steps: ["a"], storage: "koel", ...macros, ...extra });
const recipes = [
  R(4, "Hete bliksem", "avond", [I("Aardappelen", 250, "g", P(88, 2, 19, 0)), I("Gehakt", 200, "g", P(190, 20, 0.5, 12)), I("Peper en zout", null, null, null, { pantry: true })], { kcal: 600, protein: 45, carbs: 48, fat: 24, macros_checked: true }),
  R(16, "Wraps kip", "lunch", [I("Wrap", 2, "stuk", P(280, 9.5, 46, 4.7), { g_per_unit: 62 }), I("Kip", 150, "g", P(111, 25, 0, 1.2))], { kcal: 513.7, protein: 49.3, carbs: 57, fat: 7.6, macros_checked: true }),
  R(19, "Teriyaki", "avond", [I("Kip", 150, "g", P(111, 25, 0, 1.2))], { kcal: 166.5, protein: 37.5, carbs: 0, fat: 1.8, macros_checked: true }),
  R(10, "Fitpudding", "avondsnack", [I("Fitpudding", 1, "stuk", P(86, 10, 8.5, 0.9), { g_per_unit: 200, winkel: "AH" })], { kcal: 172, protein: 20, carbs: 17, fat: 1.8, macros_checked: true }),
  R(17, "Kwark", "snack", [I("Kwark", 250, "g", P(52, 9, 4, 0))], { kcal: 130, protein: 22.5, carbs: 10, fat: 0, macros_checked: true }),
  R(30, "Oud recept", "avond", [I("Iets", 100, "g", null)], { kcal: 500, protein: 30, carbs: 50, fat: 10, macros_checked: false }),
];
let id = 100; const items = [];
const add = (d, s, r, p = 1, e = false) => items.push({ id: id++, day: d, slot: s, recipe_id: r, portions: p, eaten: e, food_log_id: e ? "L" + id : null });
add("2026-11-15", "avond", 4); add("2026-11-16", "avond", 4, 1, true); add("2026-11-16", "lunch", 16, 1); add("2026-11-16", "snack", 17, 2);
add("2026-11-17", "avond", 19); add("2026-11-18", "avond", 19); add("2026-11-19", "avond", 19); add("2026-11-17", "lunch", 16); add("2026-11-18", "avondsnack", 10);
const data = { today: "2026-11-16", current_week_id: 1, goals: { kcal_in: 2000, protein_g: 150, carbs_g: 238, fat_g: 50 }, recipes,
  weeks: [{ id: 1, week_start: "2026-11-15", items, prep: ["x"], bonus: [], notes: "n", reviewed_at: null, list_recipes: [],
    shopping: [{ moment: "zondag", moment_label: "Zondag (AH)", afdeling: "Vlees & vis", dept: "Zondag (AH) · Vlees & vis", items: [{ key: "kip|g", name: "Kip", amount: 600, unit: "g", checked: true }, { key: "gehakt|g", name: "Gehakt", amount: 400, unit: "g" }] },
      { moment: "zondag", moment_label: "Zondag (AH)", afdeling: "Houdbaar", dept: "x", items: [{ key: "zout|", name: "Zout", pantry: true }] },
      { moment: "tussendag", moment_label: "Woensdag (Okay)", afdeling: "Zuivel & eieren", dept: "y", items: [{ key: "tus|kwark|g", name: "Kwark", amount: 250, unit: "g" }] }] }] };
const calls = [];
const foods = [{ id: "fA", name: "AH Rundergehakt mager", per100: P(190, 20, 0.5, 12), serving_g: 100 }, { id: "fB", name: "AH Ui", per100: P(40, 1.2, 8, 0.1) }];
const ctx = { rpc: async (fn, a) => { calls.push([fn, a]);
    if (fn === "mp_get") return JSON.parse(JSON.stringify(data)); if (fn === "mp_save_recipe") return { ...a.p, id: a.p.id ?? 77 };
    if (fn === "get_foods") return foods; if (fn === "get_quick_add") return {}; if (fn === "get_food_log") return [{ id: "L102", meal: "Avondeten", name: "Hete bliksem", kcal: 600, protein: 45 }];
    if (fn === "get_nutrition_day") return { nutrients: [{ metric: "dietary_energy", value: 600 }], goals: {} }; return null; },
  invoke: async () => ({ products: [] }), toast: (m) => calls.push(["toast", m]), fmt: (x) => String(Math.round((x ?? 0) * 10) / 10), esc: (s) => String(s ?? "").replace(/</g, "&lt;"),
  view: document.getElementById("v"), today: () => "2026-11-16", addDays: (d) => d };
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const txt = (el) => { if (!el) return undefined; const c = el.cloneNode(true); c.querySelectorAll("br").forEach((b) => b.replaceWith(" ")); return c.textContent.replace(/\s+/g, " ").trim(); };
const m = await import("../web/menu.js");

console.log("— Weekmenu");
await m.renderMenu(ctx, "week"); await wait();
ok($$(".mp-tab").length === 7, "7 dagtabs");
ok($(".mp-tab.on")?.dataset.go === "2026-11-16", "opent op vandaag (ma 16)");
ok($$(".mp-swipe > .mp-day").length === 7, "7 swipe-dagen, ook lege");
const ma = $('.mp-day[data-day="2026-11-16"]');
ok(txt(ma.querySelector(".mp-dk")).startsWith("1373.7 / 2000"), "ma totaal kcal = 600+513,7+2×130 → " + txt(ma.querySelector(".mp-dk")));
ok(txt(ma.querySelector(".mrow.prot .mrow-h")).includes("139.3"), "ma eiwit 45+49,3+45 = 139,3");
const snackH = $$(".mp-day[data-day='2026-11-16'] .mp-meal-h").map(txt).find((t) => t.startsWith("Snack"));
ok(snackH && snackH.includes("260 kcal") && snackH.includes("E 45"), "snack × 2 porties in maaltijdtotaal: " + snackH);
ok(ma.querySelectorAll("[data-eat]").length === 3 && ma.querySelector("[data-eat]:checked"), "vandaag: vinkjes + gegeten staat aan");
ok(!$('.mp-day[data-day="2026-11-17"] [data-eat]'), "toekomstige dag: geen vinkje");
ok($$('.mp-day[data-day="2026-11-21"] .mp-addslot .chip').length === 5, "lege zaterdag: 5 toevoegknoppen");
const plan = $$(".mp-cook").map((b) => b.closest(".mp-row")).map(txt);
ok(plan.length === 3, "kookplan 3 gerechten: " + plan.join(" | "));
ok(plan[0].startsWith("zondag Hete bliksem") || plan[0].startsWith("zondag Wraps"), "zondag eerst");
ok(plan.some((p) => p.startsWith("zondag Wraps kip") && p.includes("2 porties voor ma, di")), "wraps: zondag koken voor ma, di");
ok(plan.some((p) => p.startsWith("dinsdag Teriyaki") && p.includes("3 porties")), "teriyaki: dinsdag koken, 3 porties");
ok(plan.some((p) => p.startsWith("zondag Hete bliksem") && p.includes("2 porties voor zo, ma")), "hete bliksem 2 porties zo, ma");
// geschat-label
ok(!ma.textContent.includes("geschat"), "gekoppelde recepten: geen 'geschat'");

console.log("— Wisselen per dag");
$('.mp-item[data-item="101"]').click(); await wait();
ok(txt($(".sheet-card p.small"))?.includes("uitgerekend uit je producten"), "receptdetail toont ✓ echte waarden");
$("#swap").click(); await wait();
const dayBoxes = $$("[data-day]").filter((x) => x.tagName === "INPUT");
ok(dayBoxes.length === 5 && dayBoxes.filter((x) => x.checked).length === 1, "5 avonden, alleen gekozen dag aangevinkt");
ok($$(".pk-item b").map(txt).join(",").includes("Oud recept"), "ander avondrecept kiesbaar");
dayBoxes.forEach((x) => (x.checked = false));
$('.pk-item[data-r="19"]').click(); await wait();
ok(calls.some((c) => c[0] === "toast" && c[1] === "Kies minstens één dag."), "geen dag gekozen → melding, niets gewisseld");
ok(!calls.some((c) => c[0] === "mp_item_set"), "geen mp_item_set zonder dag");
$$(".sheet").forEach((s) => s.remove());

console.log("— Gegeten afvinken");
await m.renderMenu(ctx, "week"); await wait();
const cb = $('[data-eat="101"]'); cb.checked = false; cb.dispatchEvent(new Event("change")); await wait();
ok(JSON.stringify(calls.filter((c) => c[0] === "mp_item_eaten").at(-1)[1]) === '{"p_item_id":101,"p_eaten":false}', "uitvinken roept mp_item_eaten(false)");

console.log("— Lege plek vullen + nieuw recept");
$('[data-addday="2026-11-21"][data-addslot="avondsnack"]').click(); await wait();
ok($$(".pk-item b").map(txt).some((t) => t.includes("Fitpudding")) && $$(".pk-item b").map(txt).some((t) => t.includes("Kwark")), "avondsnack: ook snacks kiesbaar");
$("#asNew").click(); await wait(80);
ok($("#eName") && $("#eType").value === "avondsnack", "nieuw recept met juiste maaltijd");
$("#eName").value = "Testsnack";
$("#eSave").click(); await wait();
ok(!calls.some((c) => c[0] === "mp_save_recipe" && c[1].p.name === "Testsnack"), "zonder producten niet bewaren");
$("#eAdd").click(); await wait(300);
$$(".fi").find((x) => x.textContent.includes("Rundergehakt")).querySelector(".fi-main").click(); await wait(50);
$("#fG").value = "120"; $("#fG").dispatchEvent(new Event("input")); $("#fAdd").click(); await wait(150);
ok($(".mp-erow .e-amt")?.value === "120", "gekozen gram komt in het recept");
ok(txt($("#eMac .macro .v")) === "228", "macro's live: 120 g × 190 = 228 kcal");
$("#eName").value = "Testsnack";
$("#eSave").click(); await wait(100);
const sv = calls.filter((c) => c[0] === "mp_save_recipe").at(-1)?.[1].p;
ok(sv && sv.kcal === 228 && sv.macros_checked === true && sv.ingredients[0].food_id === "fA", "bewaard met echte waarden");
ok(JSON.stringify(calls.filter((c) => c[0] === "mp_item_add").at(-1)?.[1]) === '{"p_week_id":1,"p_day":"2026-11-21","p_slot":"avondsnack","p_recipe_id":77,"p_portions":1}', "en meteen op zaterdag gezet");
$$(".sheet").forEach((s) => s.remove());

console.log("— Recept aanpassen behoudt winkel en koppelt");
await m.renderMenu(ctx, "week"); await wait();
$('.mp-edit[data-r="4"]').click(); await wait(80);
ok($$(".mp-erow").length === 3 && $$(".e-link.on").length === 2, "3 ingrediënten, 2 gekoppeld, zout zonder product mag");
ok($("#eMac").textContent.includes("Alles gekoppeld"), "zout (altijd in huis, geen hoeveelheid) telt niet als ontbrekend");
const a1 = $('.mp-erow[data-k="1"] .e-amt'); a1.value = "150"; a1.dispatchEvent(new Event("input")); await wait();
ok(txt($("#eMac .macro .v")) === "505", "gehakt 150 g → 220+285 = 505 kcal");
$('.mp-erow[data-k="0"] .e-shop').value = "Okay";
$("#eSave").click(); await wait(80);
const s2 = calls.filter((c) => c[0] === "mp_save_recipe").at(-1)[1].p;
ok(s2.ingredients[0].winkel === "Okay" && s2.ingredients[1].amount === 150 && s2.kcal === 505, "winkel en hoeveelheid bewaard");
ok(s2.ingredients[2].name === "Peper en zout" && !("per100" in s2.ingredients[2]), "ingrediënt zonder product blijft zonder per100");
$$(".sheet").forEach((s) => s.remove());

console.log("— Ontbrekende koppeling waarschuwt");
await m.renderMenu(ctx, "recepten"); await wait();
ok($$(".warn-badge").length === 1 && $$(".ok-badge").length >= 5, "recepten: 1 geschat, rest ✓");
$('.mp-ritem[data-id="30"]').click(); await wait();
$("#fixMac").click(); await wait(80);
ok($("#eMac").textContent.includes("geschat"), "oud recept: melding geschat");
confirmAns = false;
$("#eAdd").click(); await wait(300);
$$(".fi").find((x) => x.textContent.includes("Ui")).querySelector(".fi-add").click(); await wait(150);
ok($("#eMac").textContent.includes("Nog zonder voedingswaarden") && $("#eMac").textContent.includes("Iets"), "toont welk ingrediënt nog ontbreekt");
const before = calls.filter((c) => c[0] === "mp_save_recipe").length;
$("#eSave").click(); await wait(80);
ok(calls.filter((c) => c[0] === "mp_save_recipe").length === before, "bij 'nee' op de vraag: niet bewaard");
confirmAns = true;
$$(".sheet").forEach((s) => s.remove());

console.log("— Boodschappen");
await m.renderMenu(ctx, "lijst"); await wait();
const heads = $$("h2.section-title").map(txt);
ok(heads[0] === "Zondag (AH) · 1/2" && heads[1] === "Woensdag (Okay) · 0/1", "koppen per winkel met teller: " + heads.join(" | "));
ok($$(".mp-shop h3").map(txt).join(",") === "Vlees & vis,Houdbaar,Zuivel & eieren", "afdelingen zonder dubbele dagnaam");

console.log("— Voeding");
const nmod = await import("../web/nutrition.js");
await nmod.renderNutrition(ctx, { nutDay: "2026-11-16" }); await wait();
const av = $('.mcard[data-meal="Avondeten"]');
ok(av.querySelectorAll(".mplan").length === 1 && av.querySelector(".mplan input").checked && !av.querySelector(".mi"), "gegeten planning: afgevinkt, log niet dubbel getoond");
console.log("mk=", JSON.stringify(txt(av.querySelector(".mk"))));ok(txt(av.querySelector(".mk")) === "600 kcal", "maaltijd-kcal telt de log mee");
const sn = $('.mcard[data-meal="Snack"] .mplan');
ok(sn && !sn.querySelector("input").checked && txt(sn).includes("260"), "snack gepland, 2 porties = 260 kcal");
ok($('.mcard[data-meal="Laat"] .mplan') === null, "geen avondsnack gepland op ma");


console.log("— Nieuw: gebruiksvriendelijkheid");
data.weeks.push({ id: 2, week_start: "2026-11-22", items: [], prep: [], bonus: [], notes: null, reviewed_at: null, list_recipes: [], shopping: [] });
await m.renderMenu(ctx, "week"); await wait();
ok($$(".mp-weeks [data-week]").length === 2 && txt($(".mp-weeks .chip.on")).startsWith("Deze week"), "weekkeuze: deze week + volgende");
ok($(".mp-reviewbar #review"), "compacte 'Klopt je menu?'-balk");
ok(txt($('.mp-day[data-day="2026-11-16"] .mp-left')).startsWith("nog 626.3 kcal over") && txt($('.mp-day[data-day="2026-11-16"] .mp-left')).includes("nog 10.7 g eiwit"), "dag: wat er nog over is: " + txt($('.mp-day[data-day="2026-11-16"] .mp-left')));
const ps = $$(".mp-day ~ section [data-prep], [data-prep]");
ok(ps.length === 1, "prepstappen als checklist");
ps[0].checked = true; ps[0].dispatchEvent(new Event("change"));
await m.renderMenu(ctx, "week"); await wait();
ok($("[data-prep]").checked, "prepstap blijft afgevinkt na herladen");
// recept-sheet in menu
$('.mp-item[data-item="101"]').click(); await wait();
ok($$(".mp-act").length === 4 && $("#eat") && txt($("#eat")).includes("Gegeten"), "actiebalk: wisselen, gegeten, aanpassen, koken");
ok($(".mp-more") && !$(".mp-more").open, "rest zit onder 'Meer'");
$("#eat").click(); await wait(60);
ok(JSON.stringify(calls.filter((c) => c[0] === "mp_item_eaten").at(-1)[1]) === '{"p_item_id":101,"p_eaten":false}', "gegeten-knop in de maaltijd werkt");
$$(".sheet").forEach((x) => x.remove());
// volgende week tonen, leeg -> kopiëren
await m.renderMenu(ctx, "week"); await wait();
$('[data-week="2"]').click(); await wait();
ok(txt($(".panel h3")) === "Deze week is nog leeg" && $("#copyPrev"), "lege week: kopieerknop");
$("#copyPrev").click(); await wait();
ok(JSON.stringify(calls.filter((c) => c[0] === "mp_week_new").at(-1)[1]) === '{"p_copy_from":1}', "kopieer roept mp_week_new(1)");
// editor: opties ingeklapt, afdeling geraden
await m.renderMenu(ctx, "week"); await wait();
$('[data-week="1"]')?.click(); await wait();
$('.mp-edit[data-r="4"]').click(); await wait(80);
ok($$(".e-opts").every((o) => o.hidden), "winkel/afdeling standaard ingeklapt");
$(".e-more").click(); ok(!$(".e-opts").hidden, "▾ klapt opties open");
ok([...$(".e-shop").options].map((o) => o.value).join(",") === ",AH,Colruyt,Okay", "winkels: AH, Colruyt/Lidl, Okay");
$("#eAdd").click(); await wait(300);
$$(".fi").find((x) => x.textContent.includes("Rundergehakt")).querySelector(".fi-add").click(); await wait(150);
ok($$(".e-dept").at(-1).value === "Vlees & vis", "afdeling geraden uit productnaam");
$$(".sheet").forEach((x) => x.remove());
// boodschappen kopiëren
let copied = null; Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
await m.renderMenu(ctx, "lijst"); await wait();
$('.mp-copy[data-moment="zondag"]').click(); await wait();
ok(copied === "Zondag (AH)\n\nVlees & vis\n- 400 g Gehakt", "kopie: alleen niet-afgevinkt, zonder voorraad: " + JSON.stringify(copied));

console.log(fails ? `\n${fails} FOUT(EN)` : "\nAlles OK");
