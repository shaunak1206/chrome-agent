/**
 * MCP (Model Context Protocol) stdio server exposing chrome-agent to LLM agents
 * (Claude Code, Claude Desktop, any MCP client). Zero dependencies: newline-
 * delimited JSON-RPC 2.0 on stdin/stdout, forwarding to the shared daemon.
 *
 *   claude mcp add chrome-agent -- node /path/to/chrome-agent/dist/mcp.js
 */
import { createInterface } from "node:readline";
import { DaemonClient, sockPath } from "./protocol.js";

const S = { type: "string" } as const, B = { type: "boolean" } as const, N = { type: "number" } as const;
const common = { session: { ...S, description: "Session name (one isolated page per agent). Default 'default'." }, context: { ...S, description: "Optional shared context: sessions with the same context share cookies/storage." } };
const tool = (name: string, description: string, props: Record<string, any>, required: string[] = []) => ({ name, description, inputSchema: { type: "object", properties: { ...props, ...common }, required } });

const TOOLS = [
  tool("browser_goto", "Navigate the session's page to a URL and wait for load. Returns url + title.", { url: S, wait: { ...S, enum: ["load", "domcontentloaded", "idle", "none"] } }, ["url"]),
  tool("browser_tree", "Read the page as a compact action map: one line per element, '@N role \"name\" [state]'. Use @N ids with click/type/select. ~100-400 tokens instead of a screenshot.", { interactiveOnly: { ...B, description: "Only actionable elements (default false = also headings/text)." }, filter: { ...S, description: "Only lines containing this text." }, maxLines: N }),
  tool("browser_find", "Tree lines whose text matches a query (case-insensitive).", { query: S }, ["query"]),
  tool("browser_click", "Click an element by @id (from browser_tree) or CSS selector, via real mouse events. Set wait=true if it navigates.", { ref: S, wait: B, js: { ...B, description: "Use element.click() instead of mouse events." }, right: B, double: B }, ["ref"]),
  tool("browser_type", "Focus an element and type text (clears existing text first unless clear=false). submit=true presses Enter after.", { ref: S, text: S, clear: B, submit: B }, ["ref", "text"]),
  tool("browser_press", "Press a key or chord: Enter, Tab, Escape, ArrowDown, cmd+a, shift+Tab ...", { key: S, wait: B }, ["key"]),
  tool("browser_select", "Choose an option in a <select> by value or visible text.", { ref: S, value: S }, ["ref", "value"]),
  tool("browser_check", "Set a checkbox/radio to checked (default) or unchecked.", { ref: S, state: B }, ["ref"]),
  tool("browser_scroll", "Scroll the page (or an element) by pixels, or to top/bottom.", { ref: S, dy: N, to: { ...S, enum: ["top", "bottom"] } }),
  tool("browser_wait", "Wait for text to appear, a selector to exist/disappear, page load, N ms, or for a human to click 'release' in the mirror.", { text: S, selector: S, gone: S, ms: N, load: B, release: B, timeoutMs: N }),
  tool("browser_text", "The page's visible text (innerText), truncated to maxChars.", { maxChars: N }),
  tool("browser_eval", "Run JavaScript in the page and return the JSON result.", { expression: S }, ["expression"]),
  tool("browser_screenshot", "Capture the page as an image (only when visual confirmation is truly needed; costs ~1.4k tokens).", { fullPage: B, jpeg: B }),
  tool("browser_back", "Go back in history.", {}),
  tool("browser_screencast", "Start a live 1:1 mirror of this session for a human (returns a URL to open). Humans can watch, take control, and hand back with 'release'.", { port: N }),
  tool("browser_sessions", "List open sessions.", {}),
  tool("browser_close", "Close this session (or all with all=true).", { all: B }),
];

let client: DaemonClient | null = null;
async function daemon() { return (client ??= await DaemonClient.connect(sockPath(), true)); }

async function callTool(name: string, a: Record<string, any>): Promise<{ content: any[]; isError?: boolean }> {
  const c = await daemon();
  const run = (cmd: string, args: Record<string, any> = {}) => c.run(cmd, args, a.session ?? "default", a.context);
  const text = (t: any) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t) }] });
  switch (name) {
    case "browser_goto": return text(await run("goto", { url: a.url, wait: a.wait }));
    case "browser_tree": { const r = await run("tree", { interactiveOnly: a.interactiveOnly, filter: a.filter, maxLines: a.maxLines }); return text(r.text + (r.truncated ? "\n…(truncated)" : "")); }
    case "browser_find": return text((await run("find", { query: a.query })).text || "(no matches)");
    case "browser_click": return text(await run("click", { ref: a.ref, wait: a.wait ? "load" : undefined, js: a.js, button: a.right ? "right" : "left", count: a.double ? 2 : 1 }));
    case "browser_type": return text(await run("type", { ref: a.ref, text: a.text, clear: a.clear, submit: a.submit }));
    case "browser_press": return text(await run("press", { key: a.key, wait: a.wait ? "load" : undefined }));
    case "browser_select": return text(await run("select", { ref: a.ref, value: a.value }));
    case "browser_check": return text(await run("check", { ref: a.ref, state: a.state ?? true }));
    case "browser_scroll": return text(await run("scroll", { ref: a.ref, dy: a.dy, to: a.to }));
    case "browser_wait": return text(await run("wait", { text: a.text, selector: a.selector, gone: a.gone, ms: a.ms, load: a.load ? "load" : undefined, release: a.release, timeoutMs: a.timeoutMs }));
    case "browser_text": return text((await run("text", { maxChars: a.maxChars })).text);
    case "browser_eval": return text((await run("eval", { expression: a.expression })).value);
    case "browser_screenshot": { const r = await run("screenshot", { fullPage: a.fullPage, format: a.jpeg ? "jpeg" : "png" }); return { content: [{ type: "image", data: r.base64, mimeType: a.jpeg ? "image/jpeg" : "image/png" }] }; }
    case "browser_back": return text(await run("back"));
    case "browser_screencast": { const r = await run("screencast", { port: a.port }); return text(`Open ${r.url} to watch/take over. Call browser_wait with release=true to block until the human hands back control.`); }
    case "browser_sessions": return text(await c.run("sessions"));
    case "browser_close": return text(a.all ? await c.run("session.closeAll") : await c.run("session.close", { name: a.session ?? "default" }));
  }
  return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
}

const send = (msg: any) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req: any; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return;   // notification
  try {
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chrome-agent", version: "0.1.0" } } });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    else if (method === "tools/call") { try { send({ jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments ?? {}) }); } catch (e: any) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${e.message}` }], isError: true } }); } }
    else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
    else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e: any) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } }); }
});
rl.on("close", () => { client?.close(); process.exit(0); });
