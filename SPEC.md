# TLS UAAP Roll Call Bot — Specification

Automated Telegram roll call for The LaSallian's UAAP Season 89 coverage.

**Platform:** Google Apps Script (bound to the Coverage Tracker spreadsheet)
**Language:** JavaScript (Apps Script runtime, V8)
**Trigger:** Time-driven, daily, 7:00–8:00 PM Asia/Manila
**Behaviour:** Reads the tracker, finds tomorrow's game events, posts one roll call message per event to a Telegram group.

Chosen over Python/Railway and GitHub Actions because it must run unattended for years after the original author leaves. No hosting account, no credentials file, no credit balance, no workflow-disable rule. Handoff is transferring ownership of the spreadsheet.

---

## 1. Repository layout

```
TLS-Automated-Roll-Call/
├── SPEC.md                  # this file
├── README.md                # handoff instructions for successors
├── Copy_of_TLS_UAAP_88_Coverage_Tracker__1_.xlsx   # reference copy of real data
└── apps-script/             # clasp-managed, pushed to Apps Script
    ├── .clasp.json
    ├── appsscript.json
    ├── Config.js
    ├── Sheets.js
    ├── Parser.js
    ├── Staffers.js
    ├── Template.js
    ├── Telegram.js
    ├── Log.js
    └── Main.js
```

`clasp push` sends local code to Apps Script. `git push` sends it to GitHub. These are **separate operations** — Apps Script does not read from GitHub.

---

## 2. Spreadsheet structure

The tracker has **one tab per month**, named exactly the month in English: `September`, `October`, `November`, `December`, `January`, ... No year in the tab name.

Two additional tabs are added by this project: `Staffers` and `Config`. A third, `_log`, is created automatically by the script.

### 2.1 Event tab layout

Rows 1–4 are headers. Data begins at **row 5**.

| Col | Contents | Notes |
|---|---|---|
| A | (unused) | |
| B | Day of month | **Mixed types** — see §3.1 |
| C | Weekday abbreviation | `Fri`, `Mon`, ... Informational only; do not trust it, derive weekday from the resolved date |
| D | Time | Usually a Date/time value, sometimes free text |
| E | Event name | `R1 Men's Football: \nDLSU vs UE` — contains newlines |
| F | Venue | May be merged across rows |
| G | `Game day` | `Yes`/`No` — **not used for filtering**, see §3.3 |
| H | `HN` | Deliverable flag |
| I | `Livetweet` | Deliverable flag |
| J | `HT` | Deliverable flag |
| K | `Buzzer` | Deliverable flag |
| L | `POTG` | Deliverable flag |
| M | `Album` | Deliverable flag |
| N | `Recap Article` | Deliverable flag |
| O | `IGs` | Deliverable flag |
| P | Photo staffers | **Ignore** |
| Q | **Sports — Recap staffers** | Comma-separated names. **Used.** |
| R | **Sports — Livetweet staffers** | Comma-separated names. **Used.** |
| S–V | Web / Layout / Execs | **Ignore** |

Only **Q and R** are read for staffer assignment. Columns P and S–V exist in the sheet but are out of scope.

### 2.2 Header merge structure (for reference)

Row 2 has group headers (`B2:D4` = Date block, `G2:O2` = Deliverables, `P2:V2` = Staffers Assigned). Row 3 has sub-headers, some merged down into row 4 (`G3:G4`, `H3:H4`, ...). `Q3:R3` is a merged "Sports" header, with `Q4=Recap` and `R4=Livetweet` beneath it.

**Do not parse headers.** Column positions are fixed. Read by column index.

### 2.3 Staffers tab

| A | B |
|---|---|
| `Name` | `Handle` |
| `Lance` | `@handle1` |
| `Staffer 2` | `@handle2` |

Row 1 is a header. Names must match what is typed in columns Q and R. Matching is **case-insensitive and whitespace-trimmed**.

### 2.4 Config tab

Key–value pairs, header in row 1.

