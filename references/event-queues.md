# Event queues

Lane two builds two ranked queues for **one named event**: who should sponsor it, and who should be in the room. Open-ended prospecting produces a list nobody can act on; an event gives the work a date, a capacity, and a reason to engage now.

## The event brief

Everything below comes from the profile's `events` block or from the user before the lane runs. A missing input is a named `blocked`, not a guess.

| Input | Why the queue needs it |
|---|---|
| Audience criteria | Who this room is for — the attendee gate |
| Sponsor criteria | What a sponsor of this event looks like — the sponsor gate |
| Prior attendees | Relationship history, and the strongest single reason to engage |
| Current RSVP state | Someone already coming is not a prospect |
| Sponsor commitments | Sold tiers, and who is already in conversation |
| Venue capacity + event status | The queue is ranked because capacity is finite |
| Must-invite rules | Names that skip fit scoring |
| Do-not-invite rules | Names that skip everything |
| Competitor and conflict exclusions | A sponsor's competitor in the room is a sponsor problem |

Capacity is what makes the ranking load-bearing. Without it the queue is a list; with it, position matters and the cutoff is a real decision.

## Company gate before person enrichment

The ordering is fixed, and it is the single biggest lever on both cost and quality:

**1 · Discover broadly.** Companies that could sponsor or send attendees — from search, the community's own history, and prior events. Resolve to a canonical domain and dedupe there. One company result is reused across every person at that company.

**2 · Gate the companies.** One cheap pass per company against the event's sponsor or audience criteria. Every gate result carries a quoted evidence line and a verdict. Companies below the threshold **stop here** and keep their rejection reason.

**3 · Enrich people only at companies that passed.** Current role, contact path, recent activity, relationship history with the community.

**4 · Rank.** Component scores stay visible in the output — fit, timing, relationship. A single opaque number is a score nobody can argue with, which means it is a score nobody checks.

Enriching a person at a company that was never going to qualify is the most common way this lane wastes a budget. The gate exists to make that impossible rather than merely discouraged.

## One reason to engage now

Every recommended person carries exactly one reason, and it is **dated, truthful, and event-scoped**.

Signals that count, strongest first:
- A new fund, financing, hire, expansion, or leadership move inside the recency window
- Prior attendance at a community event, with the event named
- Public activity that maps to this event's theme — a talk, a post, a thesis
- Event fit itself, said plainly, when no dated signal exists

Relationship language is precise or absent. Co-attendance is co-attendance; it is not familiarity, and it is never a warm introduction unless someone has agreed to make one. A reason that overstates the relationship is worse than no reason, because it fails in the reply.

## Suppression, then review

Suppression is mechanical and runs first, in this order, each with a recorded reason:

1. Already a member, already RSVP'd, or already invited to this event
2. Do-not-invite and exclusion lists
3. Outreach memory — pending, declined inside cooldown, unsubscribed
4. Any contact that has hard-bounced

**Must-invite bypasses fit scoring, never suppression.** When a name appears on both the must-invite and do-not-contact lists, that conflict is surfaced to the owner rather than resolved silently — either answer could be the wrong one, and the skill does not have the context to choose.

Then a human reviews, in three states, on both the candidate and the message:

- **approve** — enters the queue
- **hold** — right person, wrong time or wrong message; returns next event with the reason recorded
- **reject** — wrong person for this community; feeds suppression for future cycles

## Output

Under `cycles/{date}/events/{event_slug}/`:

| File | Contents |
|---|---|
| `brief.json` | The resolved event brief, including what was missing |
| `companies.jsonl` | Every company discovered, with gate verdict and evidence — passes **and** rejections |
| `sponsors.jsonl` | Ranked sponsor queue |
| `attendees.jsonl` | Ranked attendee queue |
| `suppressed.jsonl` | Every suppression with its reason |
| `review.json` | Per-candidate and per-message verdicts once the owner has been through it |

Both queues carry, per row: gate result, component scores, evidence with source and date, relationship state, the one reason to engage, and review status.

## After delivery

The lane does not end at the send. Replies, bounces, opt-outs, and suppression events sync back on the next cycle and do three things: update outreach memory, revoke a `verified` email that bounced, and sharpen the next event's gate. An event whose accepted candidates all came from one company profile is telling you something about the gate; an event whose approvals were mostly held is telling you something about the timing.
