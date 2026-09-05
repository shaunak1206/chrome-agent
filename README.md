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
$ chrome-agent screencast --open        # human watches the same page live, can take over, hands back
```

Zero runtime dependencies (Node ≥ 22). MIT.

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
git clone <this repo> && cd chrome-agent
npm install && npm run build
node bin/chrome-agent.js install      # fetches chrome-headless-shell (~150 MB) into ~/.chrome-agent/browsers
```

Any Chrome/Chromium works out of the box (auto-detected, or `CHROME_PATH=…`), but
`chrome-headless-shell` is ~4× leaner per session and 3× faster to spawn one — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#engine-choice-why-chrome-headless-shell-is-the-default).

Put `bin/chrome-agent.js` on your PATH (`npm link`, or alias `chrome-agent="node $PWD/bin/chrome-agent.js"`).

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

### For LLM agents

- Shell tool: paste [docs/AGENT_PROMPT.md](docs/AGENT_PROMPT.md) into the system prompt.
- MCP: `claude mcp add chrome-agent -- node /path/to/chrome-agent/dist/mcp.js` — 17 tools (`browser_goto`, `browser_tree`, `browser_click`, …), each taking an optional `session`/`context`.
- In-process (TypeScript): `DaemonClient` in `src/protocol.ts` — `await client.run("click", { ref: "@14" }, "agent7")`.

### Human mirror

```bash
chrome-agent -s agent7 screencast --open     # opens http://127.0.0.1:9333/view?s=agent7
chrome-agent -s agent7 wait --release        # agent blocks until the human clicks "release to agent"
```
The mirror streams `Page.screencast` JPEG frames over SSE into a canvas and forwards the
human's mouse/keyboard back into the same session over CDP `Input.*`, so a human can finish a
CAPTCHA or 2FA in the agent's own page and hand it back. Nothing is rendered until someone is
watching; when the last viewer leaves, the screencast stops. `devtools` gives full Chrome
DevTools on the session; `daemon start --headed` runs real windows if you want them.

## Benchmark (this machine: M-series Mac, 8 GB, Chrome 152)

`npm run bench -- --compare-instances` — 6 concurrent scripted agents × 3 iterations each of
realistic workflows (login + schedule a meeting; search, open two articles, verify a fact, go
back; fill and save a settings form), asserting on outcomes. 264 actions per run. Full
method in [docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-benchmark-method); raw JSON in `bench/results/`.

**Tokens & latency** (identical on both engines, since only the observation differs):

| | tree (chrome-agent) | screenshot (computer-use style) |
|---|---|---|
| tokens per observation | **248** | 1,366 |
| observation tokens, 78 steps | **19,372** | 106,548 (−81.8%) |
| observe latency p50 | **5.6 ms** | 62 ms capture (+ vision inference, not measured) |

**Engine comparison** (daemon with 6 sessions, headless-shell vs full Chrome `--headless=new`):

| | chrome-headless-shell | full Chrome |
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
(`-c`), where extra pages cost ~30 MB instead of ~53 MB. Per-process memory is macOS
`phys_footprint` (what Activity Monitor shows); RSS is also recorded but double-counts shared
framework pages and overstates by ~3×.

## Tests

`npm test` runs 24 end-to-end cases against a local mock site: every command, id stability,
widget collapsing, isolation vs shared contexts, 12 parallel sessions, per-session
serialization, the CLI (`batch`, `repl`, `--json`, exit codes), the mirror (SSE frames,
input passthrough, release handoff), DevTools, the MCP server, and clean shutdown.

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
```
