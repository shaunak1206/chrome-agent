/**
 * chrome-agent daemon: one Chromium process tree, many isolated agent sessions,
 * a Unix-socket JSON-lines API, a warm session pool, and an optional human mirror.
 *
 *   node dist/daemon.js [--headed] [--images] [--pool N] [--mirror-port N] [--exe /path/to/chromium]
 */
import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { CdpClient } from "./cdp.js";
import { launch, type LaunchedBrowser } from "./launcher.js";
import { Session, type WaitUntil } from "./session.js";
import { Mirror } from "./mirror.js";
import { homeDir, infoPath, lockPath, sockPath, type Request, type Response } from "./protocol.js";
const HOME = homeDir(), INFO = infoPath(), LOCK = lockPath(), SOCK = sockPath();   // fixed for the daemon's lifetime
import { screenshotTokens } from "./tree.js";
import { processTreeMemory } from "./memory.js";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const sessions = new Map<string, Session>();
const contexts = new Map<string, string>();          // shared context name -> browserContextId
const queues = new Map<string, Promise<any>>();      // per-session serialization
const latency = new Map<string, number[]>();         // cmd -> ms samples
const pool: Session[] = [];                          // pre-warmed private sessions
let poolInflight = 0;
const POOL_SIZE = Number(opt("--pool", "2"));
let browser: LaunchedBrowser;
let cdp: CdpClient;
const mirror = new Mirror(() => sessions);
const startedAt = Date.now();
const VIEWPORT: [number, number] = [Number(opt("--width", "1280")), Number(opt("--height", "800"))];
const createTimes: number[] = [];

async function main() {
  mkdirSync(HOME, { recursive: true });
  browser = await launch({ headless: !flag("--headed"), images: flag("--images"), executablePath: opt("--exe"), windowSize: VIEWPORT, userDataDir: opt("--user-data-dir") });
  cdp = await CdpClient.connect(browser.wsUrl);
  cdp.on("close", () => shutdown("cdp socket closed"));
  browser.proc.on("exit", () => shutdown("chromium exited"));
  // Close the initial about:blank tab; agents get their own contexts.
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const t of targetInfos) if (t.type === "page") cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  if (opt("--mirror-port")) await mirror.listen(Number(opt("--mirror-port")));

  if (existsSync(SOCK)) unlinkSync(SOCK);
  const server = createServer(onConnection);
  server.listen(SOCK);
  writeFileSync(INFO, JSON.stringify({ pid: process.pid, chromePid: browser.pid, port: browser.port, wsUrl: browser.wsUrl, sock: SOCK, headed: flag("--headed"), engine: browser.engine, executablePath: browser.executablePath, userDataDir: browser.userDataDir, startedAt, pool: POOL_SIZE }, null, 2));
  try { unlinkSync(LOCK); } catch {}
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => shutdown(sig));
  process.on("uncaughtException", (e) => console.error("uncaught", e));
  process.on("unhandledRejection", (e) => console.error("unhandled", e));
  console.log(`chrome-agent daemon pid=${process.pid} engine=${browser.engine} chrome=${browser.pid} cdp=${browser.port} sock=${SOCK} pool=${POOL_SIZE}`);
  refillPool();
}

/** Keep POOL_SIZE private sessions ready so `new` / first command is ~instant. */
function refillPool() {
  while (pool.length + poolInflight < POOL_SIZE && !stopping) {
    poolInflight++;
    Session.create(cdp, "__pool__", VIEWPORT).then((s) => { pool.push(s); }).catch((e) => console.error("pool", e.message)).finally(() => { poolInflight--; });
  }
}

function onConnection(sock: Socket) {
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req: Request;
      try { req = JSON.parse(line); } catch { sock.write(JSON.stringify({ id: 0, ok: false, error: "bad json", ms: 0 }) + "\n"); continue; }
      handle(req).then((r) => { if (!sock.destroyed) sock.write(JSON.stringify(r) + "\n"); });
    }
  });
  sock.on("error", () => {});
}

