# chrome-agent — Architecture

`chrome-agent` is a Chrome CLI for AI agents: one long-lived headless Chromium
daemon, many cheap isolated sessions, and a command surface that returns
compact text instead of pixels. It drives Chromium over the raw DevTools
Protocol (CDP) with zero runtime dependencies (Node ≥ 22 has a WebSocket client).

```
 agent A ──┐  chrome-agent CLI / MCP / DaemonClient      (JSON lines over a Unix socket)
 agent B ──┼──────────────────────────────────────►  daemon (node)  ──► one CDP WebSocket ──► Chromium
 agent C ──┘        -s <session>  -c <context>            │                 (flat sessions:      ├─ browser process
 human  ◄─────── mirror: SSE frames + POST input ─────────┘                  every message       ├─ network / storage / GPU
                 (Page.screencast ⇄ Input.*)                                 carries sessionId)  └─ renderer per site per context
```

## 1. Process model

| Layer | What it is | Cost |
|---|---|---|
| **Daemon** | One Node process. Owns the Chromium child, the single CDP socket, the session table, the warm pool, latency stats, the mirror HTTP server. Auto-started by the first CLI call, guarded by an `O_EXCL` lock so racing agents can't double-spawn it. | ~45 MB RSS |
| **Chromium** | One process tree for everyone. `chrome-headless-shell` when installed (`chrome-agent install`), else full Chrome in `--headless=new`, else full Chrome headed (`--headed`) for a real window. | see §3 |
| **Session** (`-s name`) | One `BrowserContext` (private cookies/storage, `disposeOnDetach`) + one page target + one flat CDP `sessionId`. Auto-created on first use. Commands within a session are serialized; different sessions run fully in parallel. | ~40–55 MB (shell) |
| **Shared context** (`-c name`) | Sessions with the same context share one `BrowserContext`: same cookies, storage, and — with `--process-per-site` — the same renderer per site. For agents collaborating inside one login, or for maximum density. | ~25–30 MB per extra page |
| **Warm pool** | `--pool N` (default 2) private sessions are pre-created (context + target + attach + domain enables). Claiming one costs ~0.2 ms; the pool refills in the background. | N × session |

Storage: the profile lives in a `mkdtemp` directory and is deleted on stop.
Contexts are ephemeral and disposed when their last session closes, so disk
never accumulates per agent.

### Session lifecycle (CDP)

```
Target.createBrowserContext {disposeOnDetach:true}          → browserContextId
Target.createTarget {url:"about:blank", browserContextId, background:true} → targetId
Target.attachToTarget {targetId, flatten:true}              → sessionId
Page.enable · Accessibility.enable · Runtime.enable · Emulation.setFocusEmulationEnabled · Page.setLifecycleEventsEnabled
```
Measured on Chrome 152 / macOS arm64: ~43 ms on chrome-headless-shell, ~120–140 ms on full Chrome (renderer spawn dominates). The pool hides this entirely for the common case.

## 2. Command → CDP mapping

| Command | CDP calls | Notes |
|---|---|---|
| `goto <url>` | `Page.navigate`, then wait `Page.loadEventFired` (`--wait domcontentloaded` / `idle` = `Page.lifecycleEvent networkIdle` / `none`) | listener is registered before navigate; no race |
| `tree` | `Accessibility.getFullAXTree` + `Runtime.evaluate` (title/url) | formatter in §4; 4–15 ms on typical pages |
| `find <q>` | same as `tree`, filtered | |
| `text` | `Runtime.evaluate document.body.innerText` | |
| `eval <js>` | `Runtime.evaluate {returnByValue, awaitPromise, userGesture}` | exceptions surface as errors |
| `click @N` | `DOM.scrollIntoViewIfNeeded` → `DOM.getContentQuads` → `Input.dispatchMouseEvent` moved/pressed/released | real trusted events at the node's center; zero-size nodes fall back to `element.click()`; `--js` forces that; `--wait` settles a navigation if one started |
| `click <css>` | `DOM.getDocument` → `DOM.querySelector` → `DOM.describeNode` → as above | selectors are accepted anywhere an `@id` is |
| `type @N text` | `DOM.focus` → select-all via `Runtime.callFunctionOn` → `Input.dispatchKeyEvent Backspace` → `Input.insertText` | one round trip regardless of text length; `--keys` sends per-key `keyDown/keyUp`; `--submit` presses Enter |
| `press <key>` | `Input.dispatchKeyEvent` keyDown/keyUp with key/code/VK codes; `cmd+a` maps to the `selectAll` editing command | |
| `select @N v` | `DOM.resolveNode` → `Runtime.callFunctionOn` (set value, fire `input`+`change`) | matches value, then text, then substring |
| `check @N` | `Runtime.callFunctionOn` (`.click()` only if state differs) | |
| `scroll` | `Input.dispatchMouseEvent mouseWheel` + one rAF, or `window.scrollTo` | `--disable-smooth-scrolling` makes the read-back immediate |
| `hover`/`focus` | `Input.dispatchMouseEvent mouseMoved` / `DOM.focus` | |
| `wait` | polls `Runtime.evaluate` every 40 ms (`--text`, `--selector`, `--gone`), or waits for load events, or `--release` for the human mirror | |
| `back`/`forward`/`reload` | `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` / `Page.reload` | waits for load |
| `screenshot` | `Page.captureScreenshot` (png/jpeg, `captureBeyondViewport` for `--full`) | ~55 ms at 1280×800 |
| `viewport WxH` | `Emulation.setDeviceMetricsOverride` | |
| `screencast` | `Page.startScreencast` (jpeg) → frames pushed to viewers; viewer input → `Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText` | §5 |
| `devtools` | none — returns the bundled DevTools frontend URL for the target | |
| dialogs | `Page.javascriptDialogOpening` → `Page.handleJavaScriptDialog {accept:true}` | agents never block on `alert()` |

