---
name: enriching-investor-networks
description: Keep an investor community's member database fresh and grow it on purpose. Lane one re-enriches every member record on a 2–4 week cadence — email currency, role and organization moves, location, profile text, whether they are still actively investing — with field-level provenance, typed change events, and a dry-run writeback payload for the community platform's REST API. Lane two discovers new sponsor and investor prospects against the community's ICP, gates them through suppression and human approval, and hands the survivors to the platform's existing automated invitation emails. Use when the user wants a member or investor database refreshed, contact records re-enriched on a schedule, changes since last enrichment detected, or new sponsors and investors sourced for a community. Triggers "refresh the investor database", "re-enrich members", "what changed since last enrichment", "find sponsors for", "grow the investor network", "sync enrichment to the platform".
license: MIT
---

# Enriching investor networks

Take a member database → get it back fresher: every record re-verified on cadence, every change since last time typed and dated, a writeback payload the platform can ingest — and a queue of new sponsors and investors that survived suppression and approval, ready for the invitation system the community already runs.

A community database rots quietly. Investors change funds without telling you, emails go stale a character at a time, and "1,200 members" drifts into "1,200 rows, several hundred of them fiction." The expensive failure isn't missing data — it's confidently wrong data: the invite sent to a bounced address, the sponsor pitch aimed at someone who left investing last year. This skill treats freshness as a pipeline, not a scrape: identity-resolved, provenance-stamped, diffed against last cycle, and written back only behind a gate.

**Required**: a community profile in `profiles/`, a member export or platform API read, and enrichment reach — Context.dev through Opulent's native integration, open web search and fetch, and browser automation as last resort. Lane two additionally needs the ICP and exclusion blocks filled in.

## Ownership

This skill owns the record lifecycle: ingest, re-enrich, resolve, diff, report, and the *payloads* for writeback and invitations. It does not own the send. The community platform's existing automated emails do the inviting; the platform API does the writing; a person approves both. "Investor" throughout means a member of the community's investor network; the discovery lane recruits event attendees and sponsors.

**Output directory**: `/opulent/workspace/networks/{community_slug}/` — persistent across cycles, not per-run. Each cycle lands in `cycles/{YYYY-MM-DD}/`, canonical state lives in `members.json`, and the change history in `changes.jsonl`.

---

## Evidence discipline

Borrowed whole from Opulent's GTM intelligence system, because it is the part that keeps this defensible:

