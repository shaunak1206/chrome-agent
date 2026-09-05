/**
 * One agent session = one ephemeral BrowserContext (isolated cookies/storage,
 * disposed on detach) + one page target + one flat CDP sessionId.
 * Every command below is a thin mapping onto CDP; see docs/ARCHITECTURE.md.
 */
import { CdpClient } from "./cdp.js";
import { formatTree, NodeIdMap, type AXNode, type TreeOptions, type TreeResult } from "./tree.js";
import { parseKey } from "./keys.js";

export type WaitUntil = "none" | "commit" | "domcontentloaded" | "load" | "idle";

export interface SessionInfo {
  name: string; context: string | null; targetId: string; contextId: string; url: string; title: string;
  createdAt: number; actions: number; nodes: number; screencast: boolean; viewers: number;
}

export class Session {
  public url = "about:blank";
  public title = "";
  public actions = 0;
  public createdAt = Date.now();
  public ids = new NodeIdMap();
  public screencastActive = false;
  public viewers = 0;
  public onFrame?: (data: string, meta: any) => void;
  public releaseWaiters: (() => void)[] = [];
  private loadEpoch = 0;   // increments on every main-frame navigation
  private loadFired = false;   // Page.loadEventFired seen for the current epoch
  private dclFired = false;    // Page.domContentEventFired seen for the current epoch

  public context: string | null = null;   // shared named context, or null = private
  constructor(
    public name: string,
    private readonly cdp: CdpClient,
    public readonly contextId: string,
    public readonly targetId: string,
    public readonly sessionId: string,
    public readonly viewport: [number, number],
  ) {}