Every command's daemon-side latency is recorded; `status --stats` prints p50/p95/max per command.

## 3. Chromium flag tuning (measured, not folklore)

All flags live in `src/launcher.ts`. The interesting ones:

| Flag | Why |
|---|---|
| `--remote-debugging-port=0`, `--remote-allow-origins=*` | OS-assigned port parsed from stderr; allows the daemon, DevTools, and mirror clients |
| `--headless=new` (full Chrome only) | chrome-headless-shell is headless by construction |
| **no** `--disable-gpu` | Counter-intuitive but measured on Chrome 152/macOS: with it, every renderer takes ~600 ms to become ready and renderers double in size (software raster in-process); without it, ~120 ms and ~46 MB. Headless already rasterizes via ANGLE. |
| `--blink-settings=imagesEnabled=false` | Agents read text; skip image decode/memory/bandwidth. `--images` re-enables. |
| `--animation-duration-scale=0`, `--disable-smooth-scrolling` | Actions settle immediately; no waiting for transitions. |
| `--process-per-site`, `--disable-site-isolation-trials`, `--renderer-process-limit=8` | Pages on the same site inside one context share a renderer. Note: the limit is advisory; isolated contexts always get their own renderer. |
| `--disable-features=Translate,OptimizationHints,MediaRouter,…,PaintHolding,BackForwardCache` | No background services, no held paints, no BFCache renderers lingering. |
| `--enable-features=NetworkServiceInMemoryCache` | No disk cache writes. |
| `--js-flags=--max-old-space-size=256` | A runaway page can't eat the box. |
| `--disable-extensions`, `--no-first-run`, `--disable-sync`, `--metrics-recording-only`, `--use-mock-keychain`, … | Standard "nothing but the page" set. |

### Engine choice (why chrome-headless-shell is the default)

Five isolated sessions each on a real page, Chrome 152, macOS arm64, `footprint` (phys_footprint) per process type:

| Engine | Total | Browser | GPU | Renderers | Extra per context |
|---|---|---|---|---|---|
| Chrome `--headless=new` | **1,091 MB** | 109 | 382 | 6 × 35 | 6 × 58 (`--top-chrome-webui` renderer per window) |
| chrome-headless-shell | **249 MB** | 25 | 70 | 6 × 25 | none |
| chrome-headless-shell, 5 pages in ONE context | **151 MB** | 20 | 69 | 2 × 28 | — |

New headless mode is "real Chrome with an invisible window": every `BrowserContext` gets a
window, and every window gets a top-chrome WebUI renderer plus its own GPU surfaces. The
shell build has no browser UI at all. Session spawn: 43 ms vs 140 ms. `chrome-agent install`
fetches it (Chrome for Testing, ~150 MB) into `~/.chrome-agent/browsers`.

## 4. Semantic tree formatter (`src/tree.ts`)

Input: the flat node list from `Accessibility.getFullAXTree`. Output: one line per
element an agent can act on or needs to read.

```
url: https://cal.example/ "Calendar"
[main]
 h1 "September 2026"
 text "Signed in as agent@example.com"
 @10 button "Schedule meeting"
 @14 search "Search events"
 @20 select "Time" ="09:00" [09:00|10:00|11:00|14:00|15:00]
 @19 date "Date" ="2026-09-10"
 @23 checkbox "Add video call" checked
```

