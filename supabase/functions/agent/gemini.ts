// Kleine Gemini-client met function calling (REST v1beta).
export type Tool = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolRunner = (name: string, args: any) => Promise<unknown>;

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export async function geminiLoop(opts: {
  apiKey: string; model: string; system: string; tools: Tool[]; run: ToolRunner;
  userParts: any[]; history?: any[]; maxSteps?: number;
}): Promise<{ text: string; actions: { tool: string; purpose?: string; rows?: number; error?: string }[] }> {
  const contents: any[] = [...(opts.history ?? []), { role: "user", parts: opts.userParts }];
  const actions: { tool: string; purpose?: string; rows?: number; error?: string }[] = [];
  for (let step = 0; step < (opts.maxSteps ?? 16); step++) {
    const res = await fetch(`${BASE}/${opts.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents,
        tools: opts.tools.length ? [{ functionDeclarations: opts.tools }] : undefined,
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      }),
    });
    if (res.status === 429 || res.status === 503) {
      // druk of limiet: even wachten en opnieuw
      await new Promise((r) => setTimeout(r, 4000 + step * 2000));
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
