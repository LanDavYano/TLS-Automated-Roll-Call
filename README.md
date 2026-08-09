# TLS Automated Roll Call

Automated Telegram roll call for **The LaSallian's** UAAP sports coverage. Every night it reads the Coverage Tracker spreadsheet, finds the next day's games, and posts one roll call message per game to the sports Telegram group — so staffers wake up already assigned.

**Author:** Lance Jardiniano, TLS65 Sports Staffer

> **Full technical spec:** [SPEC.md](SPEC.md). This README is the practical handoff — read it first. Read SPEC.md when you need the *why* behind a parsing rule.

---

## 1. What it does

- Runs **once a night, ~7:00 PM Manila time**, unattended.
- Looks at **tomorrow's** date (configurable) and finds every event on the tracker for that day — games, ceremonies, awardings, and multi-day tournament sessions alike.
- Posts a formatted roll call: opponents by category, title, time, venue, assigned Recap/Livetweet staffers (resolved to Telegram handles), deliverables, and reminders.
- **Collates where it should.** Sports whose categories play as one block — Fencing, Athletics, Golf, 3x3, Chess — get one roll call for the whole day instead of one per bout. Sports where each game stands alone get one per game. You choose per sport with `/rollsetup <sport> session`.
- **Routes each roll call to its sport's own Telegram group** (Basketball, Football, …) — specifically into that group's **Roll Call** topic — so nothing gets collated into one messy chat.
- **Onboards new groups from inside Telegram.** Add the bot to a sport's GC, open its Roll Call topic, type `/rollsetup` — it works out the sport from the group's name, checks that sport exists in the tracker, and wires it up. No IDs to copy. See §7.2.
- **Pushes on demand.** `/rollcall` posts a GC's next roll call immediately and marks it done, so the nightly run skips it. No double posts.
- **Never double-posts** — it keeps a log and skips anything already sent.
- **Fails loudly** — if something breaks, it sends an error message to the admin chat instead of failing silently. A nightly report follows only when something needs a human.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Google Apps Script** (V8), *bound* to the Coverage Tracker spreadsheet | Runs unattended for years with no server, no hosting bill, no credentials file. Handoff = transferring ownership of the spreadsheet. |
| Language | JavaScript (Apps Script flavor) | — |
| Scheduling | Apps Script **time-driven trigger** | Built in; no cron server needed. |
| Commands | Apps Script **Web App** + Telegram **webhook** (`doPost`) | Lets the bot be set up and driven from inside Telegram — no spreadsheet, no editor. Same platform, so still no server. |
| Messaging | **Telegram Bot API** via `UrlFetchApp` | Free, simple, group-friendly. |
| Data source | The Google Sheet itself (month tabs + `Config` + `Staffers`) | Non-coders edit data directly. |
| Local dev | **clasp** (pushes local files → Apps Script) + **git/GitHub** (source history) | See §9. |

**Important:** `clasp push` sends code to Apps Script. `git push` sends it to GitHub. They are **separate** — Apps Script does **not** read from GitHub. Deployment is always `clasp push`.

---

## 3. How it works (data flow)

```
Nightly trigger → main()
  → getConfig()            read the Config tab (DRY_RUN, LEAD_DAYS, season, …)
  → computeTargetDate_()   "tomorrow" in Asia/Manila
  → readMonthRows_()       read that month's tab (rows 5+)
  → parseMonthEvents()     forward-fill dates/venues/times, parse names, deliverables, staffers
  → filterEventsForDate_() keep only events on the target date
  → groupEventsForSending_ route each event, then collate per the sport's Mode
  → for each message:
      findPriorSend_()     already posted (either mode)? → skip
      renderDigest_()      build the message text
      sendTelegramMessage_ post to the group's Roll Call topic (unless DRY_RUN)
      logStatus_(SENT)     record it in the _log tab
```

Any exception is caught, logged to `_log` as `ERROR`, and pushed to Telegram as an alert. One bad row can't kill the whole run — each game is guarded individually. After the run, `reportRun_()` messages the admin chat **only if something needs a human** (unmapped sport, unassigned staffer, failed event) — see `SUMMARY_MODE` in §7.

Commands take a second path into the same code:

