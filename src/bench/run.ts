/**
 * Multi-agent benchmark.
 *   node dist/bench/run.js [--agents 6] [--iterations 3] [--compare-instances] [--out bench/results/x.json]
 *
 * N scripted agents run realistic workflows concurrently against the local test
 * site through the daemon (calendar: login + schedule a meeting; research: search,
 * open results, extract a fact, go back; settings: fill a form and save).
 * Every agent step is observe -> act, exactly as an LLM agent would run it.
 *
 * Two observation modes are timed and token-counted:
 *   tree        observe with `tree` (what chrome-agent gives an LLM)
 *   screenshot  observe with a 1280x800 screenshot (what computer-use gives an LLM);
 *               the scripted agent still reads the tree to decide, but only the screenshot is counted.
 * Memory is sampled every 400ms (macOS phys_footprint; RSS shown for reference).
 * --compare-instances also launches N separate browsers (one per agent) to measure the naive layout.
 */
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestSite, FACT_FOR } from "../test-site/server.js";
import { DaemonClient, startDaemon } from "../protocol.js";
import { launch, findChromium } from "../launcher.js";
import { processTreeMemory } from "../memory.js";
import { screenshotTokens } from "../tree.js";
import { CdpClient } from "../cdp.js";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const AGENTS = Number(opt("--agents", "6"));
const ITER = Number(opt("--iterations", "3"));
const MODES = (opt("--modes", "tree,screenshot").split(",")) as ("tree" | "screenshot")[];
const COMPARE = argv.includes("--compare-instances");
const ENGINE = opt("--engine", "auto");   // auto | shell | chrome
const W = 1280, H = 800;

interface Step { agent: string; workflow: string; cmd: string; ms: number; clientMs: number; obsTokens?: number; obsBytes?: number }
type Obs = (s: Agent) => Promise<{ text: string; tokens: number }>;

class Agent {
  steps: Step[] = []; failures: string[] = []; done = 0;
  constructor(public name: string, public workflow: string, public client: DaemonClient, public base: string, public observe: Obs) {}
  async run(cmd: string, args: Record<string, any> = {}): Promise<any> {
    const t0 = performance.now();
    const r = await this.client.call(cmd, args, this.name);
    const clientMs = performance.now() - t0;
    this.steps.push({ agent: this.name, workflow: this.workflow, cmd, ms: r.ms, clientMs: +clientMs.toFixed(2) });
    if (!r.ok) throw new Error(`${cmd} ${JSON.stringify(args)}: ${r.error}`);
    return r.result;
  }
  /** observe = the thing an LLM would read before deciding the next action */
  async look(): Promise<string> {
    const o = await this.observe(this);
    this.steps[this.steps.length - 1].obsTokens = o.tokens;
    return o.text;
  }
  assert(cond: boolean, msg: string) { if (!cond) this.failures.push(`${this.workflow}: ${msg}`); }
}

/** Find "@N" for the first tree line matching role + name regex. */
function pick(tree: string, role: string, name: RegExp): string {
  for (const line of tree.split("\n")) {
    const m = line.match(/^\s*(@\d+) (\S+) "([^"]*)"/);
    if (m && m[2] === role && name.test(m[3])) return m[1];
  }
  throw new Error(`no ${role} matching ${name} in tree:\n${tree}`);
}

// ---------------------------------------------------------------- observation modes
const observeTree: Obs = async (a) => { const r = await a.run("tree", { interactiveOnly: false }); return { text: r.text, tokens: r.estTokens }; };
const observeScreenshot: Obs = async (a) => {
  const shot = await a.run("screenshot", { format: "png" });
  a.steps[a.steps.length - 1].obsBytes = shot.bytes;
  const t = await a.run("tree", {});                      // scripted stand-in for the vision model's understanding; not counted
  a.steps.pop();
  return { text: t.text, tokens: screenshotTokens(W, H) };
};

// ---------------------------------------------------------------- workflows
async function calendar(a: Agent, i: number) {
  await a.run("goto", { url: `${a.base}/calendar` });
  let t = await a.look();
  a.assert(t.includes("Sign in required"), "gate page shown");
  await a.run("click", { ref: pick(t, "link", /Go to sign in/), wait: "load" });
  t = await a.look();
  await a.run("type", { ref: pick(t, "textbox", /Email/), text: `${a.name}@example.com` });
  await a.run("type", { ref: pick(t, "textbox", /Password/), text: "hunter2" });
  await a.run("check", { ref: pick(t, "checkbox", /Remember/) });
  await a.run("click", { ref: pick(t, "button", /Sign in/), wait: "load" });
  t = await a.look();
  a.assert(t.includes(`Signed in as ${a.name}@example.com`), "logged in");
  await a.run("click", { ref: pick(t, "button", /Schedule meeting/) });
  t = await a.look();
  const title = `Sync ${a.name} #${i}`;
  await a.run("type", { ref: pick(t, "textbox", /Title/), text: title });
  await a.run("select", { ref: pick(t, "select", /Time/), value: "14:00" });
  await a.run("type", { ref: pick(t, "textbox", /Attendees/), text: "a@x.com, b@x.com, c@x.com" });
  await a.run("click", { ref: pick(t, "button", /Save meeting/) });
  await a.run("wait", { text: `Scheduled: ${title}` });
  t = await a.look();
  a.assert(t.includes(`Scheduled: ${title} on 2026-09-10 at 14:00`), "meeting scheduled");
}

