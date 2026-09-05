/**
 * Deterministic local web apps for smoke tests and the multi-agent benchmark.
 *   /calendar   login-gated calendar with a "Schedule meeting" dialog (JS app)
 *   /research   search engine + article pages with a fact to extract
 *   /settings   toggles, selects, and a save button
 * Zero deps; runs on 127.0.0.1. Pages intentionally carry realistic chrome
 * (nav, footer, sidebars) so the tree pruner has something to prune.
 */
import { createServer } from "node:http";

const page = (title: string, body: string, script = "") => `<!doctype html><html><head><meta charset=utf-8><title>${title}</title>
<style>body{font-family:system-ui;margin:0;background:#f6f7f9;color:#222}header{background:#1f2937;color:#fff;padding:12px 24px;display:flex;gap:16px;align-items:center}header a{color:#cbd5e1;text-decoration:none}main{max-width:960px;margin:24px auto;padding:0 16px}aside{float:right;width:220px;background:#fff;padding:12px;border:1px solid #e5e7eb}footer{margin-top:40px;padding:24px;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb}
button{padding:8px 14px;border:1px solid #9ca3af;background:#fff;border-radius:6px;cursor:pointer}button.primary{background:#2563eb;color:#fff;border-color:#2563eb}input,select,textarea{padding:8px;border:1px solid #9ca3af;border-radius:6px;font:inherit}
dialog{border:1px solid #9ca3af;border-radius:10px;padding:20px;min-width:360px}.ev{background:#fff;border:1px solid #e5e7eb;padding:10px;margin:6px 0;border-radius:6px}.ok{color:#15803d;font-weight:600}.result{margin:12px 0}.result a{font-size:16px}.tag{display:inline-block;background:#e0e7ff;color:#3730a3;padding:2px 8px;border-radius:10px;font-size:12px;margin-right:6px}</style></head>
<body><header><b>AgentBench</b><a href="/calendar">Calendar</a><a href="/research">Research</a><a href="/settings">Settings</a><a href="/help">Help</a><span style="flex:1"></span><a href="/logout">Sign out</a></header>
<main>${body}</main><footer>© 2026 AgentBench Inc · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/status">Status</a> · Rendered ${new Date().toISOString()}</footer>
<script>${script}</script></body></html>`;

const SIDEBAR = `<aside><h3>Quick links</h3><ul><li><a href="/calendar">Today</a></li><li><a href="/calendar?view=week">This week</a></li><li><a href="/calendar?view=month">This month</a></li><li><a href="/research">Research</a></li></ul><h3>Tips</h3><p>Use the Schedule meeting button to add events. Attendees are comma separated.</p></aside>`;

const ARTICLES = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  title: ["Transformer memory bandwidth", "Headless Chromium internals", "CDP flat sessions explained", "Token economics of screenshots", "Accessibility trees for agents", "Process-per-site tradeoffs", "Latency budgets for tool calls", "Browser contexts and isolation"][i % 8] + ` (part ${Math.floor(i / 8) + 1})`,
  fact: `FACT-${(i * 7919) % 10007}`,
  tags: ["browsers", "agents", "perf", "cdp", "llm"].filter((_, j) => (i + j) % 3 === 0),
  body: Array.from({ length: 6 }, (_, p) => `<p>Paragraph ${p + 1} of article ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>`).join(""),
}));

