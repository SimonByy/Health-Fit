// Kleine Gemini-client met function calling (REST v1beta).
export type Tool = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolRunner = (name: string, args: any) => Promise<unknown>;

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export async function geminiLoop(opts: {
  apiKey: string; model: string; system: string; tools: Tool[]; run: ToolRunner;
  userParts: any[]; history?: any[]; maxSteps?: number; deadline?: number; json?: boolean;
}): Promise<{ text: string; actions: { tool: string; purpose?: string; rows?: number; error?: string }[] }> {
  const contents: any[] = [...(opts.history ?? []), { role: "user", parts: opts.userParts }];
  const actions: { tool: string; purpose?: string; rows?: number; error?: string }[] = [];
  let retries = 0;
  // Bij drukte (503) of time-out naar het volgende model
  const models = [...new Set([opts.model, "gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-lite-latest"])];
  let mi = 0;
  for (let step = 0; step < (opts.maxSteps ?? 16); step++) {
    let res: Response;
    const left = (opts.deadline ?? Date.now() + 120000) - Date.now();
    if (left < 4000) throw new Error("Geen tijd meer (Gemini te traag)");
    try {
      res = await fetch(`${BASE}/${models[mi]}:generateContent`, {
      signal: AbortSignal.timeout(Math.min(30000, left)),
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents,
        tools: opts.tools.length ? [{ functionDeclarations: opts.tools }] : undefined,
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096, ...(opts.json ? { responseMimeType: "application/json" } : {}) },
      }),
      });
    } catch (e) {
      if (++retries > 4 || mi >= models.length - 1) throw new Error(`Gemini time-out (${models[mi]}): ${e}`);
      mi++; step--; continue;
    }
    if (res.status === 503 && mi < models.length - 1) { await res.body?.cancel(); mi++; step--; continue; }
    if (res.status === 429 && mi < models.length - 1) {
      // dagquotum of gratis limiet van dit model op: elk model heeft een eigen quotum, dus meteen het volgende proberen
      const body = (await res.text()).slice(0, 400);
      if (/quota|PerDay|limit: \d+/i.test(body)) { mi++; step--; continue; }
      await new Promise((r) => setTimeout(r, Math.min(4000, Math.max(0, left - 8000))));
      if (++retries > 3) { mi++; retries = 0; }
      step--;
      continue;
    }
    if (res.status === 429 || res.status === 503) {
      // druk of limiet: kort wachten en opnieuw, maar niet eindeloos
      const body = (await res.text()).slice(0, 400);
      if (++retries > 3 || /limit: 0|PerDay/i.test(body)) throw new Error(`Gemini ${res.status}: ${body}`);
      await new Promise((r) => setTimeout(r, Math.min(5000 * retries, Math.max(0, left - 8000))));
      step--;
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const out = await res.json();
    const content = out.candidates?.[0]?.content;
    if (!content?.parts) {
      const why = out.candidates?.[0]?.finishReason || out.promptFeedback?.blockReason || "leeg antwoord";
      throw new Error(`Gemini gaf geen antwoord (${why})`);
    }
    contents.push(content); // ongewijzigd terugsturen (bevat eventuele thoughtSignature)
    const calls = content.parts.filter((p: any) => p.functionCall);
    if (!calls.length) {
      return { text: content.parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("\n").trim(), actions };
    }
    const responses = [];
    for (const c of calls) {
      const { name, args } = c.functionCall;
      try {
        const data = await opts.run(name, args ?? {});
        actions.push({ tool: name, purpose: args?.purpose, rows: Array.isArray(data) ? data.length : undefined });
        let txt = JSON.stringify(data ?? null);
        if (txt.length > 40000) txt = txt.slice(0, 40000) + "…(afgekapt: filter of aggregeer)";
        responses.push({ functionResponse: { name, response: { result: txt } } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        actions.push({ tool: name, purpose: args?.purpose, error: msg });
        responses.push({ functionResponse: { name, response: { error: msg } } });
      }
    }
    contents.push({ role: "user", parts: responses });
  }
  throw new Error("Te veel stappen zonder eindantwoord");
}
