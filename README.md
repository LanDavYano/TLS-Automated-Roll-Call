# TLS Automated Roll Call

Automated Telegram roll call for **The LaSallian's** UAAP sports coverage. Every night it reads the Coverage Tracker spreadsheet, finds the next day's games, and posts one roll call message per game to the sports Telegram group — so staffers wake up already assigned.

**Author:** Lance Jardiniano, TLS65 Sports Staffer

> **Full technical spec:** [SPEC.md](SPEC.md). This README is the practical handoff — read it first. Read SPEC.md when you need the *why* behind a parsing rule.

---

## 1. What it does

- Runs **once a night, ~7:00 PM Manila time**, unattended.
- Looks at **tomorrow's** date (configurable) and finds every game on the tracker for that day.
- Posts a formatted roll call per game: sport, matchup, time, venue, assigned Recap/Livetweet staffers (resolved to Telegram handles), deliverables, and reminders.
- **Routes each roll call to its sport's own Telegram group** (Basketball, Football, …) — specifically into that group's **Roll Call** topic — so nothing gets collated into one messy chat.
- **Never double-posts** — it keeps a log and skips anything already sent.
- **Fails loudly** — if something breaks, it sends an error message to the same Telegram group instead of failing silently.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Google Apps Script** (V8), *bound* to the Coverage Tracker spreadsheet | Runs unattended for years with no server, no hosting bill, no credentials file. Handoff = transferring ownership of the spreadsheet. |
| Language | JavaScript (Apps Script flavor) | — |
| Scheduling | Apps Script **time-driven trigger** | Built in; no cron server needed. |
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
  → parseMonthEvents()     forward-fill dates/venues, parse names, times, deliverables, staffers
  → filterEventsForDate_() keep only games on the target date
  → for each game:
      hasBeenSent_()       already posted? → skip (SKIPPED_DUPLICATE)
      renderMessage_()     build the message text
      sendTelegramMessage_ post to the group (unless DRY_RUN)
      logStatus_(SENT)     record it in the _log tab
```

Any exception is caught, logged to `_log` as `ERROR`, and pushed to Telegram as an alert. One bad row can't kill the whole run — each game is guarded individually.

---

## 4. Repository layout

```
TLS-Automated-Roll-Call/
├── README.md              ← this file (handoff)
├── SPEC.md                ← full technical specification
└── apps-script/           ← the deployed code (clasp-managed)
    ├── .clasp.json          links this folder to the Apps Script project (scriptId)
    ├── appsscript.json      project manifest (timezone = Asia/Manila, V8)
    ├── Main.js              entry point, nightly run, trigger install, test helpers
    ├── Config.js            Config tab reader + setupConfigTab()
    ├── Staffers.js          Staffers tab reader (name → handle)
    ├── Groups.js            Groups tab reader + per-sport routing + setupGroupsTab()
    ├── Sheets.js            sheet/timezone access helpers
    ├── Parser.js            all parsing rules (dates, names, times, deliverables)
    ├── Template.js          message rendering + HTML escaping
    ├── Telegram.js          Telegram send (to any chat/topic) + error notify + harvestChatIds()
    └── Log.js               _log tab: idempotency ledger + error trail
