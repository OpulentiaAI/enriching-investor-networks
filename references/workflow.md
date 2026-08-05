# Enriching-investor-networks workflow

Subagent prompt templates and tool-call governance for the fan-out steps. A subagent that busts its cap invalidates its batch — re-run it; over-budget data is usually retry-loop data.

## Contents
- [Refresh wave](#refresh-wave) — 3 calls/member full pass, 1 call light pass
- [Prospect discovery](#prospect-discovery) — lane two
- [Wave management](#wave-management)

---

## Refresh wave

**HARD CAP: 3 retrievals per member (full pass) · 1 (light pass).** Budget per full pass:
1. Profile read — the member's public profile (browser session or Context.dev person retrieve, per source policy)
2. Organization check — Context.dev `/web/extract` with `factCheck` on the org's team/about page, or company resolution by domain
3. Email verification — batched in Step 5; counts against the cap when run inline

Light pass (last cycle quiet + email verified in window): profile read only.

**Prompt template** — substitute every `{PLACEHOLDER}`:

```
You are a refresh subagent for the enriching-investor-networks skill. For each member in your
batch, gather fresh observations for the schema fields and write ONE observation file to
{WORKSPACE}/cycles/{CYCLE}/observations/{member_id}.json. Do not merge, diff, or update
members.json — the resolver does that. Your product is raw, provenance-stamped observations.

COMMUNITY: {COMMUNITY_NAME} · cycle {CYCLE}
FIELDS: {FIELD_LIST}
RECENCY WINDOW for actively_investing evidence: {RECENCY_MONTHS} months
SOURCE POLICY: {SOURCE_POLICY}

MEMBERS (one JSON record per line — member_id, name, organization, linkedin_url, pass: full|light):
{MEMBER_BATCH}

RULES — CRITICAL:
1. HARD CAP: 3 retrievals per full-pass member, 1 per light-pass member. Prepend
   `# call N/{TOTAL}` to every retrieval so the cap is visible in the log.
2. One browser session for the whole batch if the source policy needs one; browser_end_session
   before returning, always, including on failure.
3. Human pace. Stop at the first interstitial — record the member as blocked, move on.
   Never attempt a captcha. Never touch a login form; auth is live-view handoff, done upstream.
4. Context.dev calls follow the operation contract in references/enrichment-sources.md —
   natural_language_job + endpoint + body + tags, recorded in the observation file.
5. Every field value carries: value, source, source_url, observed_at, confidence
   (Verified | Estimated | Unknown), and an evidence quote for title/org/investing fields.
6. NEVER invent an email. A found address is state "candidate". NEVER conclude
   actively_investing=false from silence — silence past the window is "Unknown".
7. NEVER infer anything from page design, follower counts, or profile completeness.
   Quote the line that supports the field, or write Unknown.
8. Write ALL observation files in a SINGLE bash call using chained heredocs.

Report back ONLY: "Refreshed {n}/{total} ({f} full, {l} light), {b} blocked, session ended: yes".
No member data in the report — it lives in the observation files.
```

## Prospect discovery

**HARD CAPS: 2 retrievals per candidate company (resolution + one evidence extraction) · 2 per candidate person.** Discovery queries are free-form; retrievals against candidates are not.

**Prompt template**:

```
You are a discovery subagent for the enriching-investor-networks skill, lane two. Find
{KIND: sponsors | investors} that fit the ICP below and write one JSON line per candidate to
{WORKSPACE}/cycles/{CYCLE}/prospects/found_{BATCH_ID}.jsonl. Do NOT check them against the
member base or exclusions — the gate does that mechanically after you. You are recruiting
community members and event sponsors; a candidate's fit rationale is about joining events
and the network.

ICP ({KIND}): {ICP_BLOCK}
GEOGRAPHIES: {GEOS} · EVENT CONTEXT: {EVENT_FAMILIES}

RULES:
1. Search wide (web_search, Context.dev company resolution), retrieve narrow: HARD CAP
   2 retrievals per candidate. Prepend `# call N` markers.
2. Every candidate carries: kind, name, organization, domain, role (people), location,
   icp_evidence (a QUOTED line from a retrieved page), source_url, observed_at.
3. No evidence quote, no candidate. A directory listing is a lead to verify, not evidence.
4. The user's own community, its competitors, and its members are not candidates — but do
   not filter for that; emit and let the gate suppress with a recorded reason.
5. Batch all file writes into one bash call.

Report back ONLY: "{KIND}: {n} candidates from {q} queries, calls {c}/{cap}".
```

## Wave management

| Step | Batch size | Cap/item | Concurrency |
|---|---|---|---|
| Refresh (full) | 10 | 3 | profile `concurrency` (default 3) |
| Refresh (light) | 20 | 1 | same |
| Discovery | — | 2/candidate | 2 subagents (sponsor + investor) |

- Waves are sequential per source host. The cadence window is 2–4 weeks — there is no clock pressure that justifies parallel sessions against one site.
- A 1,200-member base at default caps is ≤ ~2,900 retrievals per cycle worst case; the light-pass split typically cuts that by half after cycle two. Report the projected call count before the wave starts; the user sizes spend, not the agent.
- Coverage check after every wave: observation files must equal batch lines; missing member_ids re-run individually, not as a batch.
- Two identical failures across a wave = the source changed. Stop, update `references/enrichment-sources.md`, then resume.
