/**
 * chrome-agent CLI — the agent-facing surface. Every invocation is one
 * JSON-lines request to the daemon; `repl`/`batch` keep a single connection
 * open so a whole workflow costs one process spawn.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { DaemonClient, readDaemonInfo, startDaemon, homeDir, sockPath } from "./protocol.js";

const HELP = `chrome-agent — a Chrome CLI for AI agents (headless CDP, shared daemon, isolated sessions)

usage: chrome-agent [-s <session>] [-c <context>] [--json] <command> [args] [flags]

 -s <name>   session (one page + private cookies/storage per agent; auto-created; default "default")
 -c <name>   shared context: sessions with the same -c share cookies, storage and renderer processes
             (agents collaborating in one logged-in account, or max density). Omit for full isolation.

 navigation   goto <url> [--wait load|domcontentloaded|idle|none]   back | forward | reload
 reading      tree [-i] [--urls] [--max-text N] [--max-lines N] [--stats]   compact action map with @ids
              find <text>            tree lines matching text
              text [--max N]         page innerText
              eval <js>              run JS, print JSON result
              screenshot [-o f.png] [--jpeg] [--full]
 acting       click <@id|css> [--js] [--right] [--double] [--wait]
              type <@id|css> <text> [--no-clear] [--submit] [--keys]
              press <key>            Enter, Tab, Escape, cmd+a, shift+Tab, ArrowDown ...
              hover|focus <@id>      select <@id> <value>      check|uncheck <@id>
              scroll [--down N|--up N|--top|--bottom] [--at @id]
              wait [ms] [--text T] [--selector S] [--gone S] [--load] [--release] [--timeout ms]
              viewport <W>x<H> [--mobile]
 batching     batch "<cmd>" "<cmd>" ...     or   batch -   (one command per stdin line)
              repl                          read commands from stdin until EOF, single connection
 humans       screencast [--port N] [--stop] [--open]    1:1 live mirror + takeover in a browser tab
              devtools [--open]                          Chrome DevTools attached to this session
 sessions     sessions | new [name] | close [name] | close --all
 daemon       status [--stats] | daemon start [--headed] [--images] | daemon stop | ping

 env: CHROME_AGENT_HOME, CHROME_AGENT_SOCK, CHROME_HEADLESS_SHELL_PATH, CHROME_PATH
`;

function tokenize(line: string): string[] {
  // `eval` takes the rest of the line verbatim so JS quotes survive: eval document.querySelector('[name=q]').value
  const ev = line.match(/^((?:-(?:s|c|-session|-context)\s+\S+\s+|--json\s+)*)eval\s+([\s\S]*)$/);
  if (ev) return [...tokenize(ev[1]), "eval", ev[2].trim()];
  const out: string[] = []; let cur = ""; let q: string | null = null; let had = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; else if (ch === "\\" && line[i + 1] === q) { cur += q; i++; } else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; had = true; }
    else if (/\s/.test(ch)) { if (cur || had) { out.push(cur); cur = ""; had = false; } }
    else cur += ch;
  }
  if (cur || had) out.push(cur);
  return out;
}

interface Parsed { cmd: string; pos: string[]; flags: Record<string, string | boolean>; session?: string; context?: string; json: boolean }
function parse(argv: string[]): Parsed {
  const p: Parsed = { cmd: "", pos: [], flags: {}, json: false };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift()!;
    if (a === "-s" || a === "--session") p.session = rest.shift();
    else if (a === "-c" || a === "--context") p.context = rest.shift();
    else if (a === "--json") p.json = true;
    else if (a === "-i") p.flags.interactiveOnly = true;
    else if (a === "-o") p.flags.out = rest.shift()!;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (v !== undefined) p.flags[key] = v;
      else if (rest.length && !rest[0].startsWith("-") && !["json", "stats", "urls", "js", "right", "double", "wait", "submit", "keys", "noClear", "full", "jpeg", "top", "bottom", "load", "release", "open", "stop", "all", "headed", "images", "mobile", "interactiveOnly"].includes(key)) p.flags[key] = rest.shift()!;
      else p.flags[key] = true;
    } else if (!p.cmd) p.cmd = a;
    else p.pos.push(a);
  }
  return p;
}

const N = (v: any) => (v === undefined || v === true ? undefined : Number(v));

/** Map a parsed CLI command onto a daemon request. */
function toRequest(p: Parsed): { cmd: string; args: Record<string, any> } {
  const f = p.flags, [a0, a1] = p.pos;
  switch (p.cmd) {
    case "goto": return { cmd: "goto", args: { url: a0, wait: f.wait === true ? "load" : f.wait, timeoutMs: N(f.timeout) } };
    case "tree": return { cmd: "tree", args: { interactiveOnly: !!f.interactiveOnly, urls: !!f.urls, maxText: N(f.maxText), maxLines: N(f.maxLines), stats: !!f.stats, filter: f.filter } };
    case "find": return { cmd: "find", args: { query: p.pos.join(" "), interactiveOnly: !!f.interactiveOnly, urls: !!f.urls } };
    case "text": return { cmd: "text", args: { maxChars: N(f.max) } };
    case "eval": return { cmd: "eval", args: { expression: p.pos.join(" ") } };
    case "screenshot": return { cmd: "screenshot", args: { path: f.out, format: f.jpeg ? "jpeg" : "png", fullPage: !!f.full } };
    case "click": return { cmd: "click", args: { ref: a0, js: !!f.js, button: f.right ? "right" : "left", count: f.double ? 2 : 1, wait: f.wait === true ? "load" : f.wait } };
    case "type": return { cmd: "type", args: { ref: a0, text: p.pos.slice(1).join(" "), clear: !f.noClear, submit: !!f.submit, keys: !!f.keys, delayMs: N(f.delay) } };
    case "press": return { cmd: "press", args: { key: a0, wait: f.wait === true ? "load" : f.wait } };
    case "hover": return { cmd: "hover", args: { ref: a0 } };
    case "focus": return { cmd: "focus", args: { ref: a0 } };
    case "select": return { cmd: "select", args: { ref: a0, value: p.pos.slice(1).join(" ") } };
    case "check": return { cmd: "check", args: { ref: a0, state: true } };
    case "uncheck": return { cmd: "check", args: { ref: a0, state: false } };
    case "scroll": return { cmd: "scroll", args: { ref: f.at, dy: f.up ? -(N(f.up) ?? 600) : f.down ? N(f.down) ?? 600 : undefined, to: f.top ? "top" : f.bottom ? "bottom" : undefined } };
    case "wait": return { cmd: "wait", args: { ms: a0 && /^\d+$/.test(a0) ? Number(a0) : undefined, text: f.text, selector: f.selector, gone: f.gone, load: f.load === true ? "load" : f.load, release: !!f.release, timeoutMs: N(f.timeout) } };
    case "viewport": { const [w, h] = (a0 ?? "1280x800").split("x").map(Number); return { cmd: "viewport", args: { width: w, height: h, mobile: !!f.mobile } }; }
    case "back": case "forward": case "reload": case "info": case "ping": return { cmd: p.cmd, args: {} };
    case "status": return { cmd: "status", args: { stats: !!f.stats } };
    case "sessions": return { cmd: "sessions", args: {} };
    case "new": return { cmd: "session.new", args: {} };
    case "close": return f.all ? { cmd: "session.closeAll", args: {} } : { cmd: "session.close", args: { name: a0 } };
    case "screencast": return { cmd: "screencast", args: { port: N(f.port), stop: !!f.stop } };
    case "devtools": return { cmd: "devtools", args: {} };
    case "stop": return { cmd: "stop", args: {} };
  }
  throw new Error(`unknown command '${p.cmd}'. Run chrome-agent --help`);
}