| A (`Key`) | B (`Value`) | Purpose |
|---|---|---|
| `SEASON_START_YEAR` | `2025` | See §3.2 — **must be updated each season** |
| `SEASON_START_MONTH` | `9` | Month number the season begins |
| `DRY_RUN` | `TRUE` | `TRUE` = log only, never send |
| `LEAD_DAYS` | `1` | Days ahead to look (1 = tomorrow) |
| `SHOW_UNASSIGNED_WARNING` | `TRUE` | Emit ⚠️ line for empty Q or R |

Telegram credentials live in **Script Properties**, not here — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Config values must be read with sensible fallback defaults so a missing row does not crash the script.

---

## 3. Parsing rules

This is the hard part of the project. Everything else is plumbing.
2
### 3.1 Date resolution — column B

Column B is typed by hand and Google Sheets coerces inconsistently. Three cases:

| Cell state | Example | Handling |
|---|---|---|
| Real Date object | `2025-09-12` | Take `.getDate()` for the day |
| Number | `15`, `19` | Use directly as day of month |
| Empty string | (continuation row) | **Forward-fill** from the last non-empty value |

Empty cells occur because **date cells are merged across multi-event days**. `getValues()` returns the value in the top-left cell and `""` for every other cell in the merge — see the live sheet's currently-populated test tab (`TEST_MONTH` in Main.js, see §9) for confirmed merge ranges.

Implementation:

```js
let lastDay = null;
for (const row of rows) {
  const raw = row[COL.DATE];
  let day = null;
  if (raw instanceof Date) day = raw.getDate();
  else if (typeof raw === 'number' && raw > 0) day = raw;
  else if (raw === '' || raw === null) day = lastDay;   // forward-fill
  if (day !== null) lastDay = day;
  // ...
}
```

**Venue (column F) is also merged** in at least one case (`F14:F15`). Forward-fill venue the same way. Do **not** forward-fill Q or R — see §3.5.

### 3.2 Year resolution

Tab names carry no year, so the year cannot be derived from the sheet alone.

Rule: given `SEASON_START_YEAR` and `SEASON_START_MONTH` from Config, a tab whose month number is **>= SEASON_START_MONTH** belongs to `SEASON_START_YEAR`; a tab whose month is **< SEASON_START_MONTH** belongs to `SEASON_START_YEAR + 1`.

With `SEASON_START_YEAR=2025`, `SEASON_START_MONTH=9`: September–December → 2025, January–May → 2026.

**This is the one value a successor must update annually.** Document it prominently in README.md.

### 3.3 Event filtering

An event qualifies for a roll call if **both** hold:

1. Resolved date == today + `LEAD_DAYS` (default: tomorrow), in Asia/Manila
2. Column E's event name resolves to an identifiable opponent per §3.4 (i.e. the `vs`/`v` split has exactly one side reading as `DLSU`)

Column G (`Game day`) is **not** used as a filter — in practice it does not reliably distinguish real games from non-game entries, so an unambiguous opponent match is the source of truth instead. Non-game events (press conferences, opening ceremonies, `Light of Hope` show) have no `vs`/`v` opponent split and are **skipped entirely** as a natural consequence of §3.4's fallback behaviour, not because of an explicit flag check.

### 3.4 Event name parsing — column E

Format as typed: `[SPORT]: DLSU vs [OPPONENT]`, with a newline before `DLSU`.

Example raw value:
```
R1 Men's Football: \nDLSU vs UE
```

Steps:
1. Normalise: replace `\n` with a space, collapse repeated whitespace, trim
2. Split on the **last** `:` → left = sport (`R1 Men's Football`), right = matchup (`DLSU vs UE`). The last colon, not the first: the sport prefix is sometimes typed with an internal colon (e.g. `R1: Men's Basketball: DLSU vs ADMU`), but the matchup never contains one.
3. Split the matchup on `vs` or `v` (word-boundary, case-insensitive) → `DLSU`, `UE`
4. Identify the opponent as the side that is **not** DLSU (do not assume DLSU is always first)

Output message uses `[OPPONENT] vs DLSU` — i.e. **reversed** from the sheet — with the sport shown separately.

Fallbacks: if there is no `:`, treat the whole string as the matchup with an empty sport. If there is no `vs`/`v`, use the raw string as the matchup and skip the reversal. **Never throw** on a malformed event name — degrade to raw text so the message still sends.

### 3.5 Staffer parsing — columns Q and R