```
Telegram → webhook POST → doPost()
  → handleUpdate_()        validate, strip @botname, route on the command
  → handleSetup_()         read the sports in the tracker, write the Groups row
  → handleRollcall_()      find the next game for this GC → send → log SENT
  → sendReply_()           answer in the topic it was typed in
```

---

## 4. Repository layout

```
TLS-Automated-Roll-Call/
├── README.md              ← this file (handoff)
├── SPEC.md                ← full technical specification
├── tests/
│   └── parser.test.js     Node fixture tests — `node tests/parser.test.js`
│                          ⚠️ MUST stay outside apps-script/ — see §9
└── apps-script/           ← the deployed code (clasp-managed)
    ├── .clasp.json          links this folder to the Apps Script project (scriptId)
    ├── appsscript.json      project manifest (timezone = Asia/Manila, V8)
    ├── Main.js              entry point, nightly run, admin report, test helpers
    ├── Config.js            Config tab reader + setupConfigTab()
    ├── Staffers.js          Staffers tab reader (name → handle)
    ├── Groups.js            per-sport routing, Groups tab read/write, sport-name matching
    ├── Season.js            cross-month reads: "what's the next Football game?"
    ├── Sheets.js            sheet/timezone access helpers
    ├── Parser.js            all parsing rules (dates, names, times, deliverables)
    ├── Template.js          message rendering + HTML escaping
    ├── Telegram.js          Telegram send/reply, admin check, error notify
    ├── Webhook.js           doPost, command routing, webhook setup helpers
    ├── Commands.js          /rollsetup, /rollcall, /next, /rollwhere, /groups, /unmap
    └── Log.js               _log tab: idempotency ledger + error trail
```

---

## 5. The spreadsheet

The script is bound to the **Coverage Tracker** Google Sheet, and by default reads that one. The `SPREADSHEET_ID` script property can point it at **any** tracker instead — that's how one script serves a new season's sheet without being copied (§8.1). Either way it uses these tabs, in whichever spreadsheet it's reading:

### Month tabs (`September`, `October`, …)
- Named **exactly** the English month, **no year**. This naming is load-bearing — don't rename them.
- Data starts at **row 5** (rows 1–4 are headers).
- Key columns, **on a tracker whose Date block starts at B** (`DATA_START_COLUMN = B`): **B** day, **C** weekday, **D** time, **E** event name (`Sport: DLSU vs OPPONENT`), **F** venue, **G–O** deliverable flags, **P** photo (ignored), **Q** Recap staffers, **R** Livetweet staffers.
- Those positions are **relative to the Date block**, not absolute. A tracker without the spacer column in A sets `DATA_START_COLUMN = A` and every column above shifts one to the left — no code change. Run `testLayout()` to see exactly which column each field resolved to. This is what lets one script read trackers built by different editors.
- **Every row with an event name gets a roll call.** Games, ceremonies, awardings, press conferences, and tournament days (`Fencing Day 1`, `Golf Day 2`) all count. The `Game day` column is **not** used — in the live tracker it reads `No` on most real games.
- Nothing is silently dropped: an event whose name matches no `Groups` keyword goes to the **admin chat** with a warning, so you see it rather than losing it.

### `Config` tab
Key/Value pairs the bot reads live on every run. Run `setupConfigTab()` once to create and populate it with descriptions. See §7 for what each key does.

### `Staffers` tab
`Name | Handle`, one per row (row 1 is the header). Names must match what's typed in columns Q/R (case-insensitive, whitespace-trimmed). Add staffers by adding rows — no code change. See §7.

### `Groups` tab
`Sport keyword(s) | Chat ID | Thread ID | Notes | Group title | Last updated | Active | Mode`. Maps each sport to the Telegram group + Roll Call topic its roll calls post to, and how many messages a day makes. **Normally you never touch this tab** — `/rollsetup` writes it from inside Telegram (§7.2). Hand-editing still works; it's read live on every run. See §7.1.

### `_log` tab (hidden, auto-created)
`Timestamp | EventKey | Status | Detail`. Statuses: `SENT`, `SKIPPED_DUPLICATE`, `SKIPPED_MODE_CHANGED`, `DRY_RUN`, `ERROR`. One row per **message**, not per sheet row — a session-mode sport logs one entry covering its whole day. This is the idempotency ledger and the error trail — check it first when debugging.

