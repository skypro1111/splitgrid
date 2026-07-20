import type { WebContents } from 'electron';
import type { FastChatMessage, FastChatSettings } from '../shared/types';

// Streams chat completions from an OpenAI-compatible `/chat/completions`
// endpoint (OpenAI, OpenRouter, Groq, Ollama's `/v1`, LM Studio, …) and
// forwards token deltas to the renderer over IPC. The API key never leaves the
// main process: the renderer triggers a request by id and listens for chunks.
export class QuickChatManager {
  // requestId -> AbortController for the in-flight fetch (so the renderer can cancel).
  private inflight = new Map<string, AbortController>();

  cancel(requestId: string): void {
    this.inflight.get(requestId)?.abort();
    this.inflight.delete(requestId);
  }

  // Kicks off a streamed completion. Resolves/rejects nothing to the caller —
  // all output flows through `sender` events keyed by `requestId`.
  async stream(
    sender: WebContents,
    requestId: string,
    config: FastChatSettings,
    messages: FastChatMessage[],
    // Per-request model override (the user's in-chat selection). Falls back to
    // the configured default model when empty.
    modelOverride?: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(requestId, controller);

    const send = (channel: string, payload: Record<string, unknown>) => {
      if (!sender.isDestroyed()) sender.send(channel, { requestId, ...payload });
    };
    const fail = (error: string) => {
      this.inflight.delete(requestId);
      send('quick-chat:error', { error });
    };

    const base = config.baseUrl.trim().replace(/\/+$/, '');
    if (!base) return fail('Fast chat base URL is not set.');
    const model = (modelOverride && modelOverride.trim()) || config.model.trim();
    if (!model) return fail('Fast chat model is not set.');
    const url = `${base}/chat/completions`;

    const fullMessages: FastChatMessage[] = config.systemPrompt
      ? [{ role: 'system', content: config.systemPrompt }, ...messages]
      : messages;

    let res: Response;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
      const body: Record<string, unknown> = {
        model,
        messages: fullMessages,
        temperature: config.temperature,
        stream: true,
      };
      // Only sent for reasoning-capable models; omitted otherwise so plain
      // chat models don't reject an unknown parameter.
      if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) { this.inflight.delete(requestId); return; }
      return fail(`Request failed: ${(err as Error).message}`);
    }

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      const detail = body.slice(0, 500);
      return fail(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      // Parse the Server-Sent Events stream: `data: {json}` lines, one JSON
      // object per chunk, ending with `data: [DONE]`.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { this.inflight.delete(requestId); return send('quick-chat:done', {}); }
          try {
            const parsed = JSON.parse(data);
            const delta: string =
              parsed?.choices?.[0]?.delta?.content ??
              parsed?.choices?.[0]?.message?.content ??
              '';
            if (delta) send('quick-chat:chunk', { delta });
          } catch {
            // Ignore keep-alive / partial lines — they re-buffer on next read.
          }
        }
      }
      this.inflight.delete(requestId);
      send('quick-chat:done', {});
    } catch (err) {
      if (controller.signal.aborted) { this.inflight.delete(requestId); return; }
      fail(`Stream interrupted: ${(err as Error).message}`);
    }
  }
}