- Every material field carries a confidence label: **`Verified`** (dated source in hand), **`Estimated`** (inferred, inputs shown), or **`Unknown`**. Absence of evidence is context, not a finding.
- Every field carries provenance: `source`, `source_url`, `observed_at`. A value with no provenance does not overwrite a value that has it.
- **Email is the one field marked *required and current*, which makes it the one field where a guess is sabotage.** An email is `verified`, `accept_all`, `unknown`, or `bounced`. A pattern-inferred address is recorded as `candidate` and stays out of writeback until a verifier promotes it.
- **"Still actively investing" is an evidence conclusion, not a vibe.** It requires a dated public signal inside the recency window (default 12 months): a disclosed investment, a fund announcement, board seat activity, or the member saying so. No signal in window → `Unknown`, not `false`. Leaving investing is `Verified` only with an explicit signal (operator role announcement, fund wind-down, the member's own statement).
- Conflicts resolve by the profile's precedence ladder (default: `member_confirmed` > `linkedin_profile` > `contextdev` > `web_public` > `platform_record` > `inferred`), then by recency within the same rung. The loser is kept in `history`, not deleted. **`platform_record` sits near the bottom deliberately** — it is the baseline being refreshed, so ranking it above fresh enrichment would reject every real update as a conflict and the skill could never do its job. Only a member's own confirmation outranks a fresh observation.

## Source discipline

- **Cheapest first**: platform export/API → Context.dev → open web search and fetch → a browser session only for dynamic or authenticated surfaces. One retrieval per unique identity per cycle; reuse across the cohort.
- **Context.dev operations are written as contracts, never vague verbs.** Each proposed call records `natural_language_job`, method, full endpoint, body, `write_policy`, and `status` (`proposed` → executed with receipt). Base `https://api.context.dev/v1`, bearer `CONTEXT_DEV_API_KEY`, tagged `client:{slug}`, `app:enriching-investor-networks`, `run:{cycle}`. See `references/enrichment-sources.md`.
- **LinkedIn is member-consented ground, not open range.** Members joined the community and supplied their URLs — that is the basis for looking at their public profiles, at human pace, in an authenticated session the user owns. Live-view handoff for login; stop at the first interstitial; never a captcha. Prefer official exports and the platform's own record wherever they exist.
- Rate discipline everywhere: sequential per source, one cycle per cadence window, stop-on-block rather than retry-through.

## Writeback and invitations are gated

Reading is unattended; writing never is.

| Action | Gate |
|---|---|
| Ingest, enrich, diff, report | None — runs on schedule |
| Writeback to platform API | One blocking question, with field-level counts and the dry-run diff |
| Invitation handoff | One blocking question per batch, after suppression, with the prospect list visible |
| Direct outreach by this skill | Out of scope — the platform's existing automated emails send; this skill queues |

- Writeback is **dry-run by default**: `writeback.json` is always produced; pushing it requires approval. Every pushed field needs a record match, an idempotency key (`member_id + field + observed_at`), and read-after-write verification — a 200 is not proof the field took.
- Bounces feed back: a `bounced` email revokes `current`, opens a re-verification task, and suppresses the member from invitation sends until repaired.
- Suppression before approval, always: existing members, the exclusions list, prior declines, unsubscribes, and anyone with outreach state not in `none|expired`. A prospect the community already knows is not a prospect.

---

## Pipeline Overview

Nine steps. Lane one is 0–6; lane two is 7–8 and can run the same cycle or independently.

0. **Setup** — workspace, cycle folder, previous-state check
1. **Load community profile** — `profiles/{community_slug}.json`
2. **Ingest members** — platform API/export → canonical baseline
3. **Enrich wave** — capped, batched, cheapest-source-first observations
4. **Resolve + diff** — `diff_enrichment.mjs`: identity resolution, precedence, typed changes
5. **Verify emails** — the required-and-current contract
6. **Report + writeback payload** — `compile_refresh.mjs`, then the gate
7. **Discover prospects** — sponsors and investors against the profile ICPs
8. **Gate + hand off** — `gate_prospects.mjs` suppression → approval → invitation queue

Invoke with `/enriching-investor-networks [--community <slug>] [--cycle YYYY-MM-DD] [--lane refresh|grow|both] [--push]`. Defaults: `both`, today's date, dry-run. `--push` does not skip the gate; it only pre-selects the affirmative.

---

## Step 0: Setup

```bash
COMMUNITY=${COMMUNITY:-default}
WORKSPACE=/opulent/workspace/networks/${COMMUNITY}
CYCLE=$(date +%Y-%m-%d)
mkdir -p "$WORKSPACE/cycles/$CYCLE/observations" "$WORKSPACE/cycles/$CYCLE/prospects"
ls "$WORKSPACE/members.json" 2>/dev/null || echo "FIRST CYCLE — baseline will be ingested, every field will read as new"
```

First cycle produces no change events — there is nothing to diff against. Say so rather than manufacturing a delta.

## Step 1: Load Community Profile

The profile is the contract: schema, cadence, sources policy, precedence ladder, ICPs, exclusions, API shape. Load `profiles/{community_slug}.json`; `example.json` is a template, never a live profile. Zero profiles → **fail loudly** with the discovery packet from `references/writeback-and-invites.md` — the schema and API questions a new community engagement must answer before the first cycle. Do not improvise a schema.

Cadence guard: if the last completed cycle is younger than `cadence_days.min`, stop and say when the window opens. Re-enriching 1,200 people a week early is spend without information.

## Step 2: Ingest Members

Platform API read or CSV export → `cycles/{date}/ingest.jsonl`, one record per member, then merge into canonical `members.json` keyed by `member_id`. Identity keys, in order: `linkedin_url` (normalized) → `email` → `name + organization`. Records that collapse under one identity merge with provenance intact; records with no identity key are counted and quarantined, not dropped silently.

The member schema is the profile's `fields` block — for a VC-community shape: phone (optional), email (required + current), industries, title, organization, location, LinkedIn headline, LinkedIn about, `actively_investing`, plus the change log. Store what the platform sent as `platform_record` provenance; it is a source, not the truth.

## Step 3: Enrich Wave

**HARD CAP: 3 retrievals per member per cycle** — one profile read, one organization check, one email verification. Members whose last cycle produced zero changes and whose email is `verified` inside the window get the *light pass* (profile read only). New members and anyone carrying an open re-verification task get the full pass.

Batch ~10 members per subagent, waves sized by the profile's `concurrency`, prompts from `references/workflow.md`. Observations land as `cycles/{date}/observations/{member_id}.json` — raw, per-source, provenance-stamped, no merging in the subagent. Anti-hallucination rules from the workflow reference apply verbatim: quote the line that supports the field, `Unknown` over inference, typography is not evidence of anything.

## Step 4: Resolve + Diff

```bash
node {SKILL_DIR}/scripts/diff_enrichment.mjs "$WORKSPACE" --cycle "$CYCLE"
```

Merges observations onto the baseline through the precedence ladder, then emits typed change events to `changes.jsonl` and the cycle folder:

| Event | Fired when |
|---|---|
| `contact_change` | Email or phone value or verification state moves |
| `role_change` | Title changes at the same organization |
| `org_change` | Organization changes (usually paired with `role_change`) |
| `location_change` | Location moves |
| `profile_change` | Headline or about text materially changes |
| `investing_status_change` | `actively_investing` transitions, with its evidence |
| `new_member` | Identity appears that the baseline lacked |
| `conflict_resolved` | Two sources disagreed; ladder decided; loser kept in history |

Every event: `member_id`, `field`, `before`, `after`, `source`, `source_url`, `observed_at`, `confidence`. Re-running the same cycle emits zero events — the diff is idempotent, so a crashed run resumes safely.

## Step 5: Verify Emails

The one required-and-current field gets its own pass. For every member whose email is not `verified` inside the cadence window: verification call (provider per profile), state recorded as `verified | accept_all | unknown | bounced` with checked-at. `bounced` → `contact_change` event + re-verification task + invitation suppression. **No pattern-guessing into the writeback.** A `candidate` address found during enrichment stays labeled `candidate` until verification promotes it.

## Step 6: Report + Writeback

```bash
node {SKILL_DIR}/scripts/compile_refresh.mjs "$WORKSPACE" --cycle "$CYCLE"
```

Produces `refresh.html` (changes first, grouped by member; quiet members collapsed), `changes.csv`, `writeback.json` — the API-ready payload, every field carrying value + provenance + confidence — and `summary.json`. Surface the table with an interactive table artifact, then gate:

```
a blocking question {
  question: "Push {n} field updates for {m} members to {platform}? ({k} emails re-verified, {j} bounced, {i} investing-status changes)",
  fields: [{ name: "approve", label: "Push writeback", type: "confirm", required: true }],
  reason: "Writes to the community's live member database. Dry-run payload is in writeback.json — nothing has left the workspace.",
  urgency: "blocking"
}
```

On approval: idempotent PUTs, read-after-write per record, receipts into the cycle folder. Unverified writes are reported `blocked`, not assumed.

## Step 7: Discover Prospects

Lane two. Two ICPs from the profile — `sponsor_icp` (companies that buy event sponsorships: stage-services vendors, banks, platforms serving the member base) and `investor_icp` (investors who belong in the room as community members and event attendees). Discovery mirrors the researching-companies pattern: diverse search queries, Context.dev company resolution per unique domain, one retrieval per candidate, evidence quoted. Each prospect lands in `cycles/{date}/prospects/found.jsonl` with `kind: sponsor|investor`, the ICP evidence line, and source. Caps in `references/workflow.md`.

## Step 8: Gate + Hand Off

```bash
node {SKILL_DIR}/scripts/gate_prospects.mjs "$WORKSPACE" --cycle "$CYCLE"
```

Suppression first — against `members.json`, `exclusions`, prior outreach states — writing `eligible.jsonl` and `suppressed.jsonl` *with reasons*. Then the approval gate with the eligible list visible. Approved prospects go to `invite_queue.json` in the platform's invitation-system shape with state `queued`; the platform's existing automated emails take it from there. State transitions (`queued → invited → responded | bounced | declined`) sync back next cycle and feed future suppression.

Close the cycle with the summary:

```
## Network cycle — {community}, {date}

- **Members**: {n} ingested · {k} enriched (full {f} / light {l}) · {q} quarantined no-identity
- **Changes**: {n} ({role_change} roles · {org_change} orgs · {contact_change} contact · {investing_status_change} investing)
- **Emails**: {verified} verified · {bounced} bounced → re-verification queue
- **Writeback**: {pushed|dry-run} — {n} fields across {m} members
- **Prospects**: {found} found → {eligible} eligible ({suppressed} suppressed) → {queued} queued
- **Next cycle**: {date + cadence}
```

Register the recurring run with a scheduled automation on the profile's cadence. The cycle is idempotent end to end — a retry after a crash re-emits nothing.

---

## Failure modes worth naming

| Symptom | Cause | Fix |
|---|---|---|
| Every member "changed" on cycle two | Baseline stored formatted values, observations raw | Normalize before diff — the script does; don't pre-format ingest |
| Bounce rate spikes after writeback | `candidate` emails promoted without verification | They never promote automatically; find who bypassed Step 5 |
| Same person, two member records | Identity keys missing on both rows | Merge by `name+organization` manually once, record the alias in `members.json` |
| Prospect list full of current members | Gate ran against a stale `members.json` | Gate always runs after ingest, never before |
| `actively_investing` flips false en masse | Recency window treated absence as negative | Absence is `Unknown`; only dated evidence flips the flag |
| Platform rejects writeback rows | Schema drift since the profile was written | Re-run the discovery packet; update `fields` + `api` blocks; don't force-map |