### Script Properties (NOT a tab)
These live in **Project Settings → Script Properties** — the credentials because they must not be visible to spreadsheet editors, and `SPREADSHEET_ID` because it decides *which* spreadsheet is read and so can't be stored in one. They are shared across every season:

| Key | Required? | Value |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | the bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | yes | the **admin chat** ID (negative for groups) — where errors, the nightly report, and any unmapped roll call go |
| `WEB_APP_URL` | for commands | the deployment's `/exec` URL (§9.1) |
| `WEBHOOK_SECRET` | strongly advised | any random string; keeps strangers from POSTing fake commands to the public `/exec` URL (§9.1) |
| `SPREADSHEET_ID` | ⭐ per season | **Which spreadsheet the bot reads.** Paste the tracker's URL (or its ID). Overrides the sheet the script is bound to, in every context — nightly run, commands, editor. Leave it unset to read the bound sheet. See §8.1. |
| `BOT_USERNAME` | optional | e.g. `SportsRollCall_bot`. Saves a `getMe` call when someone types a `@botname` suffix. Looked up and cached automatically if unset. |

---

## 6. Everyday operations (the knobs a non-coder can turn)

All of these are **data edits** — no code, no `clasp`, no redeploy. They take effect on the next run because the bot reads the Config/Staffers tabs live.

| I want to… | Do this |
|---|---|
| **Pause the bot** | Config tab → set `DRY_RUN` to `TRUE`. It will log but never post. Set back to `FALSE` to resume. |
| **Add / change a staffer** | Staffers tab → add or edit a `Name | Handle` row. The name must match what's typed in the Recap/Livetweet columns. |
| **Add a sport / wire up a new GC** | In Telegram: add the bot to the GC, open its **Roll Call** topic, type `/rollsetup`. See §7.2. |
| **Post a roll call right now** | In the GC: `/rollcall`. It posts the next upcoming game and marks it done. |
| **Check what's coming** | In the GC: `/next` (preview, sends nothing) or `/groups` (what's mapped, what isn't). |
| **Stop a GC receiving roll calls** | In the GC: `/unmap`. Reversible — it sets `Active = FALSE`, it doesn't delete. |
| **Look further ahead** | Config tab → change `LEAD_DAYS` (1 = tomorrow, 2 = two days out, …). |
| **Change the send time** | Apps Script editor → **Triggers** (alarm-clock icon) → edit the `main` trigger's time. |
| **⭐ Start a new season** | Point the bot at the new season's spreadsheet, then set `SEASON_NUMBER` / `SEASON_START_YEAR` in **its** Config tab. **This is the annual task — see §8.** |
| **Point the bot at a different spreadsheet** | Script Properties → set `SPREADSHEET_ID` to that sheet's URL. Takes effect on the next run; no code change, no redeploy. Clear it to go back to the bound sheet. See §8.1. |
| **Check which spreadsheet it's reading** | In any mapped GC: `/whereami`. The `Tracker:` line names the file and says whether it came from `SPREADSHEET_ID` or the bound sheet. |
| **Merge a sport's daily events into one roll call** | Run `/rollsetup <sport> session` in its GC. Use it for sports where the categories play as one block — Fencing, Athletics, Golf, 3x3, Chess. `/rollsetup <sport> event` undoes it. |
| **Map a GC covering sports with no shared word** | `/rollsetup esports, valorant, nba2k` — one rule, several keywords. |
| **Set up a GC before its month tab is filled in** | `/rollsetup <sport> force` — skips the "nothing in the tracker matches" guard. |

---

## 7. Config keys reference

| Key | Example | Purpose |
|---|---|---|
| `SEASON_NUMBER` | `88` | The UAAP season number, printed in every roll call's title line ("UAAP Season 88 Fencing Tournament"). **Update each season.** |
| `SEASON_START_YEAR` | `2025` | The calendar year the season's opening month falls in. **Update each season.** |
| `SEASON_START_MONTH` | `9` | Month number the season begins (9 = September). Month tabs `≥` this belong to `SEASON_START_YEAR`; earlier months roll to the next year. |
| `DRY_RUN` | `FALSE` | `TRUE` = log only, never post. `FALSE` = live. Also the pause switch. |
| `LEAD_DAYS` | `1` | How many days ahead to look. `1` = announce tomorrow's games tonight. |
| `SHOW_UNASSIGNED_WARNING` | `TRUE` | `TRUE` = show a ⚠️ UNASSIGNED line when a Recap/Livetweet cell is blank **and that deliverable is flagged `Yes`**. A blank cell on a `No`-flagged game drops the line instead of warning. |
| `SUMMARY_MODE` | `ATTENTION` | Nightly report to the admin chat. `ATTENTION` = only when something needs a human (a sport with no GC, a blank staffer cell on a game that wants that deliverable, a failed event). `ALWAYS` = every night. `NEVER` = errors only. |
| `DATA_START_COLUMN` | `B` | **Column letter where the Date block starts** — the column holding the day number. `B` on trackers with a spacer column in A; `A` on trackers without one. Every other column is located relative to it, so this one letter describes the whole layout. Run `testLayout()` after changing it. |

