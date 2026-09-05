/**
 * Human mirror: a zero-dependency HTTP server that streams Page.screencastFrame
 * JPEGs to a browser tab over Server-Sent Events and forwards the human's mouse
 * and keyboard back into the session over CDP Input.* — the page the agent is
 * driving, pixel for pixel, with no interruption to the agent's session.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Session } from "./session.js";

export class Mirror {
  private server?: Server;
  private viewers = new Map<string, Set<ServerResponse>>();
  public port = 0;

  constructor(private sessions: () => Map<string, Session>) {}

  async listen(port: number): Promise<number> {
    if (this.server) return this.port;
    this.server = createServer((req, res) => this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }));
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as any).port;
    return this.port;
  }

  attach(s: Session) {
    s.onFrame = (data, meta) => {
      const set = this.viewers.get(s.name);
      if (!set?.size) return;
      const line = `data: ${JSON.stringify({ f: data, m: meta })}\n\n`;
      for (const r of set) r.write(line);
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? "/", "http://x");
    const name = u.searchParams.get("s") ?? "";
    const s = this.sessions().get(name);
    if (u.pathname === "/") { res.setHeader("content-type", "text/html"); res.end(indexHtml([...this.sessions().keys()])); return; }
    if (u.pathname === "/view") { res.setHeader("content-type", "text/html"); res.end(viewerHtml(name)); return; }
    if (!s) { res.statusCode = 404; res.end("no such session"); return; }
    if (u.pathname === "/frames") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (!this.viewers.has(name)) this.viewers.set(name, new Set());
      this.viewers.get(name)!.add(res);
      s.viewers = this.viewers.get(name)!.size;
      this.attach(s);
      await s.startScreencast();
      req.on("close", () => { this.viewers.get(name)?.delete(res); s.viewers = this.viewers.get(name)?.size ?? 0; if (!s.viewers) s.stopScreencast().catch(() => {}); });
      return;
    }
    if (u.pathname === "/input" && req.method === "POST") {
      const body = await readBody(req);
      for (const ev of JSON.parse(body)) await s.rawInput(ev).catch(() => {});
      res.end("ok"); return;
    }
    if (u.pathname === "/release" && req.method === "POST") {
      const w = s.releaseWaiters.splice(0); for (const fn of w) fn();
      res.end(String(w.length)); return;
    }
    if (u.pathname === "/goto" && req.method === "POST") {
      const { url } = JSON.parse(await readBody(req));
      await s.goto(url, "load").catch(() => {});
      res.end("ok"); return;
    }
    res.statusCode = 404; res.end();
  }

  close() { this.server?.close(); this.server = undefined; }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });
}

function indexHtml(names: string[]) {
  return `<!doctype html><title>chrome-agent mirror</title><body style="font:14px system-ui;padding:24px;background:#111;color:#eee">
<h2>chrome-agent sessions</h2>${names.length ? "<ul>" + names.map((n) => `<li><a style="color:#8cf" href="/view?s=${encodeURIComponent(n)}">${n}</a></li>`).join("") + "</ul>" : "<p>no sessions yet</p>"}
<p style="color:#888">Open a session to watch it live and take over with mouse/keyboard. The agent keeps running.</p></body>`;
}

function viewerHtml(name: string) {
  return `<!doctype html><title>mirror: ${name}</title>
<style>body{margin:0;background:#111;color:#ddd;font:12px system-ui;display:flex;flex-direction:column;height:100vh}
#bar{display:flex;gap:8px;align-items:center;padding:6px 10px;background:#1c1c1c}#bar input{flex:1;background:#000;color:#eee;border:1px solid #333;padding:4px 8px;font:12px monospace}
button{background:#2b2b2b;color:#eee;border:1px solid #444;padding:4px 10px;cursor:pointer}button.on{background:#0a5}
#wrap{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden}canvas{max-width:100%;max-height:100%;background:#000;outline:none}
#st{color:#888;font-family:monospace}</style>
<div id=bar><b>${name}</b><input id=url placeholder="url"><button id=go>go</button><button id=take>take control</button><button id=rel>release to agent</button><span id=st></span></div>
<div id=wrap><canvas id=c tabindex=0></canvas></div>
<script>
const S=${JSON.stringify(name)};const c=document.getElementById('c'),ctx=c.getContext('2d'),st=document.getElementById('st');
let meta=null,frames=0,t0=Date.now(),control=false,queue=[],flushT=null;
const es=new EventSource('/frames?s='+encodeURIComponent(S));
es.onmessage=e=>{const {f,m}=JSON.parse(e.data);meta=m;const img=new Image();img.onload=()=>{if(c.width!==img.width||c.height!==img.height){c.width=img.width;c.height=img.height}ctx.drawImage(img,0,0);frames++;st.textContent=(frames/((Date.now()-t0)/1000)).toFixed(1)+' fps '+img.width+'x'+img.height};img.src='data:image/jpeg;base64,'+f};
function send(ev){queue.push(ev);if(!flushT)flushT=setTimeout(()=>{const q=queue;queue=[];flushT=null;fetch('/input?s='+encodeURIComponent(S),{method:'POST',body:JSON.stringify(q)})},8)}
function pos(e){const r=c.getBoundingClientRect();const sx=c.width/r.width,sy=c.height/r.height;const scale=meta?(meta.deviceWidth/c.width):1;return {x:(e.clientX-r.left)*sx*scale,y:(e.clientY-r.top)*sy*scale}}
function mods(e){return (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0)}
const btn=e=>['left','middle','right'][e.button]||'left';
c.addEventListener('mousemove',e=>{if(!control)return;const p=pos(e);send({kind:'mouse',type:'mouseMoved',...p,modifiers:mods(e)})});
c.addEventListener('mousedown',e=>{if(!control)return;c.focus();const p=pos(e);send({kind:'mouse',type:'mousePressed',...p,button:btn(e),clickCount:e.detail||1,modifiers:mods(e)})});
c.addEventListener('mouseup',e=>{if(!control)return;const p=pos(e);send({kind:'mouse',type:'mouseReleased',...p,button:btn(e),clickCount:e.detail||1,modifiers:mods(e)})});
c.addEventListener('wheel',e=>{if(!control)return;e.preventDefault();const p=pos(e);send({kind:'mouse',type:'mouseWheel',...p,deltaX:e.deltaX,deltaY:e.deltaY,modifiers:mods(e)})},{passive:false});
c.addEventListener('contextmenu',e=>e.preventDefault());
const VK={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,PageUp:33,PageDown:34,' ':32};
function key(e,type){const kc=VK[e.key]??(e.key.length===1?e.key.toUpperCase().charCodeAt(0):0);const printable=e.key.length===1&&!e.metaKey&&!e.ctrlKey;const ev={kind:'key',type:type==='keydown'?(printable?'keyDown':'rawKeyDown'):'keyUp',key:e.key,code:e.code,keyCode:kc,modifiers:mods(e)};if(printable&&type==='keydown')ev.text=e.key;if(type==='keydown'&&e.metaKey&&e.key==='a')ev.commands=['selectAll'];return ev}
c.addEventListener('keydown',e=>{if(!control)return;e.preventDefault();send(key(e,'keydown'))});
c.addEventListener('keyup',e=>{if(!control)return;e.preventDefault();send(key(e,'keyup'))});
document.getElementById('take').onclick=function(){control=!control;this.classList.toggle('on',control);this.textContent=control?'controlling (click to stop)':'take control';if(control)c.focus()};
document.getElementById('rel').onclick=()=>{control=false;document.getElementById('take').classList.remove('on');document.getElementById('take').textContent='take control';fetch('/release?s='+encodeURIComponent(S),{method:'POST'})};
document.getElementById('go').onclick=()=>fetch('/goto?s='+encodeURIComponent(S),{method:'POST',body:JSON.stringify({url:document.getElementById('url').value})});
document.getElementById('url').onkeydown=e=>{if(e.key==='Enter')document.getElementById('go').click()};
</script>`;
}
