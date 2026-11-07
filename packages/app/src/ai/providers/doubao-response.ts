function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItem(item: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(item)) return { value: item, changed: false };
  if (item.type === "function_call" && (item.arguments === undefined || item.arguments === null)) {
    return { value: { ...item, arguments: "" }, changed: true };
  }
  if (item.type === "message" && Array.isArray(item.content)) {
    let changed = false;
    const content = item.content.map((part) => {
      if (!isRecord(part) || part.type !== "output_text" || part.annotations !== undefined) return part;
      changed = true;
      return { ...part, annotations: [] };
    });
    return changed ? { value: { ...item, content }, changed: true } : { value: item, changed: false };
  }
  return { value: item, changed: false };
}

function normalizeOutput(output: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(output)) return { value: output, changed: false };
  let changed = false;
  const value = output.map((item) => {
    const normalized = normalizeItem(item);
    if (normalized.changed) changed = true;
    return normalized.value;
  });
  return { value, changed };
}

export function normalizeDoubaoResponsePayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  let result = payload;
  let changed = false;
  const output = normalizeOutput(payload.output);
  if (output.changed) {
    result = { ...result, output: output.value };
    changed = true;
  }
  const item = normalizeItem(payload.item);
  if (item.changed) {
    result = { ...result, item: item.value };
    changed = true;
  }
  if (isRecord(payload.response)) {
    const nested = normalizeOutput(payload.response.output);
    if (nested.changed) {
      result = { ...result, response: { ...payload.response, output: nested.value } };
      changed = true;
    }
  }
  return changed ? result : payload;
}

function officialDoubaoHost(baseUrl?: string): boolean {
  try {
    const host = new URL(baseUrl ?? "").hostname.toLowerCase();
    return host === "ark.cn-beijing.volces.com" || host.endsWith(".volces.com");
  } catch {
    return false;
  }
}

export function doubaoResponsesProviderOptions(baseUrl?: string) {
  return officialDoubaoHost(baseUrl) ? { openai: { store: false } } : undefined;
}

function normalizeSse(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const source = line.slice(5).trimStart();
      if (!source || source === "[DONE]") return line;
      try {
        const payload = normalizeDoubaoResponsePayload(JSON.parse(source));
        return `data: ${JSON.stringify(payload)}`;
      } catch {
        return line;
      }
    })
    .join(newline);
}

export function wrapDoubaoResponsesFetch(base: typeof fetch, baseUrl?: string): typeof fetch {
  if (!officialDoubaoHost(baseUrl)) return base;
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.ok) return response;
    const contentType = response.headers.get("content-type") ?? "";
    const stream = contentType.includes("text/event-stream");
    if (!stream && !contentType.includes("application/json")) return response;
    if (stream) {
      const body = response.body;
      if (!body) return response;
      let pending = "";
      const normalize = new TransformStream<string, string>({
        transform(chunk, controller) {
          pending += chunk;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          if (lines.length > 0) controller.enqueue(normalizeSse(`${lines.join("\n")}\n`));
        },
        flush(controller) {
          if (pending) controller.enqueue(normalizeSse(pending));
        },
      });
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(
        body.pipeThrough(new TextDecoderStream()).pipeThrough(normalize).pipeThrough(new TextEncoderStream()),
        {
          status: response.status,
          statusText: response.statusText,
          headers,
        },
      );
    }
    const source = await response.clone().text();
    let text = source;
    try {
      const payload = normalizeDoubaoResponsePayload(JSON.parse(source));
      if (payload !== JSON.parse(source)) text = JSON.stringify(payload);
    } catch {
      return response;
    }
    if (text === source) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  };
}