  /** Create context + target + attach + enable the 3 domains we need. */
  static async create(cdp: CdpClient, name: string, viewport: [number, number] = [1280, 800], existingContextId?: string): Promise<Session> {
    const browserContextId = existingContextId ?? (await cdp.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId, width: viewport[0], height: viewport[1], background: true });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const s = new Session(name, cdp, browserContextId, targetId, sessionId, viewport);
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Accessibility.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId),
      cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId),
    ]);
    cdp.on(`${sessionId}:Page.frameNavigated`, (p: any) => {
      if (!p.frame.parentId) { s.url = p.frame.url; s.ids.reset(); s.loadEpoch++; s.loadFired = false; s.dclFired = false; }
    });
    cdp.on(`${sessionId}:Page.loadEventFired`, () => { s.loadFired = true; });
    cdp.on(`${sessionId}:Page.domContentEventFired`, () => { s.dclFired = true; });
    cdp.on(`${sessionId}:Page.screencastFrame`, async (p: any) => {
      s.onFrame?.(p.data, p.metadata);
      try { await cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sessionId); } catch {}
    });
    cdp.on(`${sessionId}:Page.javascriptDialogOpening`, (p: any) => {
      // Never let a dialog block an agent; accept prompts with empty text.
      cdp.send("Page.handleJavaScriptDialog", { accept: true, promptText: "" }, sessionId).catch(() => {});
    });
    return s;
  }

  private send<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  async info(): Promise<SessionInfo> {
    return { name: this.name, context: this.context, targetId: this.targetId, contextId: this.contextId, url: this.url, title: this.title, createdAt: this.createdAt, actions: this.actions, nodes: this.ids.size, screencast: this.screencastActive, viewers: this.viewers };
  }

  // ---------------------------------------------------------------- navigation
  async goto(url: string, wait: WaitUntil = "load", timeoutMs = 20000) {
    this.actions++;
    if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
    const loadP = wait === "none" || wait === "commit" ? null : this.waitForLoad(wait, timeoutMs);
    const r = await this.send("Page.navigate", { url });
    if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
    if (loadP) await loadP;
    await this.refreshTitle();
    return { url: this.url, title: this.title };
  }

  private waitForLoad(wait: WaitUntil, timeoutMs: number): Promise<void> {
    const ev = wait === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
    const p = this.cdp.waitFor(ev, { sessionId: this.sessionId, timeoutMs }).then(() => {});
    if (wait !== "idle") return p;
    return p.then(() => this.cdp.waitFor("Page.lifecycleEvent", { sessionId: this.sessionId, timeoutMs, filter: (e: any) => e.name === "networkIdle" }).then(() => {}));
  }

  async back() { return this.history(-1); }
  async forward() { return this.history(1); }
  private async history(delta: number) {
    this.actions++;
    const { currentIndex, entries } = await this.send("Page.getNavigationHistory");
    const e = entries[currentIndex + delta];
    if (!e) throw new Error("no history entry in that direction");
    const loadP = this.cdp.waitFor("Page.loadEventFired", { sessionId: this.sessionId, timeoutMs: 15000 }).catch(() => {});
    await this.send("Page.navigateToHistoryEntry", { entryId: e.id });
    await loadP;
    await this.refreshTitle();
    return { url: this.url, title: this.title };
  }

  async reload() {
    this.actions++;
    const loadP = this.cdp.waitFor("Page.loadEventFired", { sessionId: this.sessionId, timeoutMs: 15000 }).catch(() => {});
    await this.send("Page.reload");
    await loadP;
    await this.refreshTitle();
    return { url: this.url, title: this.title };
  }

  private async refreshTitle() {
    try {
      const r = await this.send("Runtime.evaluate", { expression: "[document.title, location.href]", returnByValue: true });
      this.title = r.result.value[0]; this.url = r.result.value[1];
    } catch {}
  }

  // ---------------------------------------------------------------- reading
  async tree(opts: TreeOptions = {}): Promise<TreeResult> {
    this.actions++;
    const [{ nodes }] = await Promise.all([this.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree"), this.refreshTitle()]);
    return formatTree(nodes, this.ids, this.url, this.title, opts);
  }

  async find(query: string, opts: TreeOptions = {}): Promise<TreeResult> {
    return this.tree({ ...opts, filter: query });
  }

  async text(maxChars = 20000): Promise<string> {
    this.actions++;
    const r = await this.send("Runtime.evaluate", { expression: "(document.body?.innerText ?? '').replace(/\\n{3,}/g,'\\n\\n')", returnByValue: true });
    const t: string = r.result.value ?? "";
    return t.length > maxChars ? t.slice(0, maxChars) + `\n…[${t.length - maxChars} more chars]` : t;
  }

  async eval(expression: string): Promise<any> {
    this.actions++;
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value ?? (r.result.description ?? null);
  }

  async screenshot(opts: { format?: "png" | "jpeg"; quality?: number; fullPage?: boolean; clip?: any } = {}): Promise<Buffer> {
    this.actions++;
    const params: any = { format: opts.format ?? "png", captureBeyondViewport: !!opts.fullPage };
    if (opts.format === "jpeg") params.quality = opts.quality ?? 70;
    if (opts.clip) params.clip = opts.clip;
    const { data } = await this.send("Page.captureScreenshot", params);
    return Buffer.from(data, "base64");
  }

  // ---------------------------------------------------------------- resolving @ids
  private async backend(ref: string | number): Promise<number> {
    const id = typeof ref === "number" ? ref : Number(String(ref).replace(/^@/, ""));
    let b = this.ids.backendFor(id);
    if (b === undefined) {
      // Fresh document (ids reset on navigation) or a node that appeared since the last `tree`
      // (a dialog that just opened): rebuild the map silently once, then retry. Ids are append-only, so existing ones are unaffected.
      const { nodes } = await this.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
      formatTree(nodes, this.ids, this.url, this.title, {});
      b = this.ids.backendFor(id);
    }
    if (b === undefined) throw new Error(`unknown node @${id}; run 'tree' to refresh ids (they reset on navigation)`);
    return b;
  }

  /** Resolve a css selector to a backendNodeId (agents may use selectors instead of @ids). */
  private async backendFromSelector(sel: string): Promise<number> {
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
    if (!nodeId) throw new Error(`no element matches selector ${sel}`);
    const { node } = await this.send("DOM.describeNode", { nodeId });
    return node.backendNodeId;
  }

  private async resolveTarget(ref: string): Promise<number> {
    return ref.startsWith("@") || /^\d+$/.test(ref) ? this.backend(ref) : this.backendFromSelector(ref);
  }

  private async centerOf(backendNodeId: number): Promise<{ x: number; y: number } | null> {
    try { await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }); } catch {}
    try {
      const { quads } = await this.send("DOM.getContentQuads", { backendNodeId });
      const qd = quads?.find((q: number[]) => Math.abs((q[2] - q[0]) * (q[5] - q[1])) > 0) ?? quads?.[0];
      if (!qd) return null;
      const xs = [qd[0], qd[2], qd[4], qd[6]], ys = [qd[1], qd[3], qd[5], qd[7]];
      const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2;
      // Clamp into viewport so the event actually lands.
      return { x: Math.max(1, Math.min(this.viewport[0] - 1, x)), y: Math.max(1, Math.min(this.viewport[1] - 1, y)) };
    } catch { return null; }
  }

  private async callOn(backendNodeId: number, fn: string, args: any[] = []): Promise<any> {
    const { object } = await this.send("DOM.resolveNode", { backendNodeId });
    const r = await this.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  // ---------------------------------------------------------------- actions
  async click(ref: string, opts: { button?: "left" | "right" | "middle"; count?: number; js?: boolean; wait?: WaitUntil } = {}) {
    this.actions++;
    const b = await this.resolveTarget(ref);
    const epochBefore = this.loadEpoch;
    if (opts.js) {
      await this.callOn(b, "function(){ this.scrollIntoView({block:'center'}); this.click(); }");
    } else {
      const c = await this.centerOf(b);
      if (!c) {
        await this.callOn(b, "function(){ this.click(); }");   // zero-size / off-layout node
      } else {
        const button = opts.button ?? "left";
        const count = opts.count ?? 1;
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
        for (let i = 1; i <= count; i++) {
          await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button, clickCount: i });
          await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button, clickCount: i });
        }
      }
    }
    if (opts.wait && opts.wait !== "none") await this.settle(epochBefore, opts.wait);
    return { clicked: ref, ...this.ids.describe(Number(ref.replace(/^@/, ""))) };
  }

  /** After a click, if a navigation started, wait for it; otherwise return immediately. */
  private async settle(epochBefore: number, wait: WaitUntil) {
    const started = await new Promise<boolean>((res) => {
      if (this.loadEpoch !== epochBefore) return res(true);
      const t = setTimeout(() => res(this.loadEpoch !== epochBefore), 120);
      this.cdp.once(`${this.sessionId}:Page.frameStartedLoading`, () => { clearTimeout(t); res(true); });
    });
    if (started) {
      const w = wait === "commit" ? "domcontentloaded" : wait;
      // A fast local page can commit AND finish loading before the click's input ack arrives; don't wait for an event that already fired.
      const alreadyDone = this.loadEpoch !== epochBefore && (w === "domcontentloaded" ? this.dclFired : this.loadFired) && w !== "idle";
      if (!alreadyDone) await this.waitForLoad(w, 15000).catch(() => {});
    }
    await this.refreshTitle();
  }

  async hover(ref: string) {
    this.actions++;
    const c = await this.centerOf(await this.resolveTarget(ref));
    if (!c) throw new Error("node has no box");
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
    return { hovered: ref };
  }

  async focus(ref: string) {
    this.actions++;
    await this.send("DOM.focus", { backendNodeId: await this.resolveTarget(ref) });
    return { focused: ref };
  }

  /** Type into a node. Default: focus, clear, Input.insertText (one round trip regardless of length). */
  async type(ref: string, text: string, opts: { clear?: boolean; submit?: boolean; keys?: boolean; delayMs?: number } = {}) {
    this.actions++;
    const b = await this.resolveTarget(ref);
    await this.send("DOM.focus", { backendNodeId: b });
    if (opts.clear !== false) {
      await this.callOn(b, `function(){
        if ('value' in this && typeof this.select === 'function') { this.select(); }
        else if (this.isContentEditable) { const r=document.createRange(); r.selectNodeContents(this); const s=getSelection(); s.removeAllRanges(); s.addRange(r); }
      }`);
      // Deleting the selection via a key event fires the same input events a human would.
      await this.press("Backspace");
    }
    if (opts.keys) {
      for (const ch of text) {
        await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      }
    } else {
      await this.send("Input.insertText", { text });
    }
    if (opts.submit) await this.press("Enter");
    return { typed: text.length, into: ref };
  }

  async press(spec: string, opts: { wait?: WaitUntil } = {}) {
    this.actions++;
    const k = parseKey(spec);
    const epochBefore = this.loadEpoch;
    const base: any = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
    if (k.modifiers & 4) base.commands = k.key.toLowerCase() === "a" ? ["selectAll"] : undefined;
    await this.send("Input.dispatchKeyEvent", { ...base, type: k.text ? "keyDown" : "rawKeyDown", text: k.text, unmodifiedText: k.text });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    if (opts.wait && opts.wait !== "none") await this.settle(epochBefore, opts.wait);
    return { pressed: spec };
  }

  async select(ref: string, value: string) {
    this.actions++;
    const b = await this.resolveTarget(ref);
    const picked = await this.callOn(b, `function(v){
      const opts=[...this.options]; const o=opts.find(o=>o.value===v)||opts.find(o=>o.text.trim()===v)||opts.find(o=>o.text.trim().toLowerCase().includes(v.toLowerCase()));
      if(!o) return null; this.value=o.value; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return o.text.trim(); }`, [value]);
    if (picked === null) throw new Error(`no option matching ${JSON.stringify(value)}`);
    return { selected: picked };
  }

  async check(ref: string, state = true) {
    this.actions++;
    const b = await this.resolveTarget(ref);
    const changed = await this.callOn(b, `function(s){ if(this.checked===s) return false; this.click(); return this.checked===s; }`, [state]);
    return { ref, checked: state, changed };
  }

  async scroll(opts: { ref?: string; dy?: number; dx?: number; to?: "top" | "bottom" }) {
    this.actions++;
    if (opts.to) { await this.eval(`window.scrollTo(0, ${opts.to === "top" ? 0 : "document.documentElement.scrollHeight"})`); return { scrolled: opts.to }; }
    const c = opts.ref ? await this.centerOf(await this.resolveTarget(opts.ref)) : { x: this.viewport[0] / 2, y: this.viewport[1] / 2 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: c!.x, y: c!.y, deltaX: opts.dx ?? 0, deltaY: opts.dy ?? 600 });
    // Wheel scrolls are applied by the compositor on the next frame; wait for it so a following read sees the new position.
    await this.send("Runtime.evaluate", { expression: "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))", awaitPromise: true });
    return { scrolled: { dx: opts.dx ?? 0, dy: opts.dy ?? 600 }, scrollY: (await this.send("Runtime.evaluate", { expression: "scrollY", returnByValue: true })).result.value };
  }

  async setViewport(w: number, h: number, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    (this.viewport as any)[0] = w; (this.viewport as any)[1] = h;
    return { viewport: [w, h] };
  }

  // ---------------------------------------------------------------- waiting
  async wait(opts: { ms?: number; text?: string; selector?: string; load?: WaitUntil; gone?: string; release?: boolean; timeoutMs?: number }) {
    this.actions++;
    const timeout = opts.timeoutMs ?? 15000;
    const t0 = Date.now();
    if (opts.release) { await new Promise<void>((res) => this.releaseWaiters.push(res)); return { released: true, ms: Date.now() - t0 }; }
    if (opts.load) { await this.waitForLoad(opts.load, timeout).catch(() => {}); return { loaded: true, ms: Date.now() - t0 }; }
    if (opts.ms) { await new Promise((r) => setTimeout(r, opts.ms)); return { waited: opts.ms }; }
    const expr = opts.text ? `document.body.innerText.includes(${JSON.stringify(opts.text)})`
      : opts.selector ? `!!document.querySelector(${JSON.stringify(opts.selector)})`
      : opts.gone ? `!document.querySelector(${JSON.stringify(opts.gone)})` : null;
    if (!expr) throw new Error("wait needs --ms, --text, --selector, --gone, --load or --release");
    while (Date.now() - t0 < timeout) {
      try { if (await this.eval(expr)) return { found: true, ms: Date.now() - t0 }; } catch {}
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timeout after ${timeout}ms waiting for ${opts.text ?? opts.selector ?? opts.gone}`);
  }

  // ---------------------------------------------------------------- mirror
  async startScreencast(opts: { quality?: number; maxWidth?: number; maxHeight?: number; everyNth?: number } = {}) {
    if (this.screencastActive) return;
    await this.send("Page.startScreencast", { format: "jpeg", quality: opts.quality ?? 60, maxWidth: opts.maxWidth ?? this.viewport[0], maxHeight: opts.maxHeight ?? this.viewport[1], everyNthFrame: opts.everyNth ?? 1 });
    this.screencastActive = true;
  }
  async stopScreencast() {
    if (!this.screencastActive) return;
    await this.send("Page.stopScreencast").catch(() => {});
    this.screencastActive = false;
  }
  /** Raw input passthrough used by the human mirror. */
  async rawInput(ev: any) {
    if (ev.kind === "mouse") return this.send("Input.dispatchMouseEvent", { type: ev.type, x: ev.x, y: ev.y, button: ev.button ?? "none", clickCount: ev.clickCount ?? 0, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: ev.modifiers ?? 0 });
    if (ev.kind === "key") return this.send("Input.dispatchKeyEvent", { type: ev.type, key: ev.key, code: ev.code, text: ev.text, unmodifiedText: ev.text, windowsVirtualKeyCode: ev.keyCode, nativeVirtualKeyCode: ev.keyCode, modifiers: ev.modifiers ?? 0, commands: ev.commands });
    if (ev.kind === "insert") return this.send("Input.insertText", { text: ev.text });
  }

  /** Close the page; dispose the context too unless it is shared and still in use. */
  async close(disposeContext = true) {
    await this.stopScreencast();
    try { await this.cdp.send("Target.closeTarget", { targetId: this.targetId }); } catch {}
    if (disposeContext) { try { await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId }); } catch {} }
  }
}
