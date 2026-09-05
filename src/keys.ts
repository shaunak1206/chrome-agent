/** Key name -> CDP Input.dispatchKeyEvent descriptor. Supports "cmd+a", "shift+Tab", etc. */
export interface KeyDesc { key: string; code: string; keyCode: number; text?: string; modifiers: number }

const TABLE: Record<string, [code: string, keyCode: number, text?: string]> = {
  enter: ["Enter", 13, "\r"], return: ["Enter", 13, "\r"], tab: ["Tab", 9], escape: ["Escape", 27], esc: ["Escape", 27],
  backspace: ["Backspace", 8], delete: ["Delete", 46], space: ["Space", 32, " "],
  arrowup: ["ArrowUp", 38], arrowdown: ["ArrowDown", 40], arrowleft: ["ArrowLeft", 37], arrowright: ["ArrowRight", 39],
  up: ["ArrowUp", 38], down: ["ArrowDown", 40], left: ["ArrowLeft", 37], right: ["ArrowRight", 39],
  home: ["Home", 36], end: ["End", 35], pageup: ["PageUp", 33], pagedown: ["PageDown", 34],
  f1: ["F1", 112], f2: ["F2", 113], f3: ["F3", 114], f4: ["F4", 115], f5: ["F5", 116],
};
const MOD: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

export function parseKey(spec: string): KeyDesc {
  const parts = spec.split("+");
  const last = parts.pop()!;
  let modifiers = 0;
  for (const m of parts) { const bit = MOD[m.toLowerCase()]; if (bit === undefined) throw new Error(`unknown modifier ${m}`); modifiers |= bit; }
  const t = TABLE[last.toLowerCase()];
  if (t) return { key: t[0] === "Space" ? " " : t[0], code: t[0], keyCode: t[1], text: modifiers & 6 ? undefined : t[2], modifiers };
  if (last.length === 1) {
    const upper = last.toUpperCase();
    const code = /[a-z]/i.test(last) ? `Key${upper}` : /[0-9]/.test(last) ? `Digit${last}` : last;
    return { key: last, code, keyCode: upper.charCodeAt(0), text: modifiers & 6 ? undefined : last, modifiers };
  }
  throw new Error(`unknown key ${last}`);
}
