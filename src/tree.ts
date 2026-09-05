/**
 * Semantic tree formatter.
 * Converts Chrome's Accessibility.getFullAXTree output into a compact,
 * terminal-style action map that costs a few hundred tokens instead of a
 * ~1,400-token screenshot or 50k+ tokens of raw HTML.
 *
 *   url: https://cal.example/ "Calendar"
 *   h1 "September 2026"
 *   @1 button "Schedule meeting"
 *   @2 textbox "Search events" =""
 *   @3 link "Settings"
 *   text "3 events this week"
 *
 * Node ids (@N) are stable for the lifetime of a document: the same DOM node
 * keeps the same id across repeated `tree` calls until navigation.
 */

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  value?: { value: any };
  properties?: { name: string; value: { value: any } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface TreeOptions {
  interactiveOnly?: boolean;
  maxText?: number;      // chars per text line (default 120)
  urls?: boolean;        // include link hrefs
  maxLines?: number;     // hard cap on output lines
  filter?: string;       // only lines containing this substring (case-insensitive)
}

export interface TreeResult {
  lines: string[];
  text: string;
  nodeCount: number;     // raw AX nodes seen
  emitted: number;
  estTokens: number;
  truncated: boolean;
}

/** Roles an agent can act on. Everything else is context. */
export const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
  "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
  "option", "listbox", "treeitem", "textarea", "DisclosureTriangle", "menubutton",
  "toggle button", "ColorWell", "DateTime", "Date", "Time", "InputTime", "Week", "Month", "date", "time",
]);
/** Composite widgets whose children are implementation detail (date spinners, select popups). */
const LEAF_WIDGET = new Set(["combobox", "Date", "DateTime", "Time", "InputTime", "Week", "Month", "date", "time", "ColorWell", "slider", "spinbutton", "listbox"]);

/** Structural roles worth one short line in full mode. */
const STRUCTURE = new Set(["dialog", "alertdialog", "navigation", "main", "form", "table", "tablist", "menu", "alert", "status", "region", "banner", "contentinfo", "search", "complementary"]);
const TEXTY = new Set(["StaticText", "paragraph", "LabelText", "caption", "note", "blockquote", "code", "term", "definition", "time", "listitem", "cell", "gridcell", "columnheader", "rowheader", "figcaption", "log", "marquee", "tooltip"]);
/** Leaving one of these ends a text run, so separate blocks never merge into one clipped line. */
const BLOCK = new Set(["paragraph", "listitem", "cell", "gridcell", "columnheader", "rowheader", "article", "section", "region", "main", "form", "dialog", "alertdialog", "group", "figure", "blockquote", "list", "table", "row", "navigation", "banner", "contentinfo", "complementary", "term", "definition", "note", "status", "alert", "log", "tooltip", "caption", "figcaption", "code", "search", "menu", "tablist", "RootWebArea"]);
const DROP_SUBTREE = new Set(["ListMarker", "InlineTextBox", "LineBreak", "SvgRoot", "image", "img", "Canvas", "ScrollBar", "presentation"]);

const ROLE_ALIAS: Record<string, string> = {
  StaticText: "text", paragraph: "text", LabelText: "label", searchbox: "search", spinbutton: "number",
  DisclosureTriangle: "toggle", menuitemcheckbox: "menuitem", menuitemradio: "menuitem", RootWebArea: "page",
  alertdialog: "dialog", columnheader: "th", rowheader: "th", cell: "td", gridcell: "td",
  Date: "date", DateTime: "datetime", Time: "time", InputTime: "time", Week: "week", Month: "month", ColorWell: "color",
};

/** Collect the option labels under a <select>'s combobox (MenuListPopup > option...). */
function optionsOf(n: AXNode, byId: Map<string, AXNode>): string[] | null {
  const out: string[] = [];
  const walk = (x: AXNode | undefined, d: number) => { if (!x || d > 4) return; if (x.role?.value === "option" || x.role?.value === "menuitem") { out.push(String(x.name?.value ?? "")); return; } for (const c of x.childIds ?? []) walk(byId.get(c), d + 1); };
  for (const c of n.childIds ?? []) walk(byId.get(c), 0);
  return out.length ? out : null;
}

function prop(n: AXNode, name: string): any {
  return n.properties?.find((p) => p.name === name)?.value?.value;
}

function q(s: string): string {
  return JSON.stringify(s);
}

function norm(s: string): string { return s.replace(/\s+/g, " ").trim().toLowerCase(); }