async function research(a: Agent, i: number) {
  const q = ["cdp", "token", "agents", "perf"][i % 4];
  await a.run("goto", { url: `${a.base}/research` });
  let t = await a.look();
  await a.run("type", { ref: pick(t, "search", /Search articles/), text: q, submit: true });
  await a.run("wait", { text: "results for" });
  t = await a.look();
  a.assert(/\d+ results for/.test(t), "results shown");
  for (const n of [0, 1]) {
    const links = t.split("\n").filter((l) => /^\s*@\d+ link ".*\(part \d\)"/.test(l));
    a.assert(links.length > n, `result ${n} exists`);
    const ref = links[n].match(/@\d+/)![0];
    await a.run("click", { ref, wait: "load" });
    t = await a.look();
    const id = Number((await a.run("eval", { expression: "location.pathname.split('/').pop()" })).value);
    const fact = (await a.run("eval", { expression: "document.getElementById('fact').textContent" })).value;
    a.assert(fact === FACT_FOR(id), `fact for article ${id}`);
    a.assert(t.includes("Key fact"), "article rendered in tree");
    await a.run("back", {});
    t = await a.look();
  }
}

async function settings(a: Agent, i: number) {
  await a.run("goto", { url: `${a.base}/settings` });
  let t = await a.look();
  await a.run("type", { ref: pick(t, "textbox", /Display name/), text: `Agent ${a.name} ${i}` });
  await a.run("select", { ref: pick(t, "select", /Timezone/), value: "Europe/Berlin" });
  await a.run("check", { ref: pick(t, "checkbox", /Email notifications/) });
  await a.run("click", { ref: pick(t, "radio", /Compact/) });
  await a.run("click", { ref: pick(t, "button", /^Save$/) });
  await a.run("wait", { text: "Saved:" });
  t = await a.look();
  a.assert(t.includes("tz=Europe/Berlin") && t.includes("notify=on") && t.includes("density=compact"), "settings saved");
}
const WORKFLOWS: Record<string, (a: Agent, i: number) => Promise<void>> = { calendar, research, settings };

