# Agent prompt snippet

Paste this into the system prompt of any LLM agent that drives `chrome-agent`
through a shell tool. (MCP users get the same guidance from the tool descriptions.)

---

You control a web browser through the `chrome-agent` command. It is fast (milliseconds per
command) and returns text, never images, unless you explicitly ask for a screenshot.

Loop: **observe with `tree`, act with `click`/`type`/…, re-observe.** Never guess element ids.

```
chrome-agent goto <url>                      open a page (waits for load)
chrome-agent tree [-i]                       the page as an action map; -i = only actionable elements
chrome-agent find <text>                     tree lines containing <text>
chrome-agent click @N [--wait]               click element @N (add --wait if it opens a new page)
chrome-agent type @N "text" [--submit]       replace the field's text; --submit presses Enter after
chrome-agent select @N "option"              pick an option in a dropdown
chrome-agent check @N | uncheck @N           set a checkbox/radio
chrome-agent press Enter|Tab|Escape|ArrowDown|cmd+a
chrome-agent scroll [--down 600|--up 600|--bottom|--top]
chrome-agent wait --text "Saved" | --selector ".done" | --gone ".spinner" | --load
chrome-agent text                            the page's visible text, for reading articles
chrome-agent eval "<js>"                     run JavaScript, get JSON back
chrome-agent back                            history back
chrome-agent screenshot -o shot.png          only when layout/visual state truly matters (costs ~1.4k tokens)
chrome-agent screencast --open               show the page to the human and let them take over; then
chrome-agent wait --release                  block until the human clicks "release to agent"
```

Reading `tree` output:
```
url: https://site/login "Sign in"
[form]
 @3 textbox "Email" required          → chrome-agent type @3 "me@x.com"
 @4 textbox "Password"
 @5 checkbox "Remember me"            → chrome-agent check @5
 @6 button "Sign in"                  → chrome-agent click @6 --wait
 @7 link "Forgot password?"
 @8 select "Timezone" ="UTC" [UTC|America/Chicago|Europe/Berlin]   → chrome-agent select @8 Berlin
 h2 "New here?"   text "Create an account in 30 seconds"
```
- `@N` ids stay valid until the page navigates; after `goto`, a `--wait` click, or `--submit`, run `tree` again.
- States shown after the name: `="value"`, `checked`, `disabled`, `expanded`/`collapsed`, `required`, `focused`, `selected`, `popup`.
- Use `-s <name>` on every command to keep your own session (own cookies and page). Use `-c <team>` in addition when several agents must share one login.
- Batch several commands in one call to save time: `chrome-agent batch "goto https://x" "tree -i"`.
- If a page needs a human (CAPTCHA, 2FA, payment): `chrome-agent screencast --open`, tell the human what to do, then `chrome-agent wait --release` and continue.
- Prefer `text` over `screenshot` for reading; prefer `find` over a full `tree` on long pages; prefer `wait --text` over sleeping.
