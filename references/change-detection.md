# Change detection

Static data establishes context; a **dated change** creates a reason to act. The refresh lane's real product is not the fresh record — it is the typed, evidenced delta between last cycle and this one.

## Identity resolution

Before any diff, records must collapse to one identity. Keys in order:

1. **`linkedin_url`** — normalized: host lowercased, `www.` stripped, path lowercased, trailing slash and query dropped. The strongest key because the community collected it at signup.
2. **`email`** — lowercased. Secondary because emails change; that's half the point of the skill.
3. **`name + organization`** — slugified pair. Weakest; org moves break it, so it only binds when neither URL nor email exists.

Two baseline records collapsing under one key merge with both provenance trails kept. An observation matching no baseline identity becomes `new_member`. A record with no key at all is quarantined and counted — never silently dropped, never slugged into a fake identity.

## Diff semantics

- **Normalize before comparing**: strip formatting (thousands separators, smart quotes, trailing whitespace), fold case for orgs only when the difference is pure casing. `&nbsp;` and empty string are `null`, and `null → null` is not a change.
- **Value change vs state change**: an email moving `a@x.com → b@y.com` is a value change; `verified → bounced` on the same address is a state change. Both are `contact_change`, distinguished by `field`.
- **Material profile text**: headline/about diffs fire only when normalized text differs beyond whitespace and punctuation. Record both versions; the digest shows a trimmed delta.
- **Paired events stay paired**: an org move usually produces `org_change` + `role_change` with the same `observed_at` and source. Do not collapse them — downstream consumers (the sponsor lane, the platform) subscribe to different types.

## The change event

Modeled on Opulent's GTM signal contract — a fact is not a signal until it says what changed, when, how it's proven, and why it matters:

```json
{
  "member_id": "m-0412",
  "type": "org_change",
  "field": "organization",
  "before": "Ashgrove Capital",
  "after": "Harborlight Ventures",
  "observed_at": "2026-08-05",
  "effective_at": "2026-07-01",
  "source": "linkedin_profile",
  "source_url": "https://linkedin.com/in/example",
  "confidence": "Verified",
  "evidence": "Profile headline: \"Partner @ Harborlight Ventures — early-stage fintech\"",
  "cycle": "2026-08-05"
}
```

`observed_at` is when we saw it; `effective_at` is when it happened, when the source dates it. If the previous state cannot be proven, the event still fires with `before: null` and describes the observable fact — no invented deltas.

## "Still actively investing"

The field clients ask for and the field easiest to get wrong. It is an **evidence conclusion with a recency window** (profile default: 12 months), not a profile-text inference.

Evidence that counts, each with a date:

- A disclosed investment (press, portfolio page addition, filing) inside the window
- A fund announcement or close where the member is a named GP/partner
- New board seat or lead-round attribution inside the window
- The member's own statement (to the community, on the record)

Evidence that does not count: a title containing "investor", follower counts, event attendance, profile completeness, or last cycle's `true` carried forward past the window.

Transitions:

| From → To | Requires |
|---|---|
| `true → Unknown` | Window expired with no new signal. **This is the default decay** — absence downgrades, never flips |
| `→ false` | Explicit dated evidence: operator-role announcement, fund wind-down, member statement |
| `Unknown → true` | Any counting evidence inside the window |

`investing_status_change` events carry the evidence quote. A mass flip to `false` in one cycle is a bug in the window logic, not a market event — the failure-modes table in SKILL.md names it.

## Idempotency contract

- The diff compares canonical state against the **named cycle's** observations. Re-running the same cycle emits zero events and changes zero bytes of `changes.jsonl`.
- Events are keyed `member_id + type + field + before + after + cycle`; a crashed run that half-wrote resumes by re-running the whole diff.
- `changes.jsonl` is append-only across cycles. Corrections are new events (`type: "correction"`, referencing the corrected event), never edits — same discipline as any audit trail worth the name.
- Cycle folders keep raw observations forever. Re-parse freely; re-fetch never.

## What feeds forward

Changes are not just report rows:

- `contact_change` with `bounced` → Step 5 re-verification queue + invitation suppression
- `org_change` on an investor at a fund the sponsor ICP covers → lane-two candidate signal
- `investing_status_change → false` → platform flag proposal (writeback), never silent removal
- `new_member` in observations that came from the *prospect* lane → the gate caught a suppression miss; fix the gate ordering before trusting the cycle