Comma-separated names. Split on `,`, trim each, drop empties.

**Do not forward-fill Q or R.** Two games on the same day have *different* staffers per game; an empty cell means genuinely unassigned, not "same as above."

Resolve each name via the `Staffers` tab (case-insensitive, trimmed). If a name has no matching handle, output the raw name followed by a marker rather than dropping it:

```
Recap: @handle1, Staffer 2 (no handle on file)
```

If a cell is empty and `SHOW_UNASSIGNED_WARNING` is TRUE, emit a warning line (§4.2).

### 3.6 Time parsing — column D

Usually a Date/time value → format as `h:mm a` (e.g. `4:30 PM`), lowercased to match house style (`4:30 pm`).

**Format with the spreadsheet's timezone, not the script's.** `getValues()` builds a time-only cell's `Date` against Google Sheets' 1899 epoch using the *spreadsheet's* timezone, whose historical LMT offset differs from the modern one by a few odd minutes. Reading it back with `.getHours()` (which uses the *script's* timezone) leaks that difference in as a skew — observed as `4:00 PM` coming out `4:23 pm`. Use `Utilities.formatDate(raw, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'h:mm a')`: building and formatting the instant with the same zone cancels the offset exactly.

Sometimes free text, e.g.:
```
2PM (Mass)

6PM Opening Program
```
When the value is not a Date, **pass the raw string through** with newlines collapsed to spaces. Do not attempt to parse it. (In practice these appear on non-game rows, which are filtered out anyway — but handle it defensively.)

### 3.7 Deliverables — columns G–O

Collect the columns marked `Yes` and map to display labels:

```js
const DELIVERABLE_LABELS = {
  G: 'Game Day',
  H: 'HN',
  I: 'Livetweet',
  J: 'HT',
  K: 'Buzzer',
  L: 'POTG',
  M: 'Album Caption',
  N: 'Recap',
  O: 'IGs',
};
```

Note two renames from the sheet headers: `Album` → `Album Caption`, `Recap Article` → `Recap`. Column G (`Game day`) **is** included in this list as `Game Day` — note it is still **not** used for event filtering (§3.3); the two roles are independent.

Join with `, ` in column order.

---

## 4. Message template

### 4.1 Format

One message per event. Existing house format, to be reproduced closely:

```
SPORTS @rollcall

[SPORT]
[OPPONENT] vs DLSU
[Month] [Day] ([Weekday])
Time: [time]
Venue: [venue]

Recap: [recap handles]
Livetweet: [livetweet handles]

Don't forget to discuss w your co-writer on how to distribute captions!

Deliverables: [comma-separated deliverables]

[conditional reminders]

Thank you so much & enjoy!
```

