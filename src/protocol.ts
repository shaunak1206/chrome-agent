/**
 * Daemon <-> CLI wire protocol: newline-delimited JSON over a Unix domain socket.
 *   request : {"id":1,"cmd":"click","session":"agent7","args":{"ref":"@14"}}
 *   response: {"id":1,"ok":true,"result":{...},"ms":1.8}
 * One connection can pipeline any number of requests (used by `repl`, `batch`, and the benchmark).
 */
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved at call time (not import time) so a process may set CHROME_AGENT_HOME after importing
// and every path — including the lock the daemon must clear — agrees between parent and daemon.
export const homeDir = () => process.env.CHROME_AGENT_HOME ?? join(homedir(), ".chrome-agent");
export const sockPath = () => process.env.CHROME_AGENT_SOCK ?? join(homeDir(), "daemon.sock");
export const infoPath = () => join(homeDir(), "daemon.json");
export const lockPath = () => join(homeDir(), "daemon.lock");

export interface Request { id: number; cmd: string; session?: string; context?: string; args?: Record<string, any> }
export interface Response { id: number; ok: boolean; result?: any; error?: string; ms: number }

export class DaemonClient {
  private sock!: Socket;
  private next = 1;
  private pending = new Map<number, { resolve: (r: Response) => void }>();
  private buf = "";

  static async connect(path = sockPath(), autoStart = true, daemonArgs: string[] = []): Promise<DaemonClient> {
    const c = new DaemonClient();
    try { await c.open(path); return c; }
    catch (e) {
      if (!autoStart) throw e;
      await startDaemon(daemonArgs);
      for (let i = 0; i < 200; i++) {
        try { await c.open(path); return c; } catch { await new Promise((r) => setTimeout(r, 50)); }
      }
      throw new Error("daemon did not come up");
    }
  }

  private open(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = createConnection(path);
      s.once("connect", () => { this.sock = s; resolve(); });
      s.once("error", reject);
      s.on("data", (d) => this.onData(d.toString()));
      s.on("close", () => { for (const p of this.pending.values()) p.resolve({ id: 0, ok: false, error: "daemon connection closed", ms: 0 }); this.pending.clear(); });
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const r: Response = JSON.parse(line);
      this.pending.get(r.id)?.resolve(r); this.pending.delete(r.id);
    }
  }

  call(cmd: string, args: Record<string, any> = {}, session?: string, context?: string): Promise<Response> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.sock.write(JSON.stringify({ id, cmd, session, context, args } satisfies Request) + "\n");
    });
  }

  /** Throwing variant for programmatic use. */
  async run<T = any>(cmd: string, args: Record<string, any> = {}, session?: string, context?: string): Promise<T> {
    const r = await this.call(cmd, args, session, context);
    if (!r.ok) throw new Error(r.error);
    return r.result as T;
  }

  close() { this.sock.end(); }
}

/**
 * Spawn the daemon exactly once even when many CLIs/agents race to start it:
 * an O_EXCL lock file guards the spawn; the daemon deletes it once listening.
 */
export async function startDaemon(args: string[] = []): Promise<boolean> {
  const home = homeDir(), lock = lockPath();
  mkdirSync(home, { recursive: true });
  try {
    const fd = openSync(lock, "wx"); writeSync(fd, String(process.pid)); closeSync(fd);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < 20000) return false;               // someone else is starting it; just wait
    try { unlinkSync(lock); } catch {}
    return startDaemon(args);
  }
  const here = fileURLToPath(import.meta.url);
  const daemonJs = join(here, "..", "daemon.js");
  const log = openSync(join(home, "daemon.log"), "a");
  const child = spawn(process.execPath, [daemonJs, ...args], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  return true;
}

export function readDaemonInfo(): any | null {
  try { return existsSync(infoPath()) ? JSON.parse(readFileSync(infoPath(), "utf8")) : null; } catch { return null; }
}
