/**
 * Launch a single headless Chromium daemon process with flags tuned for
 * agent workloads: no GPU, no animations, no images (optional), no background
 * services, no extensions, no first-run UI. One process tree serves every agent.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Engine = "headless-shell" | "chrome";
/** Where `chrome-agent install` puts engines. Always the user-level dir so temp homes (tests, benchmarks) still find it. */
export const BROWSERS_DIR = join(homedir(), ".chrome-agent", "browsers");

export interface LaunchOptions {
  executablePath?: string;
  headless?: boolean;          // default true
  images?: boolean;            // default false (huge memory + bandwidth savings)
  userDataDir?: string;        // default: fresh tmp dir (ephemeral, no disk bloat)
  extraArgs?: string[];
  windowSize?: [number, number];
}

export interface LaunchedBrowser {
  proc: ChildProcess;
  wsUrl: string;
  port: number;
  userDataDir: string;
  pid: number;
  engine: Engine;
  executablePath: string;
}

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROMIUM_PATH,
  // Prefer open-source Chromium builds when present, then Chrome/Canary/Brave/Edge.
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
].filter(Boolean) as string[];

/** Expand <root>/chrome-headless-shell/<ver>/chrome-headless-shell-<platform>/chrome-headless-shell(.exe) */
function shellsUnder(root: string): string[] {
  const out: string[] = [];
  try {
    const base = join(root, "chrome-headless-shell");
    for (const ver of readdirSync(base).sort().reverse()) {
      const vdir = join(base, ver);
      for (const plat of readdirSync(vdir)) {
        for (const bin of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
          const p = join(vdir, plat, bin); if (existsSync(p)) out.push(p);
        }
      }
    }
  } catch {}
  return out;
}

/**
 * Engine selection. `chrome-headless-shell` (Chromium's dedicated headless build,
 * no browser UI, no per-window WebUI renderer) is ~4x leaner per isolated
 * session and ~3x faster to spawn a session than full Chrome in --headless=new,
 * so it is preferred whenever installed (`chrome-agent install`). Full Chrome is
 * used for --headed (a real 1:1 window) or when the shell is absent.
 */
export function findChromium(opts: { headed?: boolean } = {}): { path: string; engine: Engine } {
  if (!opts.headed) {
    const roots = [process.env.CHROME_AGENT_HOME && join(process.env.CHROME_AGENT_HOME, "browsers"), BROWSERS_DIR, join(homedir(), ".cache", "puppeteer")].filter(Boolean) as string[];
    const shells = [process.env.CHROME_HEADLESS_SHELL_PATH, ...roots.flatMap(shellsUnder)].filter(Boolean) as string[];
    for (const p of shells) if (existsSync(p)) return { path: p, engine: "headless-shell" };
  }
  for (const p of CANDIDATES) if (existsSync(p)) return { path: p, engine: "chrome" };
  throw new Error("No Chromium/Chrome binary found. Run `chrome-agent install` or set CHROME_PATH=/path/to/chromium");
}

/** The flag set. Documented in docs/ARCHITECTURE.md; keep the two in sync. */
export function buildArgs(o: LaunchOptions, userDataDir: string, engine: Engine = "chrome"): string[] {
  const [w, h] = o.windowSize ?? [1280, 800];
  const args = [
    // ---- protocol ----
    "--remote-debugging-port=0",            // OS picks a free port; we parse it from stderr
    "--remote-allow-origins=*",             // allow our WS client + human devtools/mirror clients
    `--user-data-dir=${userDataDir}`,
    // ---- rendering: strip everything not needed for DOM/AX correctness ----
    // headless-shell is headless by construction; full Chrome needs the new headless mode.
    ...(o.headless === false || engine === "headless-shell" ? [] : ["--headless=new"]),
    // NOTE: no --disable-gpu. Measured on Chrome 152/macOS: with it, every new
    // renderer takes ~600ms to become ready; without it ~120ms. New headless
    // already renders in software; the flag only adds a GPU-fallback dance.
    "--hide-scrollbars",
    "--mute-audio",
    "--force-color-profile=srgb",
    "--disable-font-subpixel-positioning",
    "--disable-lcd-text",
    "--animation-duration-scale=0",         // CSS/Web animations complete instantly
    "--disable-smooth-scrolling",           // wheel/keyboard scrolls land immediately (agents read scrollY right after)
    ...(o.images ? [] : ["--blink-settings=imagesEnabled=false"]),
    `--window-size=${w},${h}`,
    // ---- process model: fewer processes, shared per site ----
    "--process-per-site",
    "--renderer-process-limit=8",
    "--disable-site-isolation-trials",
    "--disable-dev-shm-usage",
        // ---- kill background work ----
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-ipc-flooding-protection",
    "--disable-hang-monitor",
    "--disable-prompt-on-repost",
    "--disable-client-side-phishing-detection",
    "--disable-popup-blocking",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-notifications",
    "--disable-infobars",
    "--disable-search-engine-choice-screen",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,HttpsUpgrades,PaintHolding,BackForwardCache",
    "--enable-features=NetworkServiceInMemoryCache",
    // ---- JS heap cap per renderer keeps a runaway page from eating the box ----
    "--js-flags=--max-old-space-size=256",
    ...(o.extraArgs ?? []),
    "about:blank",
  ];
  return args;
}

export async function launch(o: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const found = o.executablePath ? { path: o.executablePath, engine: (/headless-shell/.test(o.executablePath) ? "headless-shell" : "chrome") as Engine } : findChromium({ headed: o.headless === false });
  const exe = found.path;
  const userDataDir = o.userDataDir ?? mkdtempSync(join(tmpdir(), "chrome-agent-"));
  const args = buildArgs(o, userDataDir, found.engine);
  const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], detached: false });

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report DevTools endpoint in 20s\n" + buf)), 20000);
    proc.stderr!.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); proc.stderr!.removeAllListeners("data"); proc.stderr!.resume(); }
    });
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early (code ${code})\n${buf}`)); });
  });
  const port = Number(new URL(wsUrl).port);
  return { proc, wsUrl, port, userDataDir, pid: proc.pid!, engine: found.engine, executablePath: exe };
}