function clip(s: string, max: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export class NodeIdMap {
  private fwd = new Map<number, number>(); // backendDOMNodeId -> @id
  private rev = new Map<number, number>(); // @id -> backendDOMNodeId
  private meta = new Map<number, { role: string; name: string }>();
  private next = 1;
  reset() { this.fwd.clear(); this.rev.clear(); this.meta.clear(); this.next = 1; }
  idFor(backendId: number, role: string, name: string): number {
    let id = this.fwd.get(backendId);
    if (id === undefined) { id = this.next++; this.fwd.set(backendId, id); this.rev.set(id, backendId); }
    this.meta.set(id, { role, name });
    return id;
  }
  backendFor(id: number): number | undefined { return this.rev.get(id); }
  describe(id: number) { return this.meta.get(id); }
  get size() { return this.fwd.size; }
}

export function formatTree(nodes: AXNode[], ids: NodeIdMap, url: string, title: string, opts: TreeOptions = {}): TreeResult {
  const maxText = opts.maxText ?? 120;
  const maxLines = opts.maxLines ?? 400;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const lines: string[] = [`url: ${url} ${q(clip(title, 80))}`];
  let emitted = 0;
  let truncated = false;
  let pendingText: string[] = [];   // consecutive text runs get merged into one line

  const flushText = (depth: number) => {
    if (!pendingText.length) return;
    const merged = clip(pendingText.join(" "), maxText);
    pendingText = [];
    if (merged) push(`${" ".repeat(depth)}text ${q(merged)}`);
  };
  const push = (line: string) => {
    if (opts.filter && !line.toLowerCase().includes(opts.filter.toLowerCase())) return;
    if (lines.length >= maxLines) { truncated = true; return; }
    lines.push(line);
    emitted++;
  };

  const walk = (n: AXNode | undefined, depth: number) => {
    if (!n || truncated) return;
    const role = n.role?.value ?? "";
    if (DROP_SUBTREE.has(role)) return;
    const name = (n.name?.value ?? "").toString();
    const children = n.childIds ?? [];
    let childDepth = depth;

    if (!n.ignored && INTERACTIVE.has(role)) {
      // A <label> whose text is exactly this control's accessible name is redundant.
      if (pendingText.length && norm(pendingText.join(" ")) === norm(name)) pendingText = [];
      flushText(depth);
      const id = ids.idFor(n.backendDOMNodeId ?? -1, role, name);
      const selOpts = role === "combobox" ? optionsOf(n, byId) : null;
      const parts: string[] = [`@${id}`, selOpts ? "select" : ROLE_ALIAS[role] ?? role];
      if (name) parts.push(q(clip(name, 80)));
      const val = n.value?.value;
      if (val !== undefined && val !== "" && val !== null && !["button", "link", "tab", "menuitem"].includes(role)) parts.push(`=${q(clip(String(val), 60))}`);
      const checked = prop(n, "checked");
      if (checked !== undefined && checked !== "false") parts.push(checked === "true" ? "checked" : `checked=${checked}`);
      const pressed = prop(n, "pressed");
      if (pressed !== undefined && pressed !== "false") parts.push("pressed");
      if (prop(n, "selected") === true) parts.push("selected");
      if (prop(n, "expanded") !== undefined) parts.push(prop(n, "expanded") ? "expanded" : "collapsed");
      if (prop(n, "disabled") === true) parts.push("disabled");
      if (prop(n, "required") === true) parts.push("required");
      if (prop(n, "focused") === true) parts.push("focused");
      if (prop(n, "hasPopup") && prop(n, "hasPopup") !== "false") parts.push(`popup`);
      if (opts.urls && role === "link" && prop(n, "url")) parts.push(`href=${q(clip(String(prop(n, "url")), 100))}`);
      const desc = n.description?.value;
      if (desc && desc !== name) parts.push(`(${clip(String(desc), 60)})`);
      if (selOpts) parts.push(`[${selOpts.slice(0, 12).map((o) => clip(o, 30)).join("|")}${selOpts.length > 12 ? `|+${selOpts.length - 12}` : ""}]`);
      push(" ".repeat(depth) + parts.join(" "));
      if (LEAF_WIDGET.has(role) || selOpts) return;
      childDepth = depth + 1;
      // A button/link's children are just its label; skip them unless they contain nested inputs.
      if (["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch"].includes(role)) {
        for (const c of children) if (containsInteractive(byId.get(c), byId)) walk(byId.get(c), childDepth);
        return;
      }
    } else if (!opts.interactiveOnly && !n.ignored) {
      if (role === "heading") {
        flushText(depth);
        push(`${" ".repeat(depth)}h${prop(n, "level") ?? ""} ${q(clip(name, maxText))}`);
        return; // heading text is its name
      } else if (STRUCTURE.has(role)) {
        flushText(depth);
        push(`${" ".repeat(depth)}[${ROLE_ALIAS[role] ?? role}${name ? " " + q(clip(name, 60)) : ""}]`);
        childDepth = depth + 1;
      } else if (role === "list" && children.length > 12) {
        flushText(depth);
        push(`${" ".repeat(depth)}[list ${children.length} items]`);
        childDepth = depth + 1;
      } else if (TEXTY.has(role) && name && !children.some((c) => byId.get(c)?.role?.value === "StaticText" && byId.get(c)?.name?.value === name)) {
        pendingText.push(name);
        if (role === "StaticText") return;
      } else if (role === "Iframe" || role === "iframe") {
        flushText(depth);
        push(`${" ".repeat(depth)}[iframe${name ? " " + q(clip(name, 40)) : ""}]`);
        childDepth = depth + 1;
      }
    }
    for (const c of children) walk(byId.get(c), childDepth);
    // Block boundary: a known block role, or a wrapper element (div) holding several pieces.
    if (BLOCK.has(role) || (role === "generic" && children.length >= 2)) flushText(childDepth);
  };

  walk(root, 0);
  flushText(0);
  const text = lines.join("\n");
  return { lines, text, nodeCount: nodes.length, emitted, estTokens: estimateTokens(text), truncated };
}

function containsInteractive(n: AXNode | undefined, byId: Map<string, AXNode>): boolean {
  if (!n) return false;
  if (INTERACTIVE.has(n.role?.value ?? "")) return true;
  return (n.childIds ?? []).some((c) => containsInteractive(byId.get(c), byId));
}

/** ~4 chars/token is a good estimate for Claude/GPT tokenizers on English + symbols. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Token cost of one screenshot in Anthropic's vision model: (w*h)/750, capped at ~1,600 for 1.15MP. */
export function screenshotTokens(w: number, h: number): number {
  return Math.min(1600, Math.ceil((w * h) / 750));
}