async function handle(req: Request): Promise<Response> {
  const t0 = performance.now();
  const done = (ok: boolean, result?: any, error?: string): Response => {
    const ms = +(performance.now() - t0).toFixed(2);
    if (!latency.has(req.cmd)) latency.set(req.cmd, []);
    const arr = latency.get(req.cmd)!; arr.push(ms); if (arr.length > 5000) arr.shift();
    return { id: req.id, ok, result, error, ms };
  };
  try {
    const global = await handleGlobal(req);
    if (global !== NOT_GLOBAL) return done(true, global);
    const name = req.session ?? "default";
    // Serialize commands per session; different sessions run fully in parallel.
    const prev = queues.get(name) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => handleSession(name, req));
    queues.set(name, run);
    return done(true, await run);
  } catch (e: any) {
    return done(false, undefined, e?.message ?? String(e));
  }
}

const NOT_GLOBAL = Symbol();
async function handleGlobal(req: Request): Promise<any> {
  const a = req.args ?? {};
  switch (req.cmd) {
    case "ping": return { pong: true, pid: process.pid };
    case "status": return status(a.stats);
    case "sessions": return Promise.all([...sessions.values()].map((s) => s.info()));
    case "session.close": return closeSession(a.name ?? req.session ?? "default");
    case "session.closeAll": { const names = [...sessions.keys()]; await Promise.all(names.map(closeSession)); return { closed: names }; }
    case "screencast": {
      const port = await mirror.listen(Number(a.port ?? process.env.CHROME_AGENT_MIRROR_PORT ?? 9333));
      const s = await getSession(req.session ?? "default", req.context);
      if (a.stop) { await s.stopScreencast(); return { stopped: true }; }
      mirror.attach(s);
      return { url: `http://127.0.0.1:${port}/view?s=${encodeURIComponent(s.name)}`, index: `http://127.0.0.1:${port}/`, session: s.name };
    }
    case "devtools": {
      const s = await getSession(req.session ?? "default", req.context);
      return { url: `http://127.0.0.1:${browser.port}/devtools/inspector.html?ws=127.0.0.1:${browser.port}/devtools/page/${s.targetId}`, cdp: `ws://127.0.0.1:${browser.port}/devtools/page/${s.targetId}` };
    }
    case "stop": setTimeout(() => shutdown("stop"), 20); return { stopping: true };
  }
  return NOT_GLOBAL;
}

async function closeSession(name: string) {
  const s = sessions.get(name);
  if (!s) return { closed: false };
  sessions.delete(name); queues.delete(name);
  const shared = s.context !== null;
  const stillUsed = shared && [...sessions.values()].some((o) => o.contextId === s.contextId);
  await s.close(!stillUsed);
  if (shared && !stillUsed) contexts.delete(s.context!);
  return { closed: name };
}

/**
 * Get-or-create. Private sessions come from the warm pool (≈0ms); sessions in a
 * named shared context are created on demand and share cookies, storage, and
 * (per site) renderer processes with their siblings — for agents collaborating
 * inside one logged-in account, or for maximum density.
 */