Send with `parse_mode: 'HTML'` (safer than Markdown — Telegram's legacy Markdown breaks on unescaped `_`, which appears in handles like `@handle2`). Escape `&`, `<`, `>` in all interpolated values.

### 4.2 Conditional lines

| Condition | Line |
|---|---|
| `HN` is a deliverable | `Pls send HN at least 30 min before the game starts!` |
| `Buzzer` is a deliverable | `And pls prep buzzer before the game ends!` |
| Column Q empty | `⚠️ Recap: UNASSIGNED` |
| Column R empty | `⚠️ Livetweet: UNASSIGNED` |

The HN and Buzzer reminders are emitted **only** when those deliverables are checked. Both, one, or neither may appear.

Unassigned warnings replace the corresponding `Recap:`/`Livetweet:` line rather than appearing alongside it.

### 4.3 Multiple events

Send **separate messages** per event, not one combined digest. Two games on the same day have different staffers, times, and venues; separate messages are easier to act on and to reply to.

---

## 5. Idempotency

The bot must never double-post. Apps Script triggers can fire more than once, and manual test runs can overlap with the scheduled run.

Maintain a hidden tab `_log`:

| A | B | C |
|---|---|---|
| `Timestamp` | `EventKey` | `Status` |

`EventKey` = a stable hash or concatenation of `resolvedDate + sport + opponent + time`.

Before sending, check whether that `EventKey` already appears with status `SENT`. If so, skip and log `SKIPPED_DUPLICATE`.

A **dry run must never write `SENT`** — doing so would poison the ledger and make a later real send skip the event as a duplicate. Dry runs log the distinct status `DRY_RUN`, which the duplicate check ignores (only `SENT` counts). So the recognised statuses are `SENT`, `SKIPPED_DUPLICATE`, `DRY_RUN`, and `ERROR`.

Create the tab automatically if missing. Hide it from normal view.

---

## 6. Error handling

Wrap the entire `main()` in `try/catch`. On exception:

1. Log to `_log` with status `ERROR` and the message text
2. Send a plain-text Telegram message to the same chat: `⚠️ Roll call bot error: [message]`

A silent failure is the worst outcome — the newsroom would assume no events rather than a broken bot. Loud failure is correct here.

Guard individually so one bad row does not kill the whole run: if a single event fails to parse, log it, notify, and continue to the next event.

---

## 7. Timezone

Set the Apps Script project timezone to **Asia/Manila** (Project Settings → Time zone).

Use `Utilities.formatDate(date, 'Asia/Manila', pattern)` for all formatting. Never rely on the runtime default. Compute "tomorrow" in Manila time, not UTC.

---

## 8. Configuration reference

**Script Properties** (Project Settings → Script Properties):

| Key | Example |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `123456:ABC-DEF...` |
| `TELEGRAM_CHAT_ID` | `-1234567890` |

Chat ID is negative for groups. Note: if the group is ever upgraded to a **supergroup**, its ID changes (gains a `-100` prefix) and sending will fail. Re-fetch via `getUpdates` if messages stop arriving.

`DRY_RUN` lives in the **Config tab**, not Script Properties, so a non-technical successor can toggle it from the spreadsheet.

---

## 9. Build order

Build and verify one step at a time. Do not proceed until the current step works in the Apps Script editor.

| # | Deliverable | Verification |
|---|---|---|
| 1 | `testRead()` — log first 20 rows of the `TEST_MONTH` tab | Execution log shows raw values |
| 2 | Config + Staffers readers | Log parsed config object and staffer map |
| 3 | Date resolver with forward-fill | Log resolved date per row; confirm merged-cell rows inherit correctly |
| 4 | Event filter (tomorrow + identifiable opponent) | Log matched rows for a hardcoded test date |
| 5 | Event name parser (sport / opponent split) | Log structured objects for all `TEST_MONTH` rows |
| 6 | Deliverables + staffer resolution | Log full event objects with handles |
| 7 | Message renderer | Log the exact string that would be sent |
| 8 | Telegram send | Set `DRY_RUN=FALSE`, confirm in test group |
| 9 | `_log` tab + idempotency check | Run twice, confirm second run skips |
| 10 | Error handling + notification | Force an exception, confirm alert arrives |
| 11 | Time-driven trigger | Wait one night |

For steps 3–7, `testEventFilter`/`testFullEventBuild`/`testMessageRender` (Main.js) default to the `TEST_DATE` constant since the Apps Script editor's Run button can't pass arguments; pass an explicit `dateString` to try a different date without editing code. `TEST_MONTH`/`TEST_DATE` in Main.js point at whichever month tab currently holds populated sample game data — update those two constants (and re-push) when switching to a different reference tab. A day with multiple events and at least one merged date cell across rows makes the best fixture.

---

## 10. Handoff notes (for README.md)

Write a README covering:

- **Annual task:** update `SEASON_START_YEAR` in the Config tab at the start of each season
- Adding a staffer: add a row to the `Staffers` tab, no code change needed
- Changing send time: Apps Script → Triggers → edit the existing trigger
- Pausing the bot: set `DRY_RUN` to `TRUE` in the Config tab
- If messages stop: check the group is still a plain group (not upgraded to supergroup), check the `_log` tab for errors
- Tab naming convention must stay exactly the English month name

---

## 11. Explicit non-goals

- Photo, Web, Layout, Execs columns (P, S–V) — not read
- Non-game events — skipped, never announced
- Per-event reminders at N hours before start — v2 at the earliest; current scope is one 7 PM run the day before
- Reading replies or confirmations from staffers — the bot only posts
- Editing the spreadsheet — read-only except for the `_log` tab