Rules:
- **Interactive roles** (button, link, textbox, combobox, checkbox, radio, tab, menuitem, slider, date…) get an `@id`, a short role alias, the accessible name, `=value`, and state flags (`checked`, `disabled`, `expanded`, `required`, `focused`, `selected`, `popup`).
- **Composite widgets collapse**: a `<select>` prints its options inline instead of N child lines; date/time inputs print one line instead of three spinbuttons and a picker button; a button's children (its label) are skipped unless they contain nested controls.
- **Context** (default mode): headings as `hN "…"`, landmark/structural roles as `[dialog]`/`[form]`/`[nav]`, and consecutive static text merged into one `text "…"` line, flushed at block boundaries so separate paragraphs/list items never merge into one clipped line. `-i` drops all of it.
- **Noise dropped**: generic wrappers, list markers, inline text boxes, images (images are disabled anyway), SVG internals, scrollbars; label text that equals the control's name.
- **Stable ids**: `@N` maps to a `backendDOMNodeId` for the life of the document. Repeated `tree` calls keep ids; navigation resets them (a `click @N` right after navigation silently rebuilds the map, so the common "goto → click" needs no explicit `tree`).
- **Budget**: `--max-lines` (400) and `--max-text` (120 chars) caps; `--stats` prints raw node count, emitted lines, estimated tokens (chars/4), and the screenshot-equivalent cost `(w·h)/750`.

Typical pages: 80–170 raw AX nodes → 8–33 lines → 80–250 tokens, versus 1,366 tokens for one 1280×800 screenshot.

## 5. Dual-mode visual mirroring

Headless is the default; nothing is rendered for humans until asked.

- `chrome-agent -s A screencast --open` starts `Page.startScreencast` (JPEG, viewport-sized) on session A **without touching the agent's session**, and opens `http://127.0.0.1:9333/view?s=A`. The page is a canvas fed by Server-Sent Events (one event per frame, acked with `Page.screencastFrameAck` so Chromium never outruns the viewer). The agent keeps issuing commands; the human sees them land in real time.
- **Take control**: the viewer forwards mouse move/press/release/wheel and keyboard events (with modifiers, VK codes and `selectAll` for ⌘A) to `Input.*` on the same session. Coordinates are scaled through the frame metadata so clicks are 1:1. A URL bar drives `Page.navigate`.
- **Hand back**: "release to agent" resolves any `chrome-agent wait --release` the agent is blocked on. That is the handoff protocol: agent hits a CAPTCHA/2FA → `screencast` + `wait --release` → human finishes → agent resumes on the same page, same cookies, same `@ids`.
- **Stop**: when the last viewer disconnects, `Page.stopScreencast` runs and the session is back to zero rendering overhead.
- `devtools` returns the URL of Chromium's bundled DevTools frontend attached to the session (Elements, Network, Console, and its own screencast), for deep inspection in a normal browser.
- `daemon start --headed` launches full Chrome with real windows when a literal desktop window is wanted; everything else is identical.

## 6. Wire protocol

Unix socket `~/.chrome-agent/daemon.sock`, newline-delimited JSON:

```json
{"id":1,"cmd":"click","session":"agent7","context":"team","args":{"ref":"@14","wait":"load"}}
{"id":1,"ok":true,"result":{"clicked":"@14","role":"button","name":"Sign in"},"ms":23.4}
```
Any number of requests may be pipelined on one connection; the daemon serializes per session and parallelizes across sessions. `chrome-agent repl` and `batch` reuse one connection so a whole workflow costs one process spawn (~40 ms of Node startup) instead of one per action; `DaemonClient` (`src/protocol.ts`) is the in-process client used by the benchmark and the MCP server.

## 7. Concurrency and safety

- Per-session promise chain: `goto` then `tree` pipelined always sees the new page.
- Sessions never share `@id` maps, cookies, or focus (`Emulation.setFocusEmulationEnabled` makes every background page believe it is focused, so typing works in 50 sessions at once).
- Command latency is measured daemon-side and exposed via `status --stats`; memory via `ps` RSS and macOS `footprint` (Linux: PSS from `smaps_rollup`).
- Crash of Chromium or loss of the CDP socket shuts the daemon down cleanly (socket, info file, temp profile removed); the next CLI call restarts it.

## 8. Benchmark method

`node dist/bench/run.js --agents N --iterations K [--engine shell|chrome] [--compare-instances]`

- Boots the local test site (`src/test-site`: a login-gated calendar with a schedule-meeting dialog, a search engine with article pages carrying a verifiable fact, and a settings form) and a fresh daemon in a temp home.
- N scripted agents run observe→act workflows concurrently and assert on outcomes (a wrong click is a failure, not a latency number).
- Two observation modes: `tree` (counts the tree's estimated tokens) and `screenshot` (captures a real 1280×800 PNG each step and counts `(w·h)/750` vision tokens). Vision-model inference time is *not* included, so the latency gap is understated.
- Memory is sampled every 400 ms across the whole Chromium tree; `--compare-instances` launches N separate browsers with identical flags for the naive layout.
- Results are printed and written to `bench/results/*.json`. See README for numbers from this machine.
