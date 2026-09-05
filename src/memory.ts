/**
 * Memory of a Chromium process tree.
 *  - rss: from ps. On macOS RSS counts the ~100MB shared Chromium framework in EVERY process, so it overstates badly.
 *  - footprint: macOS phys_footprint (what Activity Monitor shows; private + compressed, shared pages counted once). The honest number.
 *  - On Linux, footprint falls back to PSS from /proc/<pid>/smaps_rollup when readable.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ProcMem { pid: number; type: string; rssMB: number; footprintMB?: number }
export interface TreeMem { rssMB: number; footprintMB: number | null; processes: number; perProcess: ProcMem[]; byType: Record<string, { n: number; footprintMB: number; rssMB: number }> }

export function processTreeMemory(rootPid: number): TreeMem {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
  const kids = new Map<number, number[]>(); const info = new Map<number, { rss: number; cmd: string }>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); if (!m) continue;
    const pid = +m[1], ppid = +m[2];
    info.set(pid, { rss: +m[3], cmd: m[4] }); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid)!.push(pid);
  }
  const per: ProcMem[] = []; const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!; const i = info.get(p);
    if (i) { const t = p === rootPid ? "browser" : /--top-chrome-webui/.test(i.cmd) ? "webui" : (i.cmd.match(/--type=([a-z-]+)/)?.[1] ?? "other"); per.push({ pid: p, type: t, rssMB: +(i.rss / 1024).toFixed(1) }); }
    stack.push(...(kids.get(p) ?? []));
  }
  let footprintMB: number | null = null;
  if (process.platform === "darwin" && per.length) {
    try {
      const fp = execFileSync("footprint", per.map((p) => String(p.pid)), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      for (const m of fp.matchAll(/\[(\d+)\]:[^\n]*?Footprint:\s*([\d.]+)\s*(KB|MB|GB)/g)) {
        const row = per.find((p) => p.pid === Number(m[1]));
        if (row) row.footprintMB = +(Number(m[2]) * (m[3] === "GB" ? 1024 : m[3] === "KB" ? 1 / 1024 : 1)).toFixed(1);
      }
    } catch {}
  } else if (process.platform === "linux") {
    for (const row of per) { try { const s = readFileSync(`/proc/${row.pid}/smaps_rollup`, "utf8"); const m = s.match(/^Pss:\s+(\d+) kB/m); if (m) row.footprintMB = +(Number(m[1]) / 1024).toFixed(1); } catch {} }
  }
  if (per.some((p) => p.footprintMB !== undefined)) footprintMB = +per.reduce((a, b) => a + (b.footprintMB ?? 0), 0).toFixed(1);
  const byType: TreeMem["byType"] = {};
  for (const p of per) { const b = (byType[p.type] ??= { n: 0, footprintMB: 0, rssMB: 0 }); b.n++; b.footprintMB = +(b.footprintMB + (p.footprintMB ?? 0)).toFixed(1); b.rssMB = +(b.rssMB + p.rssMB).toFixed(1); }
  return { rssMB: +per.reduce((a, b) => a + b.rssMB, 0).toFixed(1), footprintMB, processes: per.length, perProcess: per, byType };
}
