# Writeback and invitations

The two places this skill touches the outside world, and the gates on both. The principle, borrowed from Opulent's GTM system-actions contract: **drafts by default; a verified write needs a record match, an idempotency key, and read-after-write evidence; otherwise it is reported `proposed` or `blocked` — in that vocabulary, plainly.**

## Writeback contract

The community platform exposes a REST API (shape in the profile's `api` block). The skill's terminal artifact is `writeback.json` — always produced, never auto-pushed.

### The payload

One entry per member with changed fields, each field carrying its evidence:

```json
{
  "member_id": "m-0412",
  "idempotency_key": "m-0412:organization:2026-08-05",
  "fields": {
    "organization": {
      "value": "Harborlight Ventures",
      "confidence": "Verified",
      "source": "linkedin_profile",
      "source_url": "https://linkedin.com/in/example",
      "observed_at": "2026-08-05"
    },
    "email_status": { "value": "verified", "checked_at": "2026-08-05" }
  }
}
```

If the platform's schema cannot carry provenance, the values still push but the full evidence stays in `members.json` — the platform gets the freshest value, the workspace keeps the proof.

### The push, after approval

1. Record match first — `GET` the member by `member_id`; a missing record is `blocked: no_record_match`, never a create. This skill updates members; it does not mint them.
2. Idempotent `PUT`/`PATCH` per member, keyed as above. A retried push with the same key must be a no-op on the platform side; if the API cannot promise that, push once and verify rather than retry.
3. **Read-after-write per record.** A 200 is not proof the field took. Re-`GET`, compare, then record the receipt (`pushed_at`, response id, verified fields) in the cycle folder.
4. Partial failure is reported per member: `pushed: 41, blocked: 2 (no_record_match), unverified: 1` — not rounded up to success.

### Bounce feedback

The platform is also a source: invitation sends produce bounce data. Each cycle ingests it, and a hard bounce revokes `verified`, fires `contact_change`, opens re-verification, and suppresses the member from sends until a new address verifies. The loop is what keeps "email — required and current" true over quarters, not just on push day.

## Invitation handoff

The community already runs automated invitation emails for sponsors and investors. **This skill never sends.** It delivers approved prospects into that system's queue and tracks state.

### States

```
proposed → eligible → approved → queued → invited → responded | declined | bounced
                     ↘ suppressed (with reason, terminal for the cycle)
```

- `proposed → eligible` is `gate_prospects.mjs` — mechanical suppression, no judgment.
- `eligible → approved` is a human at the `ask_question` gate, with the list and evidence visible. Never auto-approved, never batched past the person.
- `approved → queued` writes `invite_queue.json` in the platform's shape (profile `invites.queue_shape`); the platform's own automation takes it from `queued`.
- `invited → responded/declined/bounced` syncs back next cycle from the platform and feeds suppression memory.

### Suppression rules

Run before every approval gate, in order, each with a recorded reason:

1. **Existing members** — identity match against `members.json` on any key. The most embarrassing invite is to someone already in the room.
2. **Exclusions** — the profile's list: competitors, conflicts, do-not-contact organizations and people.
3. **Outreach memory** — anyone with state not in `none | expired`: pending invites, prior declines (cooldown per profile, default 180 days), unsubscribes (permanent).
4. **Bounced contacts** — no address that ever hard-bounced enters the queue unverified.

`suppressed.jsonl` keeps every suppression with its reason — the gate's output is audited as carefully as its passes, because a suppression bug in either direction is a real-world email.

## The discovery packet

What a new community engagement must answer before cycle one. Asked once, recorded in the profile, re-asked only on drift:

1. A sample of 25–50 member records **and the full destination schema** — field names, types, which are writable.
2. API documentation, sandbox credentials path (env var name, never the value), and writeback rules — upsert vs update, idempotency behavior, rate limits.
3. Source policy confirmation — which enrichment sources are acceptable for this community's members, and the LinkedIn posture.
4. The definition of **"still actively investing"** — what evidence counts, and the recency window.
5. Field-level conflict rules — who wins when the platform and a fresh observation disagree (the precedence ladder, confirmed or amended).
6. Sponsor and investor **ICPs, exclusions, geographies, and approval owners** — who clicks approve, and for which batches.
7. The invitation system's objects — queue shape, template ids, sequence states, and **unsubscribe/suppression behavior** the skill must honor.
8. Cadence — where in the 2–4 week band, and any blackout dates around events.

Every unanswered item is a named `blocked` in the first cycle's report, not a guess. The packet exists so the skill's first real cycle writes into a contract, not into the dark.