// ---------------------------------------------------------------- stats helpers
const pct = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2); };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const site = await startTestSite(0);
  const base = `http://127.0.0.1:${site.port}`;
  const home = mkdtempSync(join(tmpdir(), "chrome-agent-bench-"));
  process.env.CHROME_AGENT_HOME = home; process.env.CHROME_AGENT_SOCK = join(home, "daemon.sock");
  const sock = join(home, "daemon.sock");
  const daemonArgs = ["--pool", "2"];
  if (ENGINE === "chrome") daemonArgs.push("--exe", findChromium({ headed: true }).path);   // headed:true => skip the shell, pick full Chrome
  if (ENGINE === "shell") { const f = findChromium(); if (f.engine !== "headless-shell") throw new Error("chrome-headless-shell not installed; run `chrome-agent install`"); }
  await startDaemon(daemonArgs);
  let client: DaemonClient | null = null;
  for (let i = 0; i < 400 && !client; i++) { client = await DaemonClient.connect(sock, false).catch(() => null); if (!client) await sleep(50); }
  if (!client) throw new Error("daemon failed to start; see " + join(home, "daemon.log"));
  await sleep(1200); // let the pool warm
  const st0 = await client.run("status");
  const chromePid = st0.chromePid as number;
  const baseline = processTreeMemory(chromePid);
  const poolAtBaseline = st0.pool as number;
  console.log(`engine=${st0.engine} chrome pid=${chromePid} baseline footprint=${baseline.footprintMB}MB rss=${baseline.rssMB}MB procs=${baseline.processes} (daemon idle, pool=${poolAtBaseline})`);

  const results: any = { date: new Date().toISOString(), engine: st0.engine, executablePath: st0.executablePath, agents: AGENTS, iterations: ITER, viewport: [W, H], baseline, modes: {}, platform: `${process.platform} ${process.arch} node ${process.version}` };

  for (const mode of MODES) {
    console.log(`\n=== mode: ${mode} — ${AGENTS} agents × ${ITER} iterations ===`);
    const observe = mode === "tree" ? observeTree : observeScreenshot;
    const agents = Array.from({ length: AGENTS }, (_, i) => new Agent(`${mode}-agent${i}`, Object.keys(WORKFLOWS)[i % 3], client!, base, observe));
    // memory sampler
    const samples: { t: number; footprintMB: number | null; rssMB: number; procs: number }[] = [];
    let sampling = true;
    const sampler = (async () => { while (sampling) { const m = processTreeMemory(chromePid); samples.push({ t: Date.now(), footprintMB: m.footprintMB, rssMB: m.rssMB, procs: m.processes }); await sleep(400); } })();
    const t0 = performance.now();
    const createMs: number[] = [];
    await Promise.all(agents.map(async (a) => {
      const c0 = performance.now(); await a.run("session.new", {}); createMs.push(+(performance.now() - c0).toFixed(2));
      for (let i = 0; i < ITER; i++) { try { await WORKFLOWS[a.workflow](a, i); a.done++; } catch (e: any) { a.failures.push(`${a.workflow}#${i}: ${e.message.split("\n")[0]}`); } }
    }));
    const wallMs = performance.now() - t0;
    const settled = processTreeMemory(chromePid);
    const stEnd = await client!.run("status");
    const pagesAdded = (stEnd.sessions as number) + (stEnd.pool as number) - poolAtBaseline;   // pool refills, so more pages than agents are open
    const perPage = settled.footprintMB && baseline.footprintMB ? +((settled.footprintMB - baseline.footprintMB) / Math.max(1, pagesAdded)).toFixed(1) : null;
    sampling = false; await sampler;
    const steps = agents.flatMap((a) => a.steps);
    const obs = steps.filter((s) => s.obsTokens !== undefined);
    const byCmd: Record<string, { n: number; p50: number; p95: number; max: number; mean: number }> = {};
    for (const cmd of [...new Set(steps.map((s) => s.cmd))]) { const xs = steps.filter((s) => s.cmd === cmd).map((s) => s.ms); byCmd[cmd] = { n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1), mean: +(sum(xs) / xs.length).toFixed(2) }; }
    const allMs = steps.map((s) => s.ms), allClient = steps.map((s) => s.clientMs);
    const peak = samples.reduce((m, s) => Math.max(m, s.footprintMB ?? 0), 0);
    const peakRss = samples.reduce((m, s) => Math.max(m, s.rssMB), 0);
    const failures = agents.flatMap((a) => a.failures);
    const r = {
      wallMs: +wallMs.toFixed(0), actions: steps.length, actionsPerSec: +(steps.length / (wallMs / 1000)).toFixed(1),
      latency: { p50: pct(allMs, 0.5), p95: pct(allMs, 0.95), p99: pct(allMs, 0.99), max: pct(allMs, 1), mean: +(sum(allMs) / allMs.length).toFixed(2), clientP50: pct(allClient, 0.5), clientP95: pct(allClient, 0.95) },
      byCmd, sessionCreateMs: { p50: pct(createMs, 0.5), max: pct(createMs, 1), all: createMs },
      observations: obs.length, obsTokens: sum(obs.map((s) => s.obsTokens!)), obsTokensPerStep: +(sum(obs.map((s) => s.obsTokens!)) / obs.length).toFixed(1),
      screenshotBytes: mode === "screenshot" ? sum(obs.map((s) => s.obsBytes ?? 0)) : undefined,
      memory: { baselineFootprintMB: baseline.footprintMB, peakFootprintMB: peak, settledFootprintMB: settled.footprintMB, peakRssMB: peakRss, pagesOpenAtEnd: (stEnd.sessions as number) + (stEnd.pool as number), perSessionFootprintMB: perPage, daemonForNAgentsMB: perPage !== null && baseline.footprintMB ? +(baseline.footprintMB + perPage * AGENTS).toFixed(1) : null, procsPeak: Math.max(...samples.map((s) => s.procs)), byType: settled.byType, samples },
      workflowsCompleted: sum(agents.map((a) => a.done)), workflowsFailed: failures.length, failures,
    };
    results.modes[mode] = r;
    console.log(`wall ${r.wallMs}ms | ${r.actions} actions | ${r.actionsPerSec} actions/s across ${AGENTS} agents | workflows ok ${r.workflowsCompleted}/${AGENTS * ITER}${failures.length ? " FAILURES: " + failures.join(" ; ") : ""}`);
    console.log(`latency (daemon-side) p50 ${r.latency.p50}ms p95 ${r.latency.p95}ms p99 ${r.latency.p99}ms max ${r.latency.max}ms | client round-trip p50 ${r.latency.clientP50}ms`);
    console.log(`session create p50 ${r.sessionCreateMs.p50}ms max ${r.sessionCreateMs.max}ms`);
    console.log(`observations ${r.observations} | tokens/observation ${r.obsTokensPerStep} | total observation tokens ${r.obsTokens}`);
    console.log(`memory footprint: baseline ${baseline.footprintMB}MB -> peak ${peak}MB, settled ${settled.footprintMB}MB with ${r.memory.pagesOpenAtEnd} pages open => ${perPage}MB per session (RSS peak ${peakRss}MB, procs peak ${r.memory.procsPeak})`);
    console.log("per-command: " + Object.entries(byCmd).map(([k, v]) => `${k} p50=${v.p50} p95=${v.p95} (n=${v.n})`).join(" | "));
    await client.run("session.closeAll");
    await sleep(500);
  }

  if (results.modes.tree && results.modes.screenshot) {
    const t = results.modes.tree, s = results.modes.screenshot;
    results.comparison = { tokenSavingsPct: +((1 - t.obsTokens / s.obsTokens) * 100).toFixed(1), tokensPerStepTree: t.obsTokensPerStep, tokensPerStepScreenshot: s.obsTokensPerStep, obsLatencyTreeP50: t.byCmd.tree?.p50, obsLatencyScreenshotP50: s.byCmd.screenshot?.p50, wallTree: t.wallMs, wallScreenshot: s.wallMs };
    console.log(`\n=== tree vs screenshot ===\ntokens/observation: ${t.obsTokensPerStep} vs ${s.obsTokensPerStep}  => ${results.comparison.tokenSavingsPct}% fewer input tokens per step\nobserve latency p50: tree ${t.byCmd.tree?.p50}ms vs screenshot ${s.byCmd.screenshot?.p50}ms (capture only; vision inference not included)`);
  }

  if (COMPARE) {
    console.log(`\n=== naive layout: ${AGENTS} separate browser processes (one per agent) ===`);
    const browsers = [] as Awaited<ReturnType<typeof launch>>[];
    const t0 = performance.now();
    for (let i = 0; i < AGENTS; i++) {
      const b = await launch({ executablePath: st0.executablePath, windowSize: [W, H] }); browsers.push(b);
      const cdp = await CdpClient.connect(b.wsUrl);
      const { targetInfos } = await cdp.send("Target.getTargets");
      const page = targetInfos.find((t: any) => t.type === "page");
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      await cdp.send("Page.enable", {}, sessionId);
      const load = cdp.waitFor("Page.loadEventFired", { sessionId, timeoutMs: 10000 });
      await cdp.send("Page.navigate", { url: `${base}/calendar?auth=1` }, sessionId); await load;
      (b as any).cdp = cdp;
    }
    const launchMs = performance.now() - t0;
    await sleep(1500);
    const mems = browsers.map((b) => processTreeMemory(b.pid));
    const total = +sum(mems.map((m) => m.footprintMB ?? 0)).toFixed(1);
    const m0 = results.modes.tree?.memory ?? results.modes.screenshot?.memory;
    const daemonN = m0.daemonForNAgentsMB as number;
    results.separateInstances = { count: AGENTS, totalFootprintMB: total, perBrowserMB: +(total / AGENTS).toFixed(1), totalProcesses: sum(mems.map((m) => m.processes)), launchMsTotal: +launchMs.toFixed(0), perBrowserLaunchMs: +(launchMs / AGENTS).toFixed(0), daemonForNAgentsMB: daemonN, daemonProcesses: m0.procsPeak };
    console.log(`${AGENTS} browsers: ${total}MB footprint total (${results.separateInstances.perBrowserMB}MB each, ${results.separateInstances.totalProcesses} processes), launched in ${launchMs.toFixed(0)}ms (${results.separateInstances.perBrowserLaunchMs}ms each)\nshared daemon for ${AGENTS} agents: ${daemonN}MB (${m0.baselineFootprintMB}MB idle + ${AGENTS} × ${m0.perSessionFootprintMB}MB), ${m0.procsPeak} processes  => ${(total / daemonN).toFixed(2)}x memory, ${(results.separateInstances.totalProcesses / m0.procsPeak).toFixed(1)}x processes with separate browsers`);
    for (const b of browsers) { try { await (b as any).cdp.send("Browser.close"); } catch {} b.proc.kill("SIGKILL"); }
  }

  await client.run("stop"); client.close(); site.close();
  const out = opt("--out", `bench/results/bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