function render(p: Parsed, cmd: string, r: any): string {
  if (p.json) return JSON.stringify(r);
  if (!r.ok) return `error: ${r.error}`;
  const x = r.result;
  switch (cmd) {
    case "tree": case "find": return x.text + (x.truncated ? "\n…(truncated)" : "") + (p.flags.stats ? `\n# nodes=${x.nodeCount} emitted=${x.emitted} estTokens=${x.estTokens} vs screenshot≈${x.screenshotTokensEquivalent} tokens` : "");
    case "text": return x.text;
    case "eval": return typeof x.value === "string" ? x.value : JSON.stringify(x.value);
    case "screenshot": return x.path ? `wrote ${x.path} (${x.bytes} bytes)` : `${x.bytes} bytes (base64 in --json)`;
    case "status": return JSON.stringify(x, null, 2);
    case "sessions": return x.length ? x.map((s: any) => `${s.name}\t${s.url}\t${s.actions} actions`).join("\n") : "(no sessions)";
    case "screencast": return x.stopped ? "screencast stopped" : `mirror: ${x.url}`;
    case "devtools": return x.url;
    default: return "ok " + JSON.stringify(x) + ` (${r.ms}ms)`;
  }
}

async function runOne(client: DaemonClient, p: Parsed, session?: string, context?: string): Promise<{ text: string; ok: boolean }> {
  const { cmd, args } = toRequest(p);
  const r = await client.call(cmd, args, p.session ?? session, p.context ?? context);
  if (cmd === "screenshot" && r.ok && !r.result.path && !p.json) {
    const file = `screenshot-${Date.now()}.${r.result.format}`; writeFileSync(file, Buffer.from(r.result.base64, "base64")); r.result.path = file;
  }
  const text = render(p, cmd, r);
  if ((cmd === "screencast" || cmd === "devtools") && r.ok && p.flags.open) spawn(process.platform === "darwin" ? "open" : "xdg-open", [r.result.url], { stdio: "ignore", detached: true }).unref();
  return { text, ok: r.ok };
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { process.stdout.write(HELP); return; }
  const p = parse(argv);

  if (p.cmd === "install") {
    const { spawnSync } = await import("node:child_process");
    const { BROWSERS_DIR } = await import("./launcher.js");
    const r = spawnSync("npx", ["--yes", "@puppeteer/browsers", "install", `chrome-headless-shell@${p.pos[0] ?? "stable"}`, "--path", BROWSERS_DIR], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  if (p.cmd === "daemon") {
    const sub = p.pos[0] ?? "start";
    if (sub === "start") {
      const info = readDaemonInfo();
      if (info) { console.log(`daemon already running pid=${info.pid} cdp=${info.port}`); return; }
      const args = [p.flags.headed && "--headed", p.flags.images && "--images", p.flags.exe && `--exe`, p.flags.exe, p.flags.mirrorPort && "--mirror-port", p.flags.mirrorPort, p.flags.pool && "--pool", p.flags.pool].filter(Boolean) as string[];
      const t0 = Date.now();
      await startDaemon(args);
      let c: DaemonClient | null = null;
      for (let i = 0; i < 300 && !c; i++) { c = await DaemonClient.connect(sockPath(), false).catch(() => null); if (!c) await new Promise((r) => setTimeout(r, 50)); }
      if (!c) throw new Error(`daemon did not start; see ${homeDir()}/daemon.log`);
      const s = await c.run("status"); c.close();
      console.log(`daemon started in ${Date.now() - t0}ms`);
      console.log(`daemon pid=${s.pid} engine=${s.engine} chrome=${s.chromePid} cdp=${s.cdpPort} footprint=${s.memory.chromiumFootprintMB ?? s.memory.totalRssMB}MB pool=${s.pool}`);
      return;
    }
    if (sub === "stop") { const c = await DaemonClient.connect(sockPath(), false).catch(() => null); if (!c) { console.log("daemon not running"); return; } await c.call("stop"); c.close(); console.log("daemon stopped"); return; }
    if (sub === "status") { p.cmd = "status"; }
  }
  const client = await DaemonClient.connect(sockPath(), true);
  let exit = 0;
  try {
    if (p.cmd === "batch" || p.cmd === "repl") {
      const lines = p.cmd === "repl" || p.pos[0] === "-" ? readFileSync(0, "utf8").split("\n") : p.pos;
      for (const raw of lines) {
        const line = raw.trim(); if (!line || line.startsWith("#")) continue;
        const sub = parse(tokenize(line)); sub.json ||= p.json; sub.session ??= p.session; sub.context ??= p.context;
        try { const r = await runOne(client, sub, p.session, p.context); process.stdout.write(r.text + "\n"); if (!r.ok && p.flags.stopOnError) { exit = 1; break; } }
        catch (e: any) { process.stdout.write(`error: ${e.message}\n`); if (p.flags.stopOnError) { exit = 1; break; } }
      }
    } else {
      const r = await runOne(client, p); process.stdout.write(r.text + "\n"); if (!r.ok) exit = 1;
    }
  } finally { client.close(); }
  process.exitCode = exit;
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); });