async function getSession(name: string, context?: string): Promise<Session> {
  let s = sessions.get(name);
  if (s) return s;
  const t0 = performance.now();
  if (context) {
    let ctxId = contexts.get(context);
    if (!ctxId) { ctxId = (await cdp.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId; contexts.set(context, ctxId!); }
    s = await Session.create(cdp, name, VIEWPORT, ctxId);
    s.context = context;
  } else if (pool.length) {
    s = pool.shift()!; s.name = name; s.createdAt = Date.now();
    refillPool();
  } else {
    s = await Session.create(cdp, name, VIEWPORT);
    refillPool();
  }
  sessions.set(name, s);
  (s as any).createMs = +(performance.now() - t0).toFixed(2);
  createTimes.push((s as any).createMs);
  return s;
}

async function handleSession(name: string, req: Request): Promise<any> {
  const a = req.args ?? {};
  const s = await getSession(name, req.context);
  switch (req.cmd) {
    case "session.new": return { ...(await s.info()), createMs: (s as any).createMs };
    case "goto": return s.goto(a.url, (a.wait as WaitUntil) ?? "load", a.timeoutMs);
    case "tree": { const r = await s.tree({ interactiveOnly: a.interactiveOnly, urls: a.urls, maxText: a.maxText, maxLines: a.maxLines, filter: a.filter }); return a.stats ? { ...r, lines: undefined, screenshotTokensEquivalent: screenshotTokens(s.viewport[0], s.viewport[1]) } : { text: r.text, estTokens: r.estTokens, truncated: r.truncated }; }
    case "find": { const r = await s.find(a.query, { interactiveOnly: a.interactiveOnly, urls: a.urls }); return { text: r.lines.slice(1).join("\n"), estTokens: r.estTokens }; }
    case "text": return { text: await s.text(a.maxChars) };
    case "eval": return { value: await s.eval(a.expression) };
    case "screenshot": {
      const buf = await s.screenshot({ format: a.format, quality: a.quality, fullPage: a.fullPage });
      if (a.path) { writeFileSync(a.path, buf); return { path: a.path, bytes: buf.length }; }
      return { base64: buf.toString("base64"), bytes: buf.length, format: a.format ?? "png" };
    }
    case "click": return s.click(a.ref, { button: a.button, count: a.count, js: a.js, wait: a.wait });
    case "type": return s.type(a.ref, a.text, { clear: a.clear, submit: a.submit, keys: a.keys, delayMs: a.delayMs });
    case "press": return s.press(a.key, { wait: a.wait });
    case "hover": return s.hover(a.ref);
    case "focus": return s.focus(a.ref);
    case "select": return s.select(a.ref, a.value);
    case "check": return s.check(a.ref, a.state ?? true);
    case "scroll": return s.scroll(a);
    case "wait": return s.wait(a);
    case "back": return s.back();
    case "forward": return s.forward();
    case "reload": return s.reload();
    case "viewport": return s.setViewport(a.width, a.height, a.mobile);
    case "info": return s.info();
  }
  throw new Error(`unknown command ${req.cmd}`);
}

async function status(withStats?: boolean) {
  const mem = processTreeMemory(browser.pid);
  const daemonMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
  const res: any = {
    pid: process.pid, engine: browser.engine, executablePath: browser.executablePath, headed: flag("--headed"), chromePid: browser.pid, cdpPort: browser.port, uptimeS: Math.round((Date.now() - startedAt) / 1000),
    sessions: sessions.size, pool: pool.length, contexts: [...contexts.keys()], mirrorPort: mirror.port || null,
    memory: { chromiumRssMB: mem.rssMB, chromiumFootprintMB: mem.footprintMB, chromiumProcesses: mem.processes, byType: mem.byType, daemonRssMB: daemonMB, totalRssMB: +(mem.rssMB + daemonMB).toFixed(1), perSessionFootprintMB: sessions.size && mem.footprintMB ? +(mem.footprintMB / sessions.size).toFixed(1) : null },
    cdp: { calls: cdp.stats.calls, avgRoundTripMs: cdp.stats.calls ? +(cdp.stats.ms / cdp.stats.calls).toFixed(3) : 0 },
    sessionCreateMs: createTimes.length ? { n: createTimes.length, avg: +(createTimes.reduce((a, b) => a + b, 0) / createTimes.length).toFixed(1), max: Math.max(...createTimes) } : null,
  };
  if (withStats) {
    res.latencyMs = Object.fromEntries([...latency.entries()].map(([k, v]) => { const s = [...v].sort((a, b) => a - b); const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]; return [k, { n: s.length, p50: p(0.5), p95: p(0.95), max: s[s.length - 1] }]; }));
    res.memory.perProcess = mem.perProcess;
  }
  return res;
}

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return; stopping = true;
  console.log("shutting down:", reason);
  try { await Promise.race([Promise.all([...sessions.values(), ...pool].map((s) => s.close())), new Promise((r) => setTimeout(r, 1500))]); } catch {}
  try { await Promise.race([cdp.send("Browser.close"), new Promise((r) => setTimeout(r, 1500))]); } catch {}
  try { browser.proc.kill("SIGKILL"); } catch {}
  try { unlinkSync(SOCK); } catch {}
  try { unlinkSync(INFO); } catch {}
  if (!opt("--user-data-dir")) { try { rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {} }
  mirror.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { unlinkSync(LOCK); } catch {} process.exit(1); });