```

---

## 5. The spreadsheet

The script is bound to the **Coverage Tracker** Google Sheet. It uses these tabs:

### Month tabs (`September`, `October`, …)
- Named **exactly** the English month, **no year**. This naming is load-bearing — don't rename them.
- Data starts at **row 5** (rows 1–4 are headers).
- Key columns: **B** day, **D** time, **E** event name (`Sport: DLSU vs OPPONENT`), **F** venue, **G** Game day, **H–O** deliverable flags, **Q** Recap staffers, **R** Livetweet staffers.
- A game is announced when its **event name has an identifiable opponent** (`DLSU vs X`). The `Game day` column is **not** used to decide this; press conferences / ceremonies (no "vs") are skipped automatically.

### `Config` tab
Key/Value pairs the bot reads live on every run. Run `setupConfigTab()` once to create and populate it with descriptions. See §7 for what each key does.

### `Staffers` tab
`Name | Handle`, one per row (row 1 is the header). Names must match what's typed in columns Q/R (case-insensitive, whitespace-trimmed). Add staffers by adding rows — no code change. See §7.

### `Groups` tab
`Sport keyword | Chat ID | Thread ID | Notes`. Maps each sport to the Telegram group + Roll Call topic its roll calls post to. **Add a sport = add a row** (read live each run, no code). Run `setupGroupsTab()` once to create it with headers and an example. See §7.1 for how to fill it.

### `_log` tab (hidden, auto-created)
`Timestamp | EventKey | Status | Detail`. Statuses: `SENT`, `SKIPPED_DUPLICATE`, `DRY_RUN`, `ERROR`. This is the idempotency ledger and the error trail — check it first when debugging.

### Script Properties (NOT a tab)
Telegram credentials live in **Project Settings → Script Properties**, so they aren't visible to spreadsheet editors:

| Key | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | the group chat ID (negative for groups) |

---

## 6. Everyday operations (the knobs a non-coder can turn)

All of these are **data edits** — no code, no `clasp`, no redeploy. They take effect on the next run because the bot reads the Config/Staffers tabs live.

| I want to… | Do this |
|---|---|
| **Pause the bot** | Config tab → set `DRY_RUN` to `TRUE`. It will log but never post. Set back to `FALSE` to resume. |
| **Add / change a staffer** | Staffers tab → add or edit a `Name | Handle` row. The name must match what's typed in the Recap/Livetweet columns. |
| **Add a sport / change its group** | Groups tab → add or edit a row (`Sport keyword | Chat ID | Thread ID`). See §7.1. |
| **Look further ahead** | Config tab → change `LEAD_DAYS` (1 = tomorrow, 2 = two days out, …). |
| **Change the send time** | Apps Script editor → **Triggers** (alarm-clock icon) → edit the `main` trigger's time. |
| **⭐ Start a new season** | Config tab → update `SEASON_START_YEAR` (and `SEASON_START_MONTH` if the season starts a different month). **This is the one annual task — see §8.** |

---

## 7. Config keys reference

| Key | Example | Purpose |
|---|---|---|
| `SEASON_START_YEAR` | `2025` | The calendar year the season's opening month falls in. **Update each season.** |
| `SEASON_START_MONTH` | `9` | Month number the season begins (9 = September). Month tabs `≥` this belong to `SEASON_START_YEAR`; earlier months roll to the next year. |
| `DRY_RUN` | `FALSE` | `TRUE` = log only, never post. `FALSE` = live. Also the pause switch. |
| `LEAD_DAYS` | `1` | How many days ahead to look. `1` = announce tomorrow's games tonight. |
| `SHOW_UNASSIGNED_WARNING` | `TRUE` | `TRUE` = show a ⚠️ UNASSIGNED line when a Recap/Livetweet cell is blank. |

Only these five keys are read. Values are validated with fallbacks, so a typo (e.g. `DRY_RUN = maybe`) silently reverts to the safe default rather than crashing.

### 7.1 The `Groups` tab (per-sport routing)

Each sport has its own Telegram group, and roll calls post into that group's **Roll Call** topic. The `Groups` tab tells the bot where each sport goes:

| Sport keyword | Chat ID | Thread ID (Roll Call topic) | Notes |
|---|---|---|---|
| `Basketball` | `-100…` | `12` | covers Men's, Women's, and 3x3 |
| `Football` | `-100…` | `7` | |
| `Chess` | `-100…` | `4` | |

How it works:
- **Matching:** for each game, the bot finds the first row whose keyword appears in the game's sport name (case-insensitive). `Basketball` matches `R1 Men's Basketball`, `R1 Women's Basketball`, and `R1 Men's 3x3 Basketball` — all go to the same Roll Call topic.
- **Row order = priority.** If you ever want a sub-variant in a *different* topic (say 3x3 in its own tab), add a `3x3` row **above** the `Basketball` row; the more specific row wins for matching games. Otherwise the general row covers everything.
- **Chat ID vs Thread ID:** the Chat ID is the whole group; the Thread ID picks the topic (tab) within it. Every topic in the same group shares one Chat ID. Leave Thread ID blank only for a non-forum group.
- **Unmapped sport:** if no row matches, the roll call goes to the admin chat (`TELEGRAM_CHAT_ID`) with a warning appended — so it's never lost. Add a row to fix routing.

