/**
 * End-to-end test suite. Boots the local test site and a fresh daemon in a
 * temp home, then exercises every command through the daemon protocol, the
 * CLI binary, the mirror HTTP API, and the MCP server.
 *   node dist/test/e2e.js [--keep]      (exit code = number of failures)
 */
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import { fileURLToPath } from "node:url";
import { startTestSite, FACT_FOR } from "../test-site/server.js";
import { DaemonClient, startDaemon } from "../protocol.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "bin", "chrome-agent.js");
let pass = 0, fail = 0; const failures: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function test(name: string, fn: () => Promise<void>) {
  const t0 = performance.now();
  try { await fn(); pass++; console.log(`  ok   ${name} (${(performance.now() - t0).toFixed(0)}ms)`); }
  catch (e: any) { fail++; failures.push(name); console.log(`  FAIL ${name}: ${e.message.split("\n")[0]}`); }
}
function eq(a: any, b: any, msg = "") { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function ok(c: any, msg = "assertion") { if (!c) throw new Error(msg); }
function pick(tree: string, role: string, name: RegExp): string { for (const l of tree.split("\n")) { const m = l.match(/^\s*(@\d+) (\S+) "([^"]*)"/); if (m && m[2] === role && name.test(m[3])) return m[1]; } throw new Error(`no ${role} ${name}`); }

async function main() {
  const site = await startTestSite(0); const base = `http://127.0.0.1:${site.port}`;
  const home = mkdtempSync(join(tmpdir(), "chrome-agent-e2e-"));
  process.env.CHROME_AGENT_HOME = home; const sock = join(home, "daemon.sock"); process.env.CHROME_AGENT_SOCK = sock;
  const env = { ...process.env, CHROME_AGENT_HOME: home, CHROME_AGENT_SOCK: sock };
  // NOTE: must be async — the test site lives in this process, so a synchronous exec would deadlock any navigation.
  const cli = async (...args: string[]) => (await execFileP(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 30000 })).stdout.trim();
  const cliStdin = (input: string, ...args: string[]) => new Promise<{ out: string; code: number }>((res) => { const p = spawn(process.execPath, [CLI, ...args], { env }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.on("exit", (code) => res({ out, code: code ?? -1 })); p.stdin.end(input); });

  console.log("daemon");
  await test("cli auto-starts daemon (exactly one), ping works", async () => {
    // Race 4 CLIs at once: the lock must make only one daemon.
    const outs = await Promise.all([0, 1, 2, 3].map(() => new Promise<string>((res) => { const p = spawn(process.execPath, [CLI, "ping"], { env: { ...process.env, CHROME_AGENT_HOME: home, CHROME_AGENT_SOCK: sock } }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("exit", () => res(o.trim())); })));
    for (const o of outs) ok(o.includes("pong"), "ping: " + o);
    const pids = new Set(outs.map((o) => o.match(/"pid":(\d+)/)?.[1]));
    eq(pids.size, 1, "one daemon pid across racing CLIs");
    ok(existsSync(join(home, "daemon.json")), "daemon.json written");
    ok(!existsSync(join(home, "daemon.lock")), "lock removed after start (in the temp home)");
    ok(!existsSync(join(process.env.HOME ?? "", ".chrome-agent", "daemon.lock")), "no stray lock in the default home");
  });
  const c = await DaemonClient.connect(sock, false);
  const run = (cmd: string, args: Record<string, any> = {}, session = "t1", context?: string) => c.run(cmd, args, session, context);

  console.log("navigation & reading");
  await test("goto + tree + ids + stats", async () => {
    const r = await run("goto", { url: `${base}/calendar?auth=1` }); eq(r.title, "Calendar");
    const t = await run("tree", { stats: true });
    ok(t.text.includes('@') && t.text.includes('button "Schedule meeting"'), "tree has button"); ok(t.estTokens < 400, "tree small: " + t.estTokens); ok(t.nodeCount > 50);
  });
  await test("tree ids are stable across calls, reset on navigation", async () => {
    const a = pick((await run("tree")).text, "button", /Schedule meeting/); const b = pick((await run("tree")).text, "button", /Schedule meeting/); eq(a, b);
    await run("goto", { url: `${base}/settings` }); const t = await run("tree"); ok(t.text.startsWith(`url: ${base}/settings`)); ok(pick(t.text, "button", /^Save$/).startsWith("@"));
  });
  await test("tree -i, filter, find, text, eval", async () => {
    const i = await run("tree", { interactiveOnly: true }); ok(!i.text.includes("\nh1 "), "no headings in -i"); ok(i.text.includes("checkbox"));
    const f = await run("find", { query: "timezone" }); ok(/select "Timezone"/.test(f.text), f.text);
    const tx = await run("text"); ok(tx.text.includes("Settings") && tx.text.includes("Display name"));
    eq((await run("eval", { expression: "1+2" })).value, 3); eq((await run("eval", { expression: "document.title" })).value, "Settings");
    let threw = false; try { await run("eval", { expression: "throw new Error('boom')" }); } catch (e: any) { threw = /boom/.test(e.message); } ok(threw, "eval surfaces exceptions");
  });
  await test("select/date widgets collapse; label text deduped", async () => {
    const t = (await run("tree")).text;
    ok(/@\d+ select "Timezone" ="UTC" [^\n]*\[UTC\|America\/Chicago\|Europe\/Berlin\]/.test(t), "select inline options: " + t);
    ok(!/text "Timezone"/.test(t), "label deduped");
  });

  console.log("actions");
  await test("type/select/check/radio/click -> form saved", async () => {
    const t = (await run("tree")).text;
    await run("type", { ref: pick(t, "textbox", /Display name/), text: "Zed" });
    await run("select", { ref: pick(t, "select", /Timezone/), value: "Berlin" });
    await run("check", { ref: pick(t, "checkbox", /Email/) });
    await run("check", { ref: pick(t, "checkbox", /Dark/) }); await run("check", { ref: pick(t, "checkbox", /Dark/), state: false });
    await run("click", { ref: pick(t, "radio", /Compact/) });
    await run("click", { ref: pick(t, "button", /^Save$/) });
    const w = await run("wait", { text: "Saved:" }); ok(w.found);
    const tx = (await run("text")).text; ok(tx.includes("name=Zed") && tx.includes("tz=Europe/Berlin") && tx.includes("notify=on") && !tx.includes("dark=on") && tx.includes("density=compact"), tx);
  });
  await test("type --keys (per-key events) and clear semantics", async () => {
    const t = (await run("tree")).text; const ref = pick(t, "textbox", /Display name/);
    await run("type", { ref, text: "abc", keys: true }); eq((await run("eval", { expression: "document.querySelector('[name=name]').value" })).value, "abc");
    await run("type", { ref, text: "def", clear: false }); eq((await run("eval", { expression: "document.querySelector('[name=name]').value" })).value, "abcdef");
    await run("type", { ref, text: "x" }); eq((await run("eval", { expression: "document.querySelector('[name=name]').value" })).value, "x");
  });
  await test("click by CSS selector, js click, right/double click", async () => {
    await run("click", { ref: "input[name=dark]" }); eq((await run("eval", { expression: "document.querySelector('[name=dark]').checked" })).value, true);
    await run("click", { ref: "input[name=dark]", js: true }); eq((await run("eval", { expression: "document.querySelector('[name=dark]').checked" })).value, false);
    await run("eval", { expression: "window.__ev=[];document.body.addEventListener('contextmenu',e=>{e.preventDefault();__ev.push('ctx')});document.body.addEventListener('dblclick',()=>__ev.push('dbl'))" });
    const t = (await run("tree")).text; await run("click", { ref: pick(t, "button", /^Save$/), button: "right" }); await run("click", { ref: pick(t, "button", /^Save$/), count: 2 });
    const ev = (await run("eval", { expression: "__ev.join()" })).value; ok(ev.includes("ctx") && ev.includes("dbl"), ev);
  });
  await test("press keys + chords, submit via Enter navigates", async () => {
    await run("goto", { url: `${base}/research` });
    const t = (await run("tree")).text; const q = pick(t, "search", /Search articles/);
    await run("type", { ref: q, text: "cdp" }); await run("press", { key: "Enter", wait: "load" });
    ok((await run("info")).url.includes("q=cdp")); ok((await run("text")).text.includes("results for cdp"));
    const t2 = (await run("tree")).text; await run("type", { ref: pick(t2, "search", /Search/), text: "hello world" });
    await run("press", { key: "cmd+a" }); await run("press", { key: "Backspace" }); eq((await run("eval", { expression: "document.querySelector('[name=q]').value" })).value, "");
    await run("type", { ref: pick(t2, "search", /Search/), text: "ab" }); await run("press", { key: "ArrowLeft" }); await run("press", { key: "Backspace" }); eq((await run("eval", { expression: "document.querySelector('[name=q]').value" })).value, "b");
  });
  await test("click link with wait=load, back/forward/reload, hover/focus/scroll", async () => {
    await run("goto", { url: `${base}/research?q=agents` });
    const t = (await run("tree")).text; const links = t.split("\n").filter((l: string) => /link ".*\(part/.test(l)); ok(links.length >= 2, "result links: " + links.length);
    await run("click", { ref: links[0].match(/@\d+/)![0], wait: "load" });
    const info = await run("info"); ok(/\/article\/\d+/.test(info.url), "after click: " + info.url);
    const id = Number(info.url.split("/").pop()); eq((await run("eval", { expression: "document.getElementById('fact').textContent" })).value, FACT_FOR(id));
    await run("back"); ok((await run("info")).url.includes("research?q=agents"), "after back: " + (await run("info")).url); await run("forward"); ok((await run("info")).url.includes("/article/"), "after forward: " + (await run("info")).url); await run("reload"); ok((await run("info")).url.includes("/article/"), "after reload");
    await run("viewport", { width: 1280, height: 300 });   // make the page taller than the viewport
    await run("scroll", { dy: 400 }); const sy = (await run("eval", { expression: "scrollY" })).value; ok(sy > 0, "scrollY after wheel: " + sy); await run("scroll", { to: "bottom" }); ok((await run("eval", { expression: "scrollY" })).value >= sy, "scrolled to bottom"); await run("scroll", { to: "top" }); eq((await run("eval", { expression: "scrollY" })).value, 0);
    await run("viewport", { width: 1280, height: 800 });
    const t2 = (await run("tree")).text; await run("hover", { ref: pick(t2, "link", /Next article/) }); await run("focus", { ref: pick(t2, "link", /Next article/) }); eq((await run("eval", { expression: "document.activeElement.textContent" })).value, "Next article");
  });
  await test("wait variants: selector, gone, ms, load, timeout error", async () => {
    await run("goto", { url: `${base}/settings` });
    ok((await run("wait", { selector: "#f" })).found); await run("eval", { expression: "setTimeout(()=>document.getElementById('f').remove(),150)" }); ok((await run("wait", { gone: "#f" })).found);
    eq((await run("wait", { ms: 30 })).waited, 30);
    let threw = false; try { await run("wait", { text: "never-appears", timeoutMs: 200 }); } catch { threw = true; } ok(threw, "timeout throws");
  });
  await test("javascript dialogs are auto-dismissed", async () => {
    eq((await run("eval", { expression: "alert('hi'); confirm('x'); 'after'" })).value, "after");
  });
  await test("screenshot png/jpeg/full + viewport", async () => {
    const p = await run("screenshot", {}); ok(p.bytes > 1000 && Buffer.from(p.base64, "base64").subarray(1, 4).toString() === "PNG");
    const j = await run("screenshot", { format: "jpeg", quality: 40 }); ok(j.bytes > 500 && j.bytes < p.bytes);
    await run("viewport", { width: 800, height: 600 }); const dims = (await run("eval", { expression: "[innerWidth,innerHeight]" })).value; eq(dims[0], 800); eq(dims[1], 600);
    await run("viewport", { width: 1280, height: 800 });
    await run("goto", { url: `${base}/article/3` }); const f = await run("screenshot", { fullPage: true }); ok(f.bytes > p.bytes * 0.5);
  });
  await test("click works right after navigation without an explicit tree (auto id map)", async () => {
    await run("goto", { url: `${base}/calendar?auth=1` }); await run("click", { ref: "@10" }); ok((await run("tree", { interactiveOnly: true })).text.includes('button "Save meeting"'));
  });
  await test("errors: unknown node, bad selector, unknown command, bad key", async () => {
    for (const [cmd, args, re] of [["click", { ref: "@9999" }, /unknown node/], ["click", { ref: "#nope" }, /no element/], ["nope", {}, /unknown command/], ["press", { key: "Bogus" }, /unknown key/], ["select", { ref: "@10", value: "x" }, /options|not iterable|no option/]] as const) {
      let msg = ""; try { await run(cmd, args as any); } catch (e: any) { msg = e.message; } ok(re.test(msg), `${cmd}: ${msg}`);
    }
  });

  console.log("sessions, isolation, sharing, concurrency");
  await test("sessions are isolated (cookies) and shared contexts share them", async () => {
    await run("goto", { url: `${base}/settings` }, "iso1"); await run("eval", { expression: "document.cookie='who=iso1;path=/'" }, "iso1");
    await run("goto", { url: `${base}/settings` }, "iso2"); eq((await run("eval", { expression: "document.cookie" }, "iso2")).value, "", "private session sees no cookie");
    await run("goto", { url: `${base}/settings` }, "sh1", "team"); await run("eval", { expression: "document.cookie='who=team;path=/'" }, "sh1", "team");
    await run("goto", { url: `${base}/settings` }, "sh2", "team"); eq((await run("eval", { expression: "document.cookie" }, "sh2", "team")).value, "who=team", "shared context sees cookie");
    const list = await c.run("sessions"); ok(list.find((s: any) => s.name === "sh2").context === "team"); ok(list.find((s: any) => s.name === "iso1").context === null);
    const st = await c.run("status"); ok(st.contexts.includes("team"));
    await c.run("session.close", { name: "sh1" }); ok((await c.run("status")).contexts.includes("team"), "context kept while sh2 alive");
    await c.run("session.close", { name: "sh2" }); ok(!(await c.run("status")).contexts.includes("team"), "context disposed when empty");
  });
  await test("12 sessions in parallel: goto+tree+type all succeed; pool refills", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `par${i}`);
    const t0 = performance.now();
    await Promise.all(names.map(async (n) => { await run("goto", { url: `${base}/settings` }, n); const t = (await run("tree", {}, n)).text; await run("type", { ref: pick(t, "textbox", /Display name/), text: n }, n); eq((await run("eval", { expression: "document.querySelector('[name=name]').value" }, n)).value, n); }));
    const ms = performance.now() - t0; ok(ms < 15000, `took ${ms}ms`);
    const st = await c.run("status"); ok(st.sessions >= 12); await sleep(500); ok((await c.run("status")).pool >= 1, "pool refilled");
    for (const n of names) await c.run("session.close", { name: n });
  });
  await test("per-session command serialization: pipelined goto then tree sees new page", async () => {
    const p1 = c.call("goto", { url: `${base}/research` }, "ser"); const p2 = c.call("tree", {}, "ser");
    const [r1, r2] = await Promise.all([p1, p2]); ok(r1.ok && r2.ok); ok(r2.result.text.startsWith(`url: ${base}/research`), r2.result.text.split("\n")[0]);
  });
  await test("status reports memory footprint, per-type breakdown, latency stats", async () => {
    const st = await c.run("status", { stats: true }); ok(st.memory.chromiumFootprintMB > 0 || process.platform !== "darwin"); ok(st.memory.byType.renderer?.n >= 1); ok(st.latencyMs.goto.n > 0 && st.latencyMs.goto.p50 > 0); ok(st.engine === "headless-shell" || st.engine === "chrome"); ok(st.sessionCreateMs.n > 0);
  });

  console.log("cli");
  await test("cli: single commands, --json, -s, batch, repl/stdin, exit codes", async () => {
    ok((await cli("-s", "cli1", "goto", `${base}/settings`)).startsWith("ok "));
    const tree = await cli("-s", "cli1", "tree", "-i"); ok(tree.includes('select "Timezone"'));
    const j = JSON.parse(await cli("-s", "cli1", "--json", "eval", "2*21")); eq(j.result.value, 42); eq(j.ok, true);
    const b = await cli("-s", "cli2", "batch", `goto ${base}/research`, "tree -i", 'type @6 "hello there"', "eval document.querySelector('[name=q]').value"); ok(b.includes("hello there"), b);
    const r = await cliStdin(`goto ${base}/settings\n# comment\ntree -i --filter Save\neval 1+1\n`, "-s", "cli3", "repl"); ok(r.out.includes('button "Save"') && r.out.includes("\n2"), r.out); eq(r.code, 0);
    const bad = await cliStdin("", "-s", "cli1", "click", "@9999"); eq(bad.code, 1, "non-zero exit on error"); ok(bad.out.includes("error: unknown node"));
    ok((await cli("sessions")).includes("cli1")); ok((await cli("--help")).includes("screencast"));
  });
  await test("cli: screenshot -o writes a file", async () => {
    const out = join(home, "shot.png"); await cli("-s", "cli1", "screenshot", "-o", out); ok(statSync(out).size > 1000);
  });

  console.log("human mirror & devtools");
  await test("screencast: frames stream over SSE, input passthrough, release unblocks wait", async () => {
    await run("goto", { url: `${base}/settings` }, "mir");
    const r = await c.run("screencast", { port: 0 }, "mir"); ok(/^http:\/\/127\.0\.0\.1:\d+\/view\?s=mir$/.test(r.url), r.url);
    const origin = new URL(r.url).origin;
    const idx = await (await fetch(origin + "/")).text(); ok(idx.includes("mir")); const view = await (await fetch(r.url)).text(); ok(view.includes("EventSource"));
    const ac = new AbortController(); const res = await fetch(`${origin}/frames?s=mir`, { signal: ac.signal }); eq(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ""; const t0 = Date.now();
    while (!buf.includes("\n\n") && Date.now() - t0 < 8000) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
    const frame = JSON.parse(buf.split("data: ")[1].split("\n\n")[0]); ok(frame.f.length > 1000 && frame.m.deviceWidth > 0, "got a jpeg frame with metadata");
    ok((await run("info", {}, "mir")).screencast === true);
    // human clicks the "Dark mode" checkbox via the mirror input API
    const box = (await run("eval", { expression: "(r=>[r.x+r.width/2,r.y+r.height/2])(document.querySelector('[name=dark]').getBoundingClientRect())" }, "mir")).value;
    await fetch(`${origin}/input?s=mir`, { method: "POST", body: JSON.stringify([{ kind: "mouse", type: "mousePressed", x: box[0], y: box[1], button: "left", clickCount: 1 }, { kind: "mouse", type: "mouseReleased", x: box[0], y: box[1], button: "left", clickCount: 1 }]) });
    eq((await run("eval", { expression: "document.querySelector('[name=dark]').checked" }, "mir")).value, true, "human click landed");
    await fetch(`${origin}/input?s=mir`, { method: "POST", body: JSON.stringify([{ kind: "key", type: "keyDown", key: "Tab", code: "Tab", keyCode: 9 }, { kind: "key", type: "keyUp", key: "Tab", code: "Tab", keyCode: 9 }]) });
    const waiting = c.call("wait", { release: true }, "mir"); await sleep(100); await fetch(`${origin}/release?s=mir`, { method: "POST" }); ok((await waiting).result.released, "release resolved wait");
    ac.abort(); await sleep(300); ok((await run("info", {}, "mir")).screencast === false, "screencast stops when last viewer leaves");
    const d = await c.run("devtools", {}, "mir"); ok(d.url.includes("/devtools/inspector.html?ws=")); const list = await (await fetch(`http://127.0.0.1:${(await c.run("status")).cdpPort}/json`)).json(); ok(list.some((t: any) => t.url.includes("/settings")));
  });

  console.log("mcp");
  await test("mcp server: initialize, tools/list, tools/call round trip", async () => {
    const p = spawn(process.execPath, [join(ROOT, "dist", "mcp.js")], { env: { ...process.env, CHROME_AGENT_HOME: home, CHROME_AGENT_SOCK: sock } });
    let out = ""; p.stdout.on("data", (d) => (out += d));
    const send = (m: any) => p.stdin.write(JSON.stringify(m) + "\n");
    const waitId = async (id: number) => { const t0 = Date.now(); while (Date.now() - t0 < 10000) { const line = out.split("\n").find((l) => l.includes(`"id":${id}`)); if (line) return JSON.parse(line); await sleep(20); } throw new Error("mcp timeout " + id); };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }); ok((await waitId(1)).result.serverInfo.name === "chrome-agent");
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" }); const tl = await waitId(2); ok(tl.result.tools.length >= 15 && tl.result.tools.some((t: any) => t.name === "browser_tree"));
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_goto", arguments: { url: `${base}/settings`, session: "mcp1" } } }); ok((await waitId(3)).result.content[0].text.includes("Settings"));
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_tree", arguments: { session: "mcp1", interactiveOnly: true } } }); const tr = (await waitId(4)).result.content[0].text; ok(tr.includes('button "Save"'));
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "browser_type", arguments: { session: "mcp1", ref: pick(tr, "textbox", /Display name/), text: "via mcp" } } }); ok((await waitId(5)).result.content[0].text.includes("typed"));
    send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "browser_screenshot", arguments: { session: "mcp1" } } }); eq((await waitId(6)).result.content[0].type, "image");
    send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_click", arguments: { session: "mcp1", ref: "@9999" } } }); ok((await waitId(7)).result.isError === true);
    p.stdin.end(); await sleep(100); p.kill();
  });

  console.log("shutdown");
  await test("daemon stop cleans socket, info, temp profile and kills chromium", async () => {
    const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    await c.call("stop"); await sleep(1500);
    ok(!existsSync(sock), "socket removed"); ok(!existsSync(join(home, "daemon.json")), "info removed"); ok(!existsSync(info.userDataDir), "profile dir removed");
    let alive = true; try { process.kill(info.chromePid, 0); } catch { alive = false; } ok(!alive, "chromium killed");
  });

  site.close();
  console.log(`\n${pass} passed, ${fail} failed${fail ? ": " + failures.join(", ") : ""}`);
  process.exit(fail);
}
main().catch((e) => { console.error(e); process.exit(99); });
