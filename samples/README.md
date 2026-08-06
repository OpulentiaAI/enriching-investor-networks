# Sample inputs — one enrichment cycle

An offline fixture that runs both lanes with no network and no API keys.

## What's real and what isn't

**Real**: the Context.dev capability surface and operation-contract shape in [`../references/enrichment-sources.md`](../references/enrichment-sources.md), checked against context.dev on 2026-08-05 — base `https://api.context.dev/v1`, bearer auth, company resolution, person retrieve, `/web/extract` with caller-supplied schema and `factCheck`, change monitors with webhooks, and credit-per-page pricing. The evidence, precedence, and receipt discipline is carried over from Opulent's GTM intelligence system.

**Synthetic**: every member, prospect, organization, and domain under `fixture/` is invented — `.test` hosts throughout, so nothing resolves. No real person's contact record is in this repo.

---

## Run it

```bash
cp -R samples/fixture /tmp/net-ws && node scripts/diff_enrichment.mjs /tmp/net-ws --cycle 2026-08-05 && node scripts/gate_prospects.mjs /tmp/net-ws --cycle 2026-08-05 && node scripts/compile_refresh.mjs /tmp/net-ws --cycle 2026-08-05 --open
```

Expected:

```
observations: 10 files (1 malformed, 1 quarantined)
members: 9   events: 12
  conflict_resolved 1 · contact_change 3 · investing_status_change 2
  location_change 1 · new_member 1 · org_change 2 · role_change 2

prospects: 7 read (1 malformed) → 3 eligible · 3 suppressed
writeback: 6 entries (dry run)
```

## What each fixture case proves

| Member | Case |
|---|---|
| `m-001` | Stale platform values (`Principal @ Ashgrove Capital`) lose to a fresh LinkedIn read → paired `role_change` + `org_change`, both carrying the headline that proves them. **This is the whole point of the ladder order** — see below. |
| `m-002` | Email hard-bounces → `contact_change` on `email_status`, and its last investing signal (2025-06-01) falls outside the 12-month window → `investing_status_change` to **`Unknown`, not `false`**. Absence downgrades; it never flips. |
| `m-003` | Observation matches the stored value exactly → **no event**, provenance refreshed silently. Quiet members are the majority in a healthy cycle. |
| `m-004` | `location_change` Chicago → Denver. |
| `m-005` | Context.dev returns `Yoshinova Partners` (`Estimated`) against a `member_confirmed` `Yoshi Capital` → **`conflict_resolved`**: the member's own confirmation wins, the rejected value is kept in `history` rather than discarded. |
| `m-006` | Explicit dated evidence of leaving investing (`"COO @ Meridian Systems"`) → `investing_status_change` to `false`. The only way that flag reaches `false`. |
| `m-007` | A pattern-inferred address is recorded as **`candidate`** and appears in the report — but is **withheld from `writeback.json`**. Only `email_status` pushes. |
| `Béatrice Nuñez` | An observation with no matching baseline → `new_member`, with the unicode name slugged correctly for the member id. |
| `broken.json` | Malformed JSON counted, not fatal. |
| `no-identity.json` | No URL, no email, no name+org → **quarantined with a reason**, never slugged into a fake identity. |

### The ladder order is load-bearing

The default precedence is:

```
member_confirmed > linkedin_profile > contextdev > web_public > platform_record > inferred
```

`platform_record` sits **near the bottom on purpose**. It is the baseline being refreshed — if it outranked fresh enrichment, every real update would be rejected as a conflict and the skill could never do its job. Building this fixture is what surfaced that: an earlier draft ranked `platform_record` second and produced four spurious `conflict_resolved` events instead of the two `role_change`/`org_change` pairs it should have. Only `member_confirmed` outranks a fresh observation, because a member correcting their own record beats any scraper.

### Event gate cases

Run lane two scoped to the shipped event brief:

```bash
node scripts/gate_prospects.mjs /tmp/net-ws --cycle 2026-08-05 --event harbor-dinner-2026-09
```

`1 eligible · 5 suppressed · 1 conflict`, and each outcome proves a different rule:

| Prospect | Outcome |
|---|---|
| Amaka Obi | **eligible** — on `must_invite`, and nothing suppresses her |
| Beacon Fund Services | `event:already_rsvpd` — matched the RSVP export by **organization**, not by person name. Sponsor rows are companies with no person on them, which is exactly the match the first version of this gate missed |
| Ledgerline Legal | `event:conflict_exclusion` — domain on the event's conflict list |
| Selin Osman | `member:already_in_community` |
| Rival Community Co | `exclusion:profile_list` |
| Casper Lindgren | `outreach:declined_35d_ago (cooldown 180d)` |
| **Ingrid Solberg** | **`conflicts.jsonl`** — on `must_invite` *and* `do_not_invite`. Must-invite bypasses fit scoring; it never bypasses suppression. The gate surfaces the contradiction and lets the owner decide rather than picking a side |

Without `--event`, the same fixture gives `4 eligible · 3 suppressed` — community-wide rules only. An unknown `--event` slug exits 1 rather than silently falling back to the community-wide gate.

### Gate cases

| Prospect | Outcome |
|---|---|
| Beacon Fund Services | **eligible** — sponsor ICP evidence quoted |
| Amaka Obi | **eligible** — investor, no prior contact |
| Ledgerline Legal | **eligible** — sponsor |
| Selin Osman | suppressed `member:already_in_community` — matched an existing member by LinkedIn URL |
| Rival Community Co | suppressed `exclusion:profile_list` — domain on the profile's exclusion list |
| Casper Lindgren | suppressed `outreach:declined_35d_ago (cooldown 180d)` — declined inside the cooldown |

Every suppression is written to `suppressed.jsonl` **with its reason**. A gate bug in either direction sends a real email, so its passes and its blocks get audited equally.

## Idempotency

Re-run the diff on the same cycle:

```bash
node scripts/diff_enrichment.mjs /tmp/net-ws --cycle 2026-08-05
```

It emits **0 events**, appends nothing to `changes.jsonl`, and leaves `cycles/2026-08-05/events.jsonl` intact at 12 lines — the cycle file is rebuilt from the append-only log rather than from just this run's emissions, so a retry after a crash is safe and never blanks the record.

## Before a real cycle

Copy `profiles/example.json` to `profiles/<community>.json` and answer the eight-item discovery packet in [`../references/writeback-and-invites.md`](../references/writeback-and-invites.md) — schema, API and idempotency behavior, source policy, the definition of "still actively investing", conflict rules, ICPs and exclusions, the invitation system's objects and unsubscribe behavior, and where in the 2–4 week band the cadence sits. Unanswered items surface as named `blocked` entries in cycle one rather than as guesses.
