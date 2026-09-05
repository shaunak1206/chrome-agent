# chrome-agent

**A Chrome CLI for AI agents.** One shared headless Chromium daemon, isolated
sessions per agent, millisecond commands over raw CDP, and a compact text view
of the page instead of screenshots — with a 1:1 live mirror for humans whenever
you want to watch or take over.

```
$ chrome-agent goto https://cal.example/
$ chrome-agent tree -i
url: https://cal.example/ "Calendar"
@10 button "Schedule meeting"
@14 search "Search events"
@20 select "Time" ="09:00" [09:00|10:00|11:00|14:00|15:00]
@23 checkbox "Add video call" checked
$ chrome-agent click @10
ok {"clicked":"@10","role":"button","name":"Schedule meeting"} (9.5ms)
$ chrome-agent type @18 "Design sync"
$ chrome-agent screencast --open        # a human watches the same page live, can take over, hands back
```

Zero runtime dependencies (Node ≥ 22). TypeScript. MIT. Status: **working prototype, measured on one machine, not yet evaluated with an LLM in the loop** — see [Weaknesses](#weaknesses-and-known-limitations).

---

## Contents

1. [Why](#why)
2. [Install](#install)
3. [Commands](#commands)
4. [For LLM agents](#for-llm-agents)
5. [Human mirror](#human-mirror)
6. [Architecture in one screen](#architecture-in-one-screen)
7. [Benchmark results](#benchmark-results)
8. [Comparison with computer use](#comparison-with-computer-use)
9. [Weaknesses and known limitations](#weaknesses-and-known-limitations)
10. [Areas for improvement (roadmap)](#areas-for-improvement-roadmap)
11. [Benchmarks I recommend running](#benchmarks-i-recommend-running)
12. [Tests](#tests)
13. [Layout](#layout)

---

## Why

Screenshot-driven "computer use" costs ~1,400 input tokens per step just to look, adds a
vision inference round trip per action, and scales badly when every agent gets its own
multi-hundred-MB browser. `chrome-agent` treats the browser like a Unix tool:

| | Screenshot loop | chrome-agent |
|---|---|---|
| Observe cost | 1,366 tokens (1280×800) | **~250 tokens** (accessibility tree, pruned) — 82% less |
| Observe latency | ~60 ms capture **+ vision inference** | **4–9 ms** (`tree`) |
| Act | model outputs pixel coordinates | `click @14` on a stable node id, real mouse/keyboard events |
| Per-agent browser | 280–320 MB, ~900 ms to launch | **~53 MB session, ~0.2 ms** from the warm pool (≈100 ms cold) |
| Human in the loop | separate screenshots | live 1:1 mirror + takeover + `wait --release` handoff |

## Install

```bash
git clone https://github.com/shaunak1206/chrome-agent && cd chrome-agent
npm install && npm run build
node bin/chrome-agent.js install      # fetches chrome-headless-shell (~150 MB) into ~/.chrome-agent/browsers
```

Any Chrome/Chromium works out of the box (auto-detected, or `CHROME_PATH=…`), but
`chrome-headless-shell` is ~4× leaner per session and 3× faster to spawn one — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#engine-choice-why-chrome-headless-shell-is-the-default).

Put `bin/chrome-agent.js` on your PATH (`npm link`, or `alias chrome-agent="node $PWD/bin/chrome-agent.js"`).
Tested on macOS arm64 with Chrome 152. Linux should work (untested, see weaknesses); Windows is not supported yet.

## Commands

```
chrome-agent [-s <session>] [-c <context>] [--json] <command> [args] [flags]

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
 humans       screencast [--port N] [--stop] [--open]    1:1 live mirror + human takeover in a browser tab
              devtools [--open]                          Chrome DevTools attached to this session
 sessions     sessions | new | close [name] | close --all
 daemon       status [--stats] | daemon start [--headed] [--images] [--pool N] | daemon stop | ping
              install                install chrome-headless-shell (lean engine)
```

- **Sessions** (`-s agent7`): one page with private cookies/storage per agent, auto-created on first use.
- **Shared contexts** (`-c team`): sessions that share cookies, storage and renderer processes — for agents collaborating inside one login, or maximum density (~30 MB per extra page).
- **Ids** (`@14`) are stable until navigation; a `click` right after `goto` (or after a dialog opens) rebuilds the map silently.
- The daemon auto-starts on the first command and lives in `~/.chrome-agent/` (`CHROME_AGENT_HOME` to relocate).

## For LLM agents

- **Shell tool**: paste [docs/AGENT_PROMPT.md](docs/AGENT_PROMPT.md) into the system prompt.
- **MCP**: `claude mcp add chrome-agent -- node /path/to/chrome-agent/dist/mcp.js` — 17 tools (`browser_goto`, `browser_tree`, `browser_click`, …), each taking an optional `session`/`context`.
- **In-process (TypeScript)**: `DaemonClient` in `src/protocol.ts` — `await client.run("click", { ref: "@14" }, "agent7")`.

## Human mirror

```bash
chrome-agent -s agent7 screencast --open     # opens http://127.0.0.1:9333/view?s=agent7
chrome-agent -s agent7 wait --release        # agent blocks until the human clicks "release to agent"
```
The mirror streams `Page.screencast` JPEG frames over SSE into a canvas and forwards the
human's mouse/keyboard back into the same session over CDP `Input.*`, so a human can finish a
CAPTCHA or 2FA in the agent's own page and hand it back. Nothing is rendered until someone is
watching; when the last viewer leaves, the screencast stops. `devtools` gives full Chrome
DevTools on the session; `daemon start --headed` runs real windows if you want them.

## Architecture in one screen

```
 agent A ──┐  CLI / MCP / DaemonClient   (JSON lines over a Unix socket)
 agent B ──┼──────────────────────────►  daemon (node) ──► one CDP WebSocket ──► Chromium (headless-shell)
 agent C ──┘   -s <session> -c <context>    │  warm pool, per-session queues       ├─ browser + network + GPU (shared)
 human  ◄──── mirror: SSE frames + input ───┘  latency/memory stats                └─ renderer per site per context
```
Full detail — process model, every command's CDP mapping, the measured flag set, the tree
formatter rules — in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Two findings worth repeating:

- **`--disable-gpu` is harmful** in new headless mode on Chrome 152: renderer spawn goes from ~120 ms to ~600 ms and renderer memory doubles. It is deliberately absent.
- **Full Chrome `--headless=new` is heavy per context**: each isolated context gets a window, a top-chrome WebUI renderer (~58 MB) and GPU surfaces. `chrome-headless-shell` has none of that.

## Benchmark results

Machine: M-series Mac, 8 GB, macOS, Chrome 152 / chrome-headless-shell 152, Node 22. Command:
`npm run bench -- --compare-instances` (and `--engine chrome`). 6 concurrent scripted agents × 3
iterations each of realistic workflows against a local mock site (login + schedule a meeting;
search, open two articles, verify a fact, go back; fill and save a settings form), asserting on
outcomes. 264 actions per run, 18/18 workflows passing. Raw JSON: [`bench/results/`](bench/results/).
Method: [docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-benchmark-method).

**Tokens & latency** (identical on both engines, since only the observation differs):

| | tree (chrome-agent) | screenshot (computer-use style) |
|---|---|---|
| tokens per observation | **248** | 1,366 |
| observation tokens, 78 steps | **19,372** | 106,548 (−81.8%) |
| observe latency p50 | **5.6 ms** | 62 ms capture (+ vision inference, not measured) |

**Engine comparison** (daemon with 6 sessions):

| | chrome-headless-shell | full Chrome `--headless=new` |
|---|---|---|
| action latency p50 / p95 | **7.9 / 110 ms** | 16 / 118 ms |
| throughput, 6 agents | **135 actions/s** | 45 actions/s |
| session create, 6 at once (pool of 2) | 117 ms | 1,650 ms |
| session create from warm pool | **0.2 ms** | 0.2 ms |
| idle daemon footprint | **67 MB** | 521 MB |
| per session footprint | **53 MB** | 171 MB |
| processes for 6 agents | 11 | 20 |
| 6 separate browsers instead (naive) | 378 MB / 24 procs / 173 ms each | 1,933 MB / 36 procs / 883 ms each |

Honest reading of the memory column: with headless-shell, one shared daemon uses about the same
memory as six separate shell instances (each is already only ~63 MB) — the daemon's wins there
are spawn time, half the processes, no per-agent profiles on disk, and shared network/GPU
services. The big memory levers are the engine (−80% vs full Chrome) and shared contexts
(`-c`), where extra pages cost ~30 MB instead of ~53 MB. Memory is macOS `phys_footprint`
(what Activity Monitor shows); RSS is also recorded but double-counts shared framework pages.

## Comparison with computer use

These numbers are **not** the same kind of number as OSWorld or WebArena scores. Published
computer-use results measure *task success with a model in the loop*; this repo has so far
measured *cost per step with scripted agents*. For context (September 2026):

| System | Benchmark | Score |
|---|---|---|
| OpenAI Operator (launch) | WebArena | 58.1% |
| GPT-5.3-Codex | OSWorld | 64.7% |
| Claude Fable 5 / Mythos 5 | OSWorld-Verified | 85% |
| OSWorld 2.0 (all entrants, screenshot observation) | ~318 tool calls per task, 500-step budget | — |

Where chrome-agent changes the economics is the long horizon: at ~318 steps per task, screenshot
observation costs ~434k input tokens per task versus ~80k with `tree`, with no vision inference
on the critical path. What computer use does that this cannot: any desktop application, and
purely visual UIs. The known risk, from the original WebVoyager paper: a text-only agent on an
*unpruned* accessibility tree scored 40.1% versus 59.1% with screenshots (GPT-4-era models); later
work converged on hybrids. chrome-agent is built for the hybrid (pruned tree by default,
`screenshot` on demand) but its task success has **not** been measured — see the benchmark plan below.

Sources: [OSWorld 2.0 paper](https://arxiv.org/html/2606.29537v1), [OSWorld 2.0 leaderboard](https://leaderboard.steel.dev/leaderboards/osworld-2/), [GPT-5.3-Codex](https://openai.com/index/introducing-gpt-5-3-codex/), [Operator](https://en.wikipedia.org/wiki/OpenAI_Operator), [OSWorld-Verified leaderboard](https://benchlm.ai/benchmarks/osworld-verified), [WebVoyager](https://www.emergentmind.com/topics/webvoyager), [OpenWebVoyager](https://arxiv.org/pdf/2410.19609).

## Weaknesses and known limitations

Listed by how much they matter.

### 1. Unproven task success
- **No LLM-in-the-loop evaluation.** Every number above comes from scripted agents that already know what to click. Whether a model makes *better or worse decisions* from `tree` than from a screenshot is the central question, and it is unanswered here.
- **Mock test site only.** The benchmark's calendar/search/settings apps are simple server-rendered pages plus a little JS. Real SPAs (React virtualized lists, infinite scroll, portals, shadow DOM-heavy design systems, canvas grids) are where accessibility trees get ugly, and none of that is in the benchmark.
- **Token counts are estimated** as `chars / 4`, not with a real tokenizer. Screenshot tokens use Anthropic's `(w·h)/750` formula; other providers differ.

### 2. What the accessibility tree cannot see
- **Visual-only content**: canvas/WebGL apps, charts, maps, image-only buttons, CAPTCHAs, PDFs rendered in `<canvas>`.
- **Layout and spatial relations**: no bounding boxes, no "is this visible in the viewport", no columns/rows-of-cards structure. The tree tells you *what* exists, not *where*. Off-screen elements are listed as if on screen.
- **Poorly labeled markup**: icon buttons without `aria-label` show up as `button ""`; custom dropdowns, date pickers and comboboxes built from `<div>`s are not collapsed like native ones and may not expose their options at all.
- **Text-merge heuristics can still go wrong**: a `<div>` wrapper with ≥2 children ends a text run — good for lists, wrong for some inline layouts. Long text is clipped at `--max-text`.

### 3. Missing browser capabilities
- **Cross-origin iframes (OOPIFs)**, popups and `window.open` targets are not auto-attached; the tree stops at the iframe boundary and a new tab is invisible to the session.
- **No file upload** (`DOM.setFileInputFiles`), **no downloads** handling, **no drag-and-drop**, no clipboard, no IME/composition input, no touch gestures beyond `--mobile` viewport.
- **`select` only works on native `<select>`**; custom listboxes need `click` sequences.
- **No network control**: no request blocking/interception, no HAR/log, no header/cookie injection API, no proxy per session.
- **No persistent profiles**: contexts are ephemeral (`Target.createBrowserContext`), so an agent's login does not survive a daemon restart. Persistence would need one Chromium per profile.
- **SPA navigation** that doesn't fire load events relies on `wait --text/--selector`; `--wait` after a click uses a 120 ms "did a navigation start" window.

### 4. Bot detection and real-world sites
- `chrome-headless-shell` is trivially fingerprintable (`navigator.webdriver`, headless UA string, missing plugins/GPU strings). Sites behind Cloudflare/Akamai/DataDome will block it. Full Chrome `--headed` fares better but has not been tested against real anti-bot vendors. There is no stealth mode.
- Images are disabled by default (`--images` to enable), which some sites detect and which breaks image-dependent flows.

### 5. Security and isolation
- **No authentication** on the Unix socket or the CDP port (`--remote-allow-origins=*`): any local process can drive every session, run `eval`, and read every agent's cookies. Fine on a single-user dev box; not fine on a shared host.
- **`eval` is unrestricted JavaScript** in the page, and the mirror's `/input` endpoint accepts raw events from anyone who can reach `127.0.0.1:9333`.
- **One Chromium for everyone**: a renderer crash is isolated, but a browser-process crash or a GPU-process OOM takes every agent down with it. There is no per-session memory cap beyond the V8 heap flag, no idle-session eviction, and the GPU process grows ~10 MB per open page indefinitely.

### 6. Operational gaps
- **One machine, one run, one OS.** All measurements are from a single macOS arm64 laptop with no variance reported. Linux memory (`smaps_rollup` PSS) and the launcher's Linux paths are untested; Windows is unsupported.
- **Scale tested to 12 concurrent sessions**, not the "dozens" the design targets; nothing on 50–100.
- **Mirror** is JPEG-over-SSE at ~10 fps: fine for supervision, laggy for real work; no audio, no WebRTC, approximate key-code mapping.
- **CLI startup** is ~40–80 ms of Node per invocation (mitigated by `batch`/`repl`/MCP, not eliminated). Not published to npm.
- **MCP server** is a hand-rolled JSON-RPC loop: tools only (no resources/prompts), no schema validation, no auth.
- **Error recovery** is thin: a stale `@id` triggers one silent tree rebuild, but there is no retry policy, no "element covered by overlay" detection, no automatic dismissal of cookie banners.

## Areas for improvement (roadmap)

Ordered by expected impact on agent success per token.

**Observation quality**
1. **Hybrid observation on demand**: `tree --bbox` (viewport-relative boxes + `visible` flag from `DOM.getBoxModel`), and `screenshot --annotate` that draws `@id` labels on the image so a model can use vision *and* stable ids in one shot (Set-of-Marks style).
2. **`tree --diff`**: emit only lines that changed since the last call; on long pages this is often 10 lines instead of 300.
3. **Scoped reads**: `tree --under @id`, `text --under @id`, and `tree --near "text"`.
4. **Better collapsing** for custom widgets (ARIA `listbox`/`grid`/`tree`), tables → aligned rows, and a real tokenizer for `--stats`.
5. **Auto-labeling** unlabeled icon buttons from `title`, SVG `<title>`, or nearest text.

**Browser capabilities**
6. Auto-attach OOPIF and popup targets (`Target.setAutoAttach` on the session), merged into one tree with `[iframe]` scopes; new tabs become sessions.
7. `upload @id file…`, download capture (`Browser.setDownloadBehavior`), drag-and-drop via `Input.dispatchDragEvent`, clipboard.
8. Network layer: `net block <pattern>`, `net log`, per-session headers/cookies/proxy (`Fetch` and `Network` domains), request/response capture for API-driven pages.
9. Persistent named profiles (one Chromium per profile, still pooled sessions inside it) so logins survive restarts.
10. Structured extraction: `table @id --csv`, `links`, `forms`.

**Robustness**
11. Retry/wait policy: automatic "element not interactable / covered" detection with scroll-and-retry; cookie-banner heuristics; SPA idle detection via `Network` + mutation quiescence.
12. Stealth mode for full Chrome (`--headed` or new headless with patched fingerprints), and honest documentation of what still gets blocked.
13. Session lifecycle: idle eviction, per-session memory budget (`Memory.getDOMCounters`, renderer footprint), auto-restart of the daemon with session state re-created from a journal.

**Platform and product**
14. Socket/CDP auth (token or peer-credential check), `eval` allow-list mode, mirror auth.
15. Linux + Windows CI, Docker image with headless-shell baked in, npm publish.
16. WebRTC mirror (`getDisplayMedia`-quality, 30+ fps) and an "agent narration" side panel showing the command stream next to the video.
17. Multi-agent coordination primitives: `lock <url-pattern>` so two agents in a shared context don't stomp on one page, and a broadcast channel.

## Benchmarks I recommend running

The single most important gap is an **LLM-in-the-loop A/B**: the same model, the same tasks,
three observation modes — `tree` only, screenshot only, hybrid (`tree` + on-demand annotated
screenshot) — reporting success rate, steps, input tokens, dollar cost, wall time, and per-step
latency, with ≥3 seeds and confidence intervals. In priority order:

| # | Benchmark | Why it fits | What to report |
|---|---|---|---|
| 1 | **WebArena** (812 tasks, self-hosted GitLab/Reddit/shopping/CMS/maps) | Self-hosted, so no anti-bot noise and reproducible; the standard text-vs-vision battleground. Run through BrowserGym/AgentLab for the harness. | success %, steps, tokens/task, $/task, wall/task; per-site breakdown |
| 2 | **VisualWebArena** (910 tasks) | Stresses exactly what the tree cannot see (images, visual grounding). Expect `tree`-only to lose; measures how much hybrid recovers. | same + fraction of steps that needed a screenshot |
| 3 | **WebVoyager** (643 tasks, live sites) and **Online-Mind2Web** | Real-world sites: measures bot-blocking, SPA handling, unlabeled controls. Live sites drift, so pin dates and report per-site failures. | success %, blocked-by-anti-bot %, tree size distribution |
| 4 | **OSWorld-Verified / OSWorld 2.0, Chrome-task subset** | Direct comparability with published computer-use numbers on the browser portion; 2.0's ~318-step tasks are where per-step cost dominates. | success %, tokens/task vs screenshot baseline, wall time |
| 5 | **AssistantBench / BrowseComp / GAIA (web subset)** | Research-style long-horizon browsing where `text` + `find` should shine and token savings compound most. | success %, tokens, cost |
| 6 | **ST-WebAgentBench / WAREX** | Safety and reliability: destructive-action avoidance and flakiness across repeated runs. | policy-violation rate, run-to-run variance |

Infrastructure benchmarks to add to `bench/`:

- **Real-site tree profile**: top-500 Tranco sites → `getFullAXTree` latency, raw nodes, emitted lines, estimated tokens, `%` of interactive nodes with empty names. This is the honest "how big is the tree in the wild" number.
- **Scale**: 25 / 50 / 100 concurrent sessions on one daemon, measuring p50/p95 action latency, footprint per session, GPU-process growth, and failure rate; then the same on Linux in Docker.
- **Endurance**: one session executing 5,000 actions across 200 navigations — memory growth (leak check), id-map size, latency drift.
- **Cold start and warm pool**: daemon start-to-first-command, pooled vs unpooled session creation under bursts of 1/6/20 simultaneous agents.
- **Mirror**: frame latency (screencast timestamp → canvas paint) and input round-trip under load.
- **Variance**: every existing bench run 5× with mean ± CI; today's tables are single runs.

## Tests

`npm test` runs 24 end-to-end cases against a local mock site: every command, id stability,
widget collapsing, isolation vs shared contexts, 12 parallel sessions, per-session
serialization, the CLI (`batch`, `repl`, `--json`, exit codes), the mirror (SSE frames,
input passthrough, release handoff), DevTools, the MCP server, and clean shutdown.
Coverage gaps: no tests on real websites, no Linux/Windows CI, no fuzzing of the tree
formatter on hostile markup, no load tests beyond 12 sessions.

## Layout

```
src/cdp.ts        minimal flat-session CDP client (WebSocket, zero deps)
src/launcher.ts   engine discovery + measured Chromium flag set
src/session.ts    one agent session: every command → CDP calls
src/tree.ts       accessibility tree → token-efficient action map
src/daemon.ts     Unix-socket JSON-lines server, session table, warm pool, stats
src/mirror.ts     SSE screencast viewer + input passthrough
src/protocol.ts   wire protocol + DaemonClient + single-spawn daemon start
src/cli.ts        the chrome-agent command
src/mcp.ts        MCP stdio server
src/memory.ts     process-tree memory (footprint / RSS / PSS)
src/test-site/    deterministic local web apps for tests and the benchmark
src/bench/run.ts  multi-agent benchmark
src/test/e2e.ts   end-to-end suite
docs/             ARCHITECTURE.md, AGENT_PROMPT.md
bench/results/    raw JSON from the runs quoted above
```
