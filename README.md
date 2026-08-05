# enriching-investor-networks

An Opulent skill for investor-community operations: keep the member database fresh on a 2–4 week cadence, and grow it on purpose. Two lanes, one workspace, everything that writes outward behind a gate.

## What it does

A community database rots quietly. Investors change funds without telling anyone, emails go stale a character at a time, and "1,200 members" drifts into "1,200 rows, several hundred of them fiction." This skill treats freshness as a pipeline rather than a scrape. On each cycle it re-verifies every member record — email currency, title, organization, location, industries, profile text, and whether they are still actively investing — resolves each observation against the record it already holds, and writes a typed, dated change event for everything that moved: role changes, org moves, relocations, contact changes, investing-status transitions. Every field carries its source, its URL, the date it was seen, and a confidence label, so a value with weaker provenance can never quietly overwrite a stronger one; when two sources disagree the precedence ladder decides and the loser is kept in history rather than discarded. The output is a cycle report, a CSV, and a writeback payload shaped for the community platform's REST API — produced every cycle, pushed only when a person approves it, and verified by reading the record back afterward because a 200 is not proof the field took. The second lane finds new sponsors and investors against the community's ICPs, runs them through mechanical suppression — existing members, exclusions, prior declines, unsubscribes, anything that ever bounced — and hands the survivors to the invitation emails the platform already runs. It never sends anything itself. The one field clients mark *required and current* is email, which makes it the one field where a guess is sabotage: inferred addresses are labeled `candidate`, shown in the report, and withheld from writeback until verification promotes them.

## Required inputs

| Input | Where | Required | Notes |
|---|---|---|---|
| Community profile | `profiles/{slug}.json` | **Yes** | Schema, cadence, precedence ladder, ICPs, exclusions, API shape. Copy `example.json`; the run fails loudly rather than improvising a schema. |
| Member export or API read | platform | **Yes** | Baseline for cycle one. Stored as `platform_record` provenance — a source, not the truth. |
| → `fields` block | profile | **Yes** | The schema being refreshed. For a VC community: phone (optional), email (required + current), industries, title, organization, location, headline, about, `actively_investing`, changes-since-last. |
| → `api` block | profile | For writeback | Base URL, auth **env var name** (never the value), read and update routes, idempotency behavior. |
| → `cadence_days` | profile | **Yes** | The 2–4 week band. A cycle inside `min` is refused — re-enriching a week early is spend without information. |
| → `recency_months_actively_investing` | profile | **Yes** | Default 12. The window that decides when an investing signal goes stale. |
| → `sponsor_icp` / `investor_icp` | profile | Lane two | With `evidence_bar` — what a candidate must be able to prove. |
| → `exclusions`, `outreach` | profile | Lane two | Competitors and do-not-contact, plus decline cooldown and unsubscribe policy. |
| `CONTEXT_DEV_API_KEY` | environment | For Context.dev | Server-side only. Opulent integrates Context natively; the skill never embeds or logs the key. |
| Authenticated session | live-view handoff | If profile reads need login | A person signs in once; the thread's browser context carries it. The skill never types a credential and never attempts a captcha. |
| Approval owner | profile + chat | For every write | One human at the writeback gate, one at each invitation batch. |

## Expected outputs

Persisted under `/opulent/workspace/networks/{community_slug}/` — durable across cycles, not per-run.

| Output | What it is |
|---|---|
| `refresh.html` | The cycle report. Changed members first with before → after and the evidence quote behind each change; quiet members collapsed to a list; prospects with their eligibility or suppression reason. |
| `writeback.json` | The API-ready payload — per member, per field, with value, confidence, source, URL, date, and an idempotency key. Always `dry_run: true` until approved. |
| `changes.csv` | One row per member with current values, email status, investing status, and this cycle's change count and types. Formula-injection safe. |
| `changes.jsonl` | Append-only change log across all cycles. Corrections are new entries, never edits. |
| `members.json` | Canonical state — every field as `{value, confidence, source, source_url, observed_at, history[]}`. |
| `cycles/{date}/` | That cycle's raw observations, events, quarantine, and prospect files. Re-parse freely; re-fetch never. |
| `invite_queue.proposed.json` | Approved-pending prospects in the platform's queue shape. Becomes real only after the gate. |
| `prospects/suppressed.jsonl` | Every suppressed prospect **with its reason** — the gate's blocks are audited as carefully as its passes. |
| `summary.json` + chat summary | Members, changes by type, email verification results, writeback size, prospect funnel, next cycle date. |

A quiet cycle is a real result: zero events, zero writeback entries. Re-running a cycle produces zero of both and leaves the cycle record intact.

## Boundaries

- **Nothing sends.** The community's existing automated emails do the inviting; this skill queues. No outreach originates here.
- **Nothing writes unapproved.** Writeback is a dry-run payload every cycle; the push needs a person, a record match, an idempotency key, and a read-after-write check.
- **No invented emails.** `candidate` addresses never promote themselves into the current-email field.
- **No credentials, no captchas.** Auth is a live-view handoff done by a human; an interstitial ends that member's cycle, it does not start a retry loop.

## Layout

```
enriching-investor-networks/
├── SKILL.md                          the pipeline — 9 steps, evidence/source/gate discipline
├── profiles/example.json             schema, cadence, ladder, ICPs, exclusions, API shape
├── references/
│   ├── enrichment-sources.md         the source ladder, Context.dev operation contract, email state machine
│   ├── change-detection.md           identity resolution, diff semantics, the "still actively investing" rule
│   ├── writeback-and-invites.md      push contract, invitation states, suppression rules, discovery packet
│   └── workflow.md                   subagent prompts, hard call caps, wave sizing
├── samples/                          one-cycle fixture — runs both lanes offline
└── scripts/
    ├── diff_enrichment.mjs           resolve observations → precedence → typed change events
    ├── gate_prospects.mjs            mechanical suppression with recorded reasons
    └── compile_refresh.mjs           report + CSV + writeback payload + invite proposal
```

## Try it

```bash
cp -R samples/fixture /tmp/net-ws && node scripts/diff_enrichment.mjs /tmp/net-ws --cycle 2026-08-05 && node scripts/gate_prospects.mjs /tmp/net-ws --cycle 2026-08-05 && node scripts/compile_refresh.mjs /tmp/net-ws --cycle 2026-08-05 --open
```

Dependency-free, Node 18+. [`samples/README.md`](samples/README.md) explains what each of the 12 events and 6 gate outcomes proves — including why `platform_record` sits near the *bottom* of the precedence ladder, which the fixture is what caught.

## Status

**Isolated by design.** This package sits outside `.agents/skills/` in the Opulent monorepo — not in the skill catalog, not in the template SSOT, not in the preloaded seed — so nothing here can affect the snapshot-skill contract tests. The slug follows catalog convention (unprefixed, gerund) and the frontmatter is `name` + `description` + `license` only.

## Provenance

Folder construction and writing conventions follow [browserbase/skills](https://github.com/browserbase/skills) — step-numbered pipeline, hard tool-call caps, verbatim-evidence and anti-hallucination rules, heredoc-batched subagent writes, `references/` opened only when a trigger fires. The evidence vocabulary (`Verified` / `Estimated` / `Unknown`), the signal contract behind change events, the operation-contract form for Context.dev calls, and the drafts-by-default write policy come from [opulent-gtm-intelligence](https://github.com/OpulentiaAI/opulent-gtm-intelligence/tree/main/skills/opulent-gtm-intelligence). Context.dev capabilities were checked against [context.dev](https://www.context.dev/) on 2026-08-05.