Only these seven keys are read. Values are validated with fallbacks, so a typo (e.g. `DRY_RUN = maybe`) silently reverts to the safe default rather than crashing.

### 7.1 The `Groups` tab (per-sport routing)

Each sport has its own Telegram group, and roll calls post into that group's **Roll Call** topic. The `Groups` tab tells the bot where each sport goes:

| Sport keyword(s) | Chat ID | Thread ID (Roll Call topic) | Notes | … | Mode |
|---|---|---|---|---|---|
| `3x3` | `-100…` | `12` | Men's + Women's play as one block | | `session` |
| `Basketball` | `-100…` | `12` | covers Men's and Women's | | `event` |
| `fencing` | `-100…` | `9` | | | `session` |
| `esports, valorant, nba2k` | `-100…` | `17` | three titles, one GC | | `event` |

How it works:
- **Matching:** for each event, the bot finds the first row whose keyword appears in the event name (case-insensitive). `Basketball` matches `R1 Men's Basketball` and `R1 Women's Basketball`.
- **Column A takes a list.** `esports, valorant, nba2k` is one rule with three keywords. You need this whenever a GC's sports share no common word — `esports` is nowhere inside `VALORANT`, and `baseball` is nowhere inside `Women's Softball`. A single keyword is just a list of one.
- **Row order = priority.** A sub-variant needing its own row — because it collates differently (`3x3`, `blitz chess`) or posts elsewhere — goes **above** the general row. `/rollsetup` works this out for you.
- **Mode = how many messages a day makes.** `event` (the default) = one roll call per game. `session` = one roll call per day covering every category, for sports that play as a block: Fencing, Athletics, Golf, 3x3, Chess. Set it with `/rollsetup fencing session`.
- **Chat ID vs Thread ID:** the Chat ID is the whole group; the Thread ID picks the topic (tab) within it. Every topic in the same group shares one Chat ID. Roll calls all go to the single Roll Call topic — the per-category topics (Men's, Women's, Beach) are for discussion. Leave Thread ID blank only for a non-forum group.
- **Unmapped event:** if no row matches, the roll call goes to the admin chat (`TELEGRAM_CHAT_ID`) with a warning appended — so it's never lost. Add a row to fix routing.

Two more columns, both written by `/rollsetup` and never read by the script: **Group title** (the GC's name when it was mapped) and **Last updated**. Column **Active** is the off switch — `FALSE` retires a row without deleting it, and **blank counts as active** so older hand-written rows keep working.

**You should not need to fill this tab by hand.** `/rollsetup` writes it, gets the row order right, and refuses keywords that don't exist in the tracker. If you ever do edit it manually, run `testRouting` afterward to confirm each game still resolves to the right group and topic.

### 7.2 Onboarding a new GC (the `/rollsetup` flow)

This is the whole per-group setup, done entirely in Telegram:

1. **Add the bot to the sport's GC** and make it an **admin**. It greets the group with the sport it guessed from the group's name.
2. **Open the GC's `Roll Call` topic** — this matters, the bot maps whatever topic you type in.
3. **Type `/rollsetup`.**

It reads the chat and topic IDs off your own message, works out the sport from the group's title (`UAAP 88 Football GC` → `Football`), checks that sport actually exists in the tracker, and writes the `Groups` row. The reply confirms what it matched, how many upcoming games that covers, the next fixture, and where roll calls will land.

**If the group's name doesn't give it away**, it says so and lists the sports it found in the tracker — then run `/rollsetup Football` (or whatever keyword) explicitly.

**Wrong topic?** Just run `/rollsetup` again in the right one; the row moves rather than duplicating.

Then verify without sending anything: `/next` shows the next game and the exact message that would post. `/rollcall` posts it for real.

### 7.3 Command reference

| Command | Who can | What it does |
|---|---|---|
| `/rollsetup` | admins | Maps this topic to the sport inferred from the GC's name. |
| `/rollsetup <sport>` | admins | Same, but you name the sport (when the group title isn't obvious). |
| `/rollcall` | admins | Posts this GC's next upcoming roll call **now** and logs it as sent, so tonight's run skips it. |
| `/rollcall <sport>` | admins | Same, for another sport's GC — useful from the admin chat. |
| `/rollcall force` | admins | Overrides the "already posted" and "that game is weeks away" guards. |
| `/next` | anyone | Previews the next game and the exact roll call text. **Sends nothing, logs nothing.** |
| `/rollwhere` | anyone | Chat ID, thread ID, what this topic is mapped to, `DRY_RUN`, season, trigger status. |
| `/groups` | anyone | Every mapping in priority order, **plus sports with upcoming games and no GC yet** — the season's to-do list. |
| `/unmap` | admins | Stops roll calls routing here. Sets `Active = FALSE`; flip it back or re-run `/rollsetup` to undo. |
| `/help` | anyone | The list above, plus whether this GC is mapped. |

Notes worth knowing:

- **Admin-gated commands fail closed.** If Telegram can't confirm you're an admin, the answer is no. Anonymous admin posts don't carry a user, so they never pass — post normally.
- **`/rollcall` ignores `DRY_RUN` on purpose.** `DRY_RUN` pauses the *unattended* nightly run; you typing a command is not unattended. The reply tells you when `DRY_RUN` is still on.
- **`/rollcall` and the nightly run share one ledger.** Whichever fires first wins; the other skips. That's what stops double roll calls.
- **`/rollcall` refuses events more than 14 days out** unless you add `force` — that far ahead is nearly always the wrong GC.
- **`/rollcall` posts the whole message**, not one row. For a session-mode sport that means the entire day — posting one fencing bout and leaving the other two would be worse than not posting at all.
- **Changing a sport's mode mid-season is safe.** The ledger checks both modes' keys, so a roll call already sent is never posted twice. If it went out under the old mode, the run reports `SKIPPED_MODE_CHANGED` and asks you to look, rather than silently re-posting.
- **Why `/rollsetup` and `/rollwhere`, not `/setup` and `/whereami`?** The `/recap` bot lives in these same groups and already owns `/setup`, `/recap`, `/sports`, and `/whereami`. Telegram sends a bare command to *every* bot in a group — no bot can claim a name — so both would answer, one succeeding and one erroring. Distinct names are the fix. **Don't rename them back.** If you ever add a third bot here, check its commands against this list first.

---

## 8. ⭐ The one annual task

Each new season usually means a **new tracker spreadsheet**. Two steps: point the bot at it (§8.1), then set the season values in **that** spreadsheet's Config tab:

- `SEASON_NUMBER` → the UAAP season number (e.g. `88`). Printed in every roll call's title line.
- `SEASON_START_YEAR` → the year the season's first month falls in (e.g. `2025` for a season opening September 2025).
- `SEASON_START_MONTH` → only if the opening month changes.

**Why it matters:** the month tabs carry no year (`September`, not `September 2025`), so this is the only place the year comes from. With `SEASON_START_YEAR=2025, SEASON_START_MONTH=9`: Sep–Dec → 2025, Jan–May → 2026. Forget this and the bot computes the wrong dates and posts nothing.

If the season reuses the same spreadsheet, skip §8.1 — the Config edits above are the whole task.

### 8.1 Pointing the bot at a new spreadsheet

**Do not copy the script.** One Apps Script project serves every season; only the property below changes.

1. Script Properties (**⚙️ Project Settings → Script Properties**) → set **`SPREADSHEET_ID`** to the new tracker's URL. Pasting the whole address bar is fine — the ID is extracted from it.
2. In the Apps Script editor, run **`setupConfigTab()`** and **`setupGroupsTab()`**. They create the tabs in the newly pointed-at sheet and never overwrite existing values, so re-running is safe.
3. Check the layout: run **`testLayout()`** and read the log. If `DAY` shows a weekday name instead of a number, or `EVENT` shows the venue, set **`DATA_START_COLUMN`** in that sheet's Config tab to the column letter holding the day number and run it again.
4. Fill in the **Staffers** tab and set the season values (§8 above).
5. Re-map the GCs with **`/rollsetup`** in each one. Group mappings live in the `Groups` tab, so a new spreadsheet starts with none — `/groups` lists what's still missing.
6. Confirm with **`/whereami`** in any GC: the `Tracker:` line should name the new sheet.

**Why not copy the whole thing:** copying the spreadsheet copies the script too, but not its Script Properties and not its triggers, and each copy needs its own deployment. Worse, **a bot token can hold only one webhook** (§9.1) — the second copy's `setupWebhook()` silently steals commands from the first. One script, one deployment, one property to change.

**Things worth knowing:**

- `Config`, `Staffers`, `Groups` and `_log` are tabs **inside whichever spreadsheet is being read**, so pointing elsewhere swaps all of them at once — including `DRY_RUN`. Check the new sheet's `DRY_RUN` before expecting a live send.
- The **nightly trigger follows the property.** Left pointing at an old sheet, the 7 PM run reads the wrong tabs, finds nothing for tomorrow, and posts nothing — silently. `/whereami` is the check.
- Only Telegram credentials stay put: the token, admin chat, and webhook secret are Script Properties, shared across every season.

### 8.2 Demoing on a past season's sheet

Same mechanism, temporarily. Set `SPREADSHEET_ID` to the old sheet, add a demo row to the right month tab, then run **`testSend('YYYY-MM-DD')`** from the editor with that row's date — it runs the real send path for an explicit date, so you don't have to wait for the calendar to reach "tomorrow" or touch the trigger.

Run it once with `DRY_RUN=TRUE` to read the exact message in the log, then set `DRY_RUN=FALSE` to post it for real. **Clear `SPREADSHEET_ID` when you're done** — see the trigger warning above. The old sheet gets its own `_log`, so a demo can never mark this season's roll calls as already sent.

---

## 9. Development & deployment

You only need this section if you're **changing code**. Day-to-day operation (§6) needs none of it.

**Prerequisites:** [Node.js](https://nodejs.org), then `npm install -g @google/clasp`, then `clasp login`. Enable the Apps Script API once at <https://script.google.com/home/usersettings> (clasp can't push without it).

**Deploy code changes:**
```bash
cd apps-script
clasp push            # local files → Apps Script (this is the deploy)
```

**Run the tests first** (from the repo root, not `apps-script/`):
```bash
node tests/parser.test.js
```

> ⚠️ **Never put a test file inside `apps-script/`.** Apps Script has no module
> system — it concatenates every file in the project into one global scope. A
> test file's `const { parseEventName_, … }` therefore collides with `Parser.js`'s
> real declaration and throws `SyntaxError: Identifier ... has already been
> declared` **at parse time**, which kills the nightly run, every command, and
> every editor function at once. `.claspignore` guards against it, but keeping
> tests out of the pushed directory is the guarantee that doesn't depend on a
> config file staying correct.

**Save to GitHub (separate from deploy):**
```bash
git add -A && git commit -m "…" && git push
```

**First-time setup of a fresh Apps Script project:** create a bound script on the tracker sheet, put its `scriptId` in `apps-script/.clasp.json`, `clasp push`, set the Script Properties (§5), run `setupConfigTab()` and `setupGroupsTab()`, populate `Staffers`, run `createDailyTrigger()`, then deploy the web app and register the webhook (§9.1). After that, every GC is onboarded with `/rollsetup` (§7.2).

### 9.1 The web app + webhook (needed for commands only)

The nightly run works without any of this. The **commands** don't — they arrive over a webhook pointed at a Web App deployment.

**First deployment:**

1. **Deploy → New deployment → Web app.** Execute as **Me**, Who has access **Anyone**. Authorize when prompted (*Advanced → Go to project → Allow*).
2. Copy the `/exec` URL into the **`WEB_APP_URL`** script property.
3. Put any random string in **`WEBHOOK_SECRET`** (Apps Script can't read request headers, so Telegram's own secret-token header is unusable — the secret goes in the query string instead). Skipping this leaves the URL open to anyone who finds it.
4. Run **`checkWebhook()`** first and read the bot username it prints. ⚠️ **A bot token can have only ONE webhook** — if this token is shared with another bot script (the `/recap` bot, for instance), registering here silently steals its updates.
5. Run **`setupWebhook()`**. It refuses if a webhook already points somewhere else; `replaceExistingWebhook()` is the deliberate override.
6. Run **`publishCommandMenu()`** so members get `/` autocomplete in the GCs.

**Shipping a code change afterwards:**

> ⚠️ **Always edit the existing deployment. Never create a new one.** A new deployment issues a new `/exec` URL, which silently breaks the webhook — Telegram keeps POSTing to the old, dead one.

1. `clasp push`
2. **Deploy → Manage deployments** → ✏️ pencil on the existing deployment
3. **Version → New version** → **Deploy**

The `/exec` URL stays the same, so no webhook change is needed. `clasp push` alone only updates the *editor* copy — the live webhook keeps running the previously deployed version until you cut a new one.

### Verification / test functions (run from the editor)

The Run button can't pass arguments, so the date-based helpers default to `TEST_DATE`/`TEST_MONTH` (constants at the top of the test section in `Main.js` — point them at whatever tab currently has sample data).

| Function | What it checks |
|---|---|
| `testRead` | raw values of the test tab |
| `testConfigAndStaffers` | parsed Config + the name→handle map |
| `testDateResolver` | date/venue forward-fill (merged cells) |
| `testEventFilter` | which games match a date |
| `testEventNameParser` | sport/opponent splitting |
| `testFullEventBuild` | full event objects with resolved handles |
| `testMessageRender` | the exact message text (no send) |
| `testRouting` | which group + topic each game resolves to (no send) |
| `testSetupGuess` | what `/rollsetup` would infer from a group title, and why (edit `TEST_GROUP_TITLE`) |
| `testUpcoming` | what `/next` would find for a keyword, across every month tab |
| `testCoverage` | every sport in the tracker, ✅ mapped or ❌ no GC — the season's onboarding checklist |
| `checkWebhook` | which bot this token is, where its updates go, last delivery error |
| `setupWebhook` / `replaceExistingWebhook` | register this deployment as the bot's webhook (§9.1) |
| `publishCommandMenu` | push the command list to Telegram for `/` autocomplete |
| `removeWebhook` | stop receiving commands (the nightly run is unaffected) |
| `harvestChatIds` | **legacy** — superseded by `/rollwhere`; returns 409 while the webhook is live |
| `setupConfigTab` / `setupGroupsTab` | create + seed the Config / Groups tabs |
| `testSend` | the **real** send path for a date (honors `DRY_RUN`) |
| `testErrorHandling` | forces an error → confirms the Telegram alert + `_log` entry |
| `resetLog` | wipes the `_log` ledger so a date can be re-sent |
| `createDailyTrigger` | installs the nightly 7 PM trigger |
| `listTriggers` | lists installed triggers (confirm `handler=main`, `CLOCK`) |

---

## 10. Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| **No messages at all** | Is `DRY_RUN` `FALSE`? Is the trigger installed (`listTriggers`)? Do the live month tabs actually have games dated for tomorrow? |
| **"Sent" in the log but nothing in the group** | Wrong Chat/Thread ID in the Groups tab, **or the group's ID changed** (e.g. upgraded to a supergroup — gains a `-100` prefix). Re-run `harvestChatIds()` and update the Groups tab. The `_log` Detail column shows the `chatId/threadId` each message targeted. |
| **Roll call landed in the admin chat with a ⚠️ warning** | That sport has no GC mapped. Run `/rollsetup` in its group's Roll Call topic (§7.2). `/groups` lists everything still unmapped. |
| **Wrong topic (tab) within the right group** | Run `/rollsetup` again in the **correct** Roll Call topic — the row moves. (`/rollwhere` shows what the current topic is mapped to.) |
| **Commands do nothing at all** | Run `checkWebhook()`. No URL = run `setupWebhook()`. A `last_error_message` about a 401/404 usually means a **new deployment was created** instead of a new version of the existing one — re-copy the `/exec` URL into `WEB_APP_URL` and re-register. |
| **The bot replies to one command over and over** | Telegram is retrying because it isn't getting a clean 200. Run `removeWebhook()` to stop it immediately, then check that `doPost` still **returns nothing** — returning a `ContentService` output makes Apps Script answer with a 302, which Telegram treats as a failed delivery and retries forever. `update_id` deduplication now blocks the loop as a second line of defence. |
| **Commands stopped after a code change** | `clasp push` updates the editor only. Cut a **new version of the existing deployment** (§9.1) — the webhook keeps running the old version until you do. |
| **Another bot of ours broke when I set this up** | One token = one webhook. If both scripts share a bot token, they fight over it. Check `checkWebhook()`'s bot username; give each script its own bot. |
| **`/rollsetup` says it can't tell which sport this GC is** | The group's name has no word matching a sport in the tracker. Run `/rollsetup <sport>` with a keyword from the list it printed. |
| **`/rollsetup` says nothing in the tracker matches** | Either the keyword is wrong or `SEASON_START_YEAR` is stale, making every game resolve to the wrong year. Check §8. |
| **Commands error with "No active spreadsheet"** | Set the `SPREADSHEET_ID` script property to the tracker's URL (§8.1). |
| **⚠️ The bot posts nothing, and `_log` shows no new rows at all** | It may be reading the wrong spreadsheet. Run `/whereami` and check the `Tracker:` line — a `SPREADSHEET_ID` left over from a demo (§8.2) points the nightly run at an old sheet, where there are no games for tomorrow. Clear the property. |
| **Error: "SPREADSHEET_ID is set to … but that spreadsheet could not be opened"** | The link is wrong, or the Google account running the script has no access to that sheet. Fix the property or share the sheet with that account; clearing the property falls back to the bound sheet. |
| **A game is skipped unexpectedly** | Its event name has no `DLSU vs X` opponent, or it already shows `SENT` in `_log` (run `resetLog` to re-send). |
| **⚠️ A whole tab produces nothing, on a sheet you just pointed at** | The column layout probably differs. Run `testLayout()` — if `DAY` shows `"Mon"` instead of a number, set `DATA_START_COLUMN` (§7) to the column letter holding the day number. Reading one column off makes every row forward-fill from a null date, so nothing ever matches and nothing errors. |
| **Wrong time shown** | The time is formatted in the *spreadsheet's* timezone. If the spreadsheet's timezone setting is wrong, the displayed (and posted) time will be too. |
| **A staffer shows "no handle on file"** | The name in the Recap/Livetweet cell doesn't match any `Name` in the Staffers tab, or that row's Handle is blank. |
| **`⚠️ Livetweet: UNASSIGNED` on a game nobody livetweets** | Two columns are named `Livetweet`: the `Yes`/`No` deliverable flag and the staffer names further right. The warning now fires only when the flag says `Yes`, so check the flag — if it reads `No` and you still see the warning, someone is named in the staffer cell. |
| **Error alert in Telegram** | Open the `_log` tab — the `ERROR` row's Detail column has the message/stack. |
| **Bot stopped after "working fine"** | Check `_log` for recent `ERROR` rows; check the trigger still exists; check the group didn't become a supergroup. |

---

## 11. Design notes worth knowing

- **Read-only** except the `_log` tab and the `Groups` tab (written only by `/rollsetup` and `/unmap`) — the bot never edits event data.
- **Idempotency** is keyed on `date + sport + opponent + time`. A dry run logs `DRY_RUN` (not `SENT`) so it never blocks a later real send. `/rollcall` writes the same `SENT` rows the nightly run checks — that shared ledger is what makes a manual push safe.
- **`/rollsetup` only accepts a sport the tracker actually has.** A mapping to a sport nobody plays fails invisibly: no error, no alert, just a roll call that never arrives, noticed weeks later by the staffer who wasn't told about their game.
- **New Groups rows are placed, not appended.** A `3x3` row below `Basketball` would never win, since a 3x3 game's sport contains both words — and keyword *length* is no guide either (`basketball` is longer than `3x3`). So `/rollsetup` looks at which sports the new keyword matches and inserts above the first existing rule that also matches them.
- **`doPost` always returns 200.** Telegram retries anything else, and a retried `/rollcall` is a double post.
- **Timezone** is Asia/Manila everywhere; "tomorrow" and all formatting are computed in Manila time, never the runtime default.
- **Messages send as HTML** with `&`, `<`, `>` escaped — safe for handles like `@handle2`.
- Columns **P** (Photo) and **S–V** (Web/Layout/Execs) are intentionally ignored.