const routes: Record<string, (u: URL, req: any) => string> = {
  "/": () => page("AgentBench", `<h1>AgentBench</h1><p>Test apps for chrome-agent.</p><ul><li><a href="/calendar">Calendar app</a></li><li><a href="/research">Research site</a></li><li><a href="/settings">Settings form</a></li></ul>`),
  "/login": (u) => page("Sign in", `<h1>Sign in</h1><form method=get action="/calendar"><input type=hidden name=auth value=1><input type=hidden name=next value="${u.searchParams.get("next") ?? "/calendar"}"><p><label>Email <input name=email type=email placeholder="you@example.com" required></label></p><p><label>Password <input name=password type=password required></label></p><p><label><input type=checkbox name=remember> Remember me</label></p><button class=primary type=submit>Sign in</button> <a href="/forgot">Forgot password?</a></form>`),
  "/calendar": (u) => {
    if (!u.searchParams.get("auth")) return page("Sign in required", `<h1>Sign in required</h1><p>You need to sign in to view the calendar.</p><a href="/login?next=/calendar">Go to sign in</a>`);
    const email = u.searchParams.get("email") ?? "agent@example.com";
    return page("Calendar", `${SIDEBAR}<h1>September 2026</h1><p>Signed in as <b>${email}</b></p><div><button id=sched class=primary>Schedule meeting</button> <button id=today>Today</button> <button id=prev aria-label="Previous week">‹</button> <button id=next aria-label="Next week">›</button> <input id=q type=search placeholder="Search events" aria-label="Search events"></div>
<h2>Upcoming</h2><div id=list><div class=ev><span class=tag>work</span>Standup · Mon 9:00 · 4 attendees</div><div class=ev><span class=tag>work</span>Design review · Tue 14:00 · 6 attendees</div><div class=ev><span class=tag>personal</span>Dentist · Thu 11:30</div></div><p id=status aria-live=polite></p>
<dialog id=dlg><form method=dialog><h2>New meeting</h2><p><label>Title <input id=title name=title required placeholder="Meeting title"></label></p><p><label>Date <input id=date type=date name=date value="2026-09-10"></label></p><p><label>Time <select id=time name=time><option>09:00</option><option>10:00</option><option>11:00</option><option>14:00</option><option>15:00</option></select></label></p><p><label>Attendees <input id=att name=att placeholder="a@x.com, b@x.com"></label></p><p><label>Notes <textarea id=notes rows=2></textarea></label></p><p><label><input id=vc type=checkbox checked> Add video call</label></p><button id=cancel type=button>Cancel</button> <button id=save class=primary type=submit>Save meeting</button></form></dialog>`,
      `const dlg=document.getElementById('dlg');document.getElementById('sched').onclick=()=>{dlg.showModal();document.getElementById('title').focus()};document.getElementById('cancel').onclick=()=>dlg.close();
dlg.querySelector('form').onsubmit=()=>{const t=document.getElementById('title').value,d=document.getElementById('date').value,tm=document.getElementById('time').value,a=document.getElementById('att').value.split(',').filter(Boolean).length;const div=document.createElement('div');div.className='ev';div.innerHTML='<span class=tag>new</span>'+t+' · '+d+' '+tm+' · '+a+' attendees';document.getElementById('list').appendChild(div);document.getElementById('status').innerHTML='<span class=ok>Scheduled: '+t+' on '+d+' at '+tm+'</span>';document.getElementById('title').value='';document.getElementById('att').value=''};
document.getElementById('q').oninput=e=>{const v=e.target.value.toLowerCase();for(const el of document.querySelectorAll('.ev'))el.style.display=el.textContent.toLowerCase().includes(v)?'':'none'};
document.getElementById('today').onclick=()=>{document.getElementById('status').textContent='Jumped to today'};`);
  },
  "/research": (u) => {
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    const hits = q ? ARTICLES.filter((a) => a.title.toLowerCase().includes(q) || a.tags.includes(q)) : [];
    return page("Research", `<h1>Research</h1><form action="/research" method=get role=search><input name=q type=search placeholder="Search articles" value="${q}" aria-label="Search articles"> <button type=submit class=primary>Search</button></form>
${q ? `<p>${hits.length} results for <b>${q}</b></p>` + hits.map((a) => `<div class=result><a href="/article/${a.id}">${a.title}</a><br><small>${a.tags.map((t) => `<span class=tag>${t}</span>`).join("")} article #${a.id}</small></div>`).join("") : `<p>Try: <a href="/research?q=cdp">cdp</a>, <a href="/research?q=token">token</a>, <a href="/research?q=agents">agents</a></p>`}`);
  },
  "/settings": () => page("Settings", `<h1>Settings</h1><form id=f><p><label>Display name <input name=name value="Agent"></label></p><p><label>Timezone <select name=tz><option>UTC</option><option>America/Chicago</option><option>Europe/Berlin</option></select></label></p><p><label><input type=checkbox name=notify> Email notifications</label></p><p><label><input type=checkbox name=dark> Dark mode</label></p><p><label><input type=radio name=density value=compact> Compact</label> <label><input type=radio name=density value=comfy checked> Comfortable</label></p><button class=primary type=submit>Save</button></form><p id=saved></p>`,
    `document.getElementById('f').onsubmit=e=>{e.preventDefault();const fd=new FormData(e.target);document.getElementById('saved').innerHTML='<span class=ok>Saved: '+[...fd.entries()].map(([k,v])=>k+'='+v).join(', ')+'</span>'}`),
  "/help": () => page("Help", `<h1>Help</h1><p>Nothing to see here.</p>`),
};

export function startTestSite(port = 0): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const m = u.pathname.match(/^\/article\/(\d+)$/);
      let html: string | undefined;
      if (m) { const a = ARTICLES[Number(m[1]) - 1]; html = a && page(a.title, `<h1>${a.title}</h1><p>${a.tags.map((t) => `<span class=tag>${t}</span>`).join("")}</p>${a.body}<h2>Key fact</h2><p>The reference identifier for this article is <code id=fact>${a.fact}</code>.</p><p><a href="/research?q=${a.tags[0] ?? "cdp"}">More like this</a> · <a href="/article/${(a.id % ARTICLES.length) + 1}">Next article</a></p>`); }
      else html = routes[u.pathname]?.(u, req);
      if (!html) { res.statusCode = 404; res.end(page("Not found", "<h1>404</h1>")); return; }
      res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html);
    });
    server.listen(port, "127.0.0.1", () => resolve({ port: (server.address() as any).port, close: () => server.close() }));
  });
}

export const FACT_FOR = (id: number) => ARTICLES[id - 1]?.fact;

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startTestSite(Number(process.env.PORT ?? 4848)).then(({ port }) => console.log(`test site on http://127.0.0.1:${port}`));
}
