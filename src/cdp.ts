/**
 * Minimal Chrome DevTools Protocol client over a single WebSocket.
 * Uses the "flat" protocol: every message may carry a sessionId so one socket
 * multiplexes the browser target plus every page target for every agent.
 * Zero dependencies: Node >= 22 ships a global WebSocket client.
 */
import { EventEmitter } from "node:events";

export interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

export class CdpError extends Error {
  constructor(public method: string, public code: number, message: string, public data?: any) {
    super(`${method}: ${message}${data ? " " + JSON.stringify(data) : ""}`);
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string; t0: number };

export class CdpClient extends EventEmitter {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** rolling stats for the benchmark: total round trips + total ms */
  public stats = { calls: 0, ms: 0 };

  static async connect(wsUrl: string): Promise<CdpClient> {
    const c = new CdpClient();
    await c.open(wsUrl);
    return c;
  }

  private open(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e: any) => reject(new Error(`CDP socket error: ${e?.message ?? e}`)));
      ws.addEventListener("close", () => {
        for (const p of this.pending.values()) p.reject(new Error("CDP socket closed"));
        this.pending.clear();
        this.emit("close");
      });
      ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(String(ev.data)));
    });
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.stats.calls++;
      this.stats.ms += performance.now() - p.t0;
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      const ev: CdpEvent = { method: msg.method, params: msg.params, sessionId: msg.sessionId };
      // Session-scoped listeners get first dibs, then global.
      if (msg.sessionId) this.emit(`${msg.sessionId}:${msg.method}`, ev.params, ev);
      this.emit(msg.method, ev.params, ev);
      this.emit("event", ev);
    }
  }

  /** Send a CDP command. sessionId undefined => browser-level target. */
  send<T = any>(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, t0: performance.now() });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** Wait once for an event (optionally session-scoped), with timeout. */
  waitFor<T = any>(method: string, opts: { sessionId?: string; timeoutMs?: number; filter?: (p: T) => boolean } = {}): Promise<T> {
    const key = opts.sessionId ? `${opts.sessionId}:${method}` : method;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(key, handler);
        reject(new Error(`timeout waiting for ${method}`));
      }, opts.timeoutMs ?? 15000);
      const handler = (params: T) => {
        if (opts.filter && !opts.filter(params)) return;
        clearTimeout(timer);
        this.off(key, handler);
        resolve(params);
      };
      this.on(key, handler);
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}