**Finding the IDs:** make the bot an **admin** of the group (or disable its privacy mode via BotFather → `/setprivacy`), post any message in each Roll Call topic, then run `harvestChatIds()`. The execution log prints each `chatId` + `threadId` + topic sample — paste those into the tab. Run `testRouting` afterward to confirm each game resolves to the right group/topic before sending.

---

## 8. ⭐ The one annual task

At the start of each UAAP season, open the **Config** tab and set:

- `SEASON_START_YEAR` → the year the season's first month falls in (e.g. `2025` for a season opening September 2025).
- `SEASON_START_MONTH` → only if the opening month changes.

**Why it matters:** the month tabs carry no year (`September`, not `September 2025`), so this is the only place the year comes from. With `SEASON_START_YEAR=2025, SEASON_START_MONTH=9`: Sep–Dec → 2025, Jan–May → 2026. Forget this and the bot computes the wrong dates and posts nothing.

---

## 9. Development & deployment

You only need this section if you're **changing code**. Day-to-day operation (§6) needs none of it.

**Prerequisites:** [Node.js](https://nodejs.org), then `npm install -g @google/clasp`, then `clasp login`. Enable the Apps Script API once at <https://script.google.com/home/usersettings> (clasp can't push without it).

**Deploy code changes:**
```bash
cd apps-script
clasp push            # local files → Apps Script (this is the deploy)
```

**Save to GitHub (separate from deploy):**
```bash
git add -A && git commit -m "…" && git push
```

**First-time setup of a fresh Apps Script project:** create a bound script on the tracker sheet, put its `scriptId` in `apps-script/.clasp.json`, `clasp push`, set the two Script Properties (§5), run `setupConfigTab()` and `setupGroupsTab()`, populate `Staffers` and `Groups` (use `harvestChatIds()` for the chat/topic IDs), then run `createDailyTrigger()`.

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
| `harvestChatIds` | logs chat/topic IDs from the bot's recent updates (to fill the Groups tab) |
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
| **Roll call landed in the admin chat with a ⚠️ warning** | That sport has no matching row in the Groups tab. Add one (see §7.1), then it routes correctly next time. |
| **Wrong topic (tab) within the right group** | The `Thread ID` for that sport is wrong. Re-run `harvestChatIds()` (post in the correct Roll Call topic first) and fix the row. |
| **A game is skipped unexpectedly** | Its event name has no `DLSU vs X` opponent, or it already shows `SENT` in `_log` (run `resetLog` to re-send). |
| **Wrong time shown** | The time is formatted in the *spreadsheet's* timezone. If the spreadsheet's timezone setting is wrong, the displayed (and posted) time will be too. |
| **A staffer shows "no handle on file"** | The name in the Recap/Livetweet cell doesn't match any `Name` in the Staffers tab, or that row's Handle is blank. |
| **Error alert in Telegram** | Open the `_log` tab — the `ERROR` row's Detail column has the message/stack. |
| **Bot stopped after "working fine"** | Check `_log` for recent `ERROR` rows; check the trigger still exists; check the group didn't become a supergroup. |

---

## 11. Design notes worth knowing

- **Read-only** except the `_log` tab — the bot never edits event data.
- **Idempotency** is keyed on `date + sport + opponent + time`. A dry run logs `DRY_RUN` (not `SENT`) so it never blocks a later real send.
- **Timezone** is Asia/Manila everywhere; "tomorrow" and all formatting are computed in Manila time, never the runtime default.
- **Messages send as HTML** with `&`, `<`, `>` escaped — safe for handles like `@handle2`.
- Columns **P** (Photo) and **S–V** (Web/Layout/Execs) are intentionally ignored.
