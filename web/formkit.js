// Kleine formulierhulp: verplichte velden rood markeren, Enter = hoofdknop,
// en voedingswaarden van een etiketfoto lezen (gratis OCR in de browser).

// rules: [{ el: Element|selector, ok: boolean, msg: "..." }]; geeft true als alles klopt
export function check(root, rules) {
  root.querySelectorAll(".fk-err").forEach((e) => e.remove());
  root.querySelectorAll(".invalid").forEach((e) => e.classList.remove("invalid"));
  let first = null;
  for (const r of rules) {
    if (r.ok) continue;
    const el = typeof r.el === "string" ? root.querySelector(r.el) : r.el;
    if (!el) continue;
    el.classList.add("invalid");
    el.setAttribute("aria-invalid", "true");
    const m = document.createElement("p");
    m.className = "fk-err"; m.setAttribute("role", "alert"); m.textContent = r.msg;
    el.insertAdjacentElement("afterend", m);
    const clear = () => { el.classList.remove("invalid"); el.removeAttribute("aria-invalid"); m.remove(); };
    el.addEventListener("input", clear, { once: true });
    el.addEventListener("click", clear, { once: true });
    first ??= el;
  }
  if (first) { first.focus?.({ preventScroll: true }); first.scrollIntoView?.({ block: "center", behavior: "smooth" }); navigator.vibrate?.(40); }
  return !first;
}

// Enter in een gewoon invoerveld drukt op de hoofdknop (niet in textarea)
export function enterSubmits(root, button) {
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type === "checkbox" || t.type === "file") return;
    e.preventDefault();
    const b = typeof button === "string" ? root.querySelector(button) : button;
    if (b && !b.disabled) b.click();
  });
}

// ---------- etiket lezen ----------
const NUM = String.raw`(\d{1,4}(?:[.,]\d{1,2})?)`;
const toN = (s) => (s == null ? null : Number(String(s).replace(",", ".")));

// Haalt per 100 g de waarden uit OCR-tekst van een Nederlands/Engels voedingsetiket.
export function parseLabel(text) {
  const t = text.replace(/[|]/g, " ").replace(/\bO(?=[.,]?\d)/g, "0").replace(/(\d)\s+([.,])\s*(\d)/g, "$1$2$3");
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const first = (re, skip) => {
    for (const l of lines) {
      if (!re.test(l) || (skip && skip.test(l))) continue;
      const m = l.replace(re, " ").match(new RegExp(NUM));
      if (m) return toN(m[1]);
    }
    return null;
  };
  let kcal = null;
  const mk = t.match(new RegExp(NUM + String.raw`\s*kcal`, "i"));
  if (mk) kcal = toN(mk[1]);
  else { const kj = t.match(new RegExp(NUM + String.raw`\s*kj`, "i")); if (kj) kcal = Math.round(toN(kj[1]) / 4.184); }
  const out = {
    kcal,
    fat: first(/\b(vetten|vet|fat|lipides)(?![a-z])/i, /verzadig|saturat|satur|onverz/i),
    carbs: first(/(koolhydraten|koolhydraat|carbohydrate|glucides)/i, /waarvan|suiker|sugar/i),
    protein: first(/(eiwitten|eiwit|protein|prot[eé]ines)/i),
    fiber: first(/(vezels|voedingsvezel|fibre|fiber|fibres)/i),
  };
  // onmogelijke waarden per 100 g wegfilteren
  for (const k of ["fat", "carbs", "protein", "fiber"]) if (out[k] != null && out[k] > 100) out[k] = null;
  if (out.kcal != null && (out.kcal < 0 || out.kcal > 950)) out.kcal = null;
  return out;
}

let tess = null;
export async function readLabel(file, onStatus = () => {}) {
  onStatus("OCR laden… (de eerste keer duurt dit even)");
  tess ??= await import("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js");
  const T = tess.default || tess;
  const worker = await T.createWorker(["nld", "eng"], 1, {
    logger: (m) => { if (m.status === "recognizing text") onStatus(`Etiket lezen… ${Math.round((m.progress || 0) * 100)}%`); },
  });
  try {
    const { data } = await worker.recognize(file);
    return { text: data.text, values: parseLabel(data.text) };
  } finally { await worker.terminate(); }
}
