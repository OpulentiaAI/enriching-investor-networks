# Enrichment sources

The source ladder, the Context.dev operation contract, and the discipline per rung. The rule that orders everything: **cheapest first, one retrieval per unique identity per cycle, provenance on every value.**

## The ladder

| Rung | Source | Use for | Cost |
|---|---|---|---|
| 1 | Platform record / export | Baseline, member_id join, outreach states | Free — it's the client's own data |
| 2 | Context.dev | Company resolution by domain, person retrieve, structured extraction with `factCheck`, change monitors | Credits — 1/page, no failure multipliers |
| 3 | `web_search` / `web_fetch` | Open discovery, dated public signals (fund announcements, press) | Cheap |
| 4 | `browser_*` | Dynamic or authenticated surfaces only | Expensive — session + slot |

Never use rung 4 for what rung 2 answers. A browser session that reads a static page is a concurrency slot spent on nothing.

## Context.dev, natively through Opulent

Context.dev is Opulent's structured public-web execution layer: it resolves companies, enriches known people, extracts fact-checked JSON against caller schemas, and maintains change baselines with webhooks. It does not replace the platform record, corroboration, or the browser for authenticated work.

- Base `https://api.context.dev/v1` · header `Authorization: Bearer $CONTEXT_DEV_API_KEY` (server-side only, never logged)
- Seeded helper: `node lib/context-dev.mjs --url <url> --schema <file|json|-> --out <path>` via `bash_run`
- Tag every consequential call: `client:{community_slug}`, `app:enriching-investor-networks`, `run:{cycle}`, `env:production`

**Every operation is written as a contract, never a vague verb.** The shape, recorded in the cycle folder whether proposed or executed:

```yaml
natural_language_job: "Re-check this member's current organization and title from their public profile and the org's team page; return only source-grounded fields with dates."
method: POST
endpoint: https://api.context.dev/v1/web/extract
body:
  url: https://example.org/team
  instructions: Extract this person's current title and organization. Preserve the page date. Null anything unsupported.
  schema: {type: object, properties: {title: {type: string}, organization: {type: string}, as_of: {type: string}}}
  factCheck: true
  tags: [client:harborlight, app:enriching-investor-networks, run:2026-08-05]
write_policy: review_required
status: proposed        # → executed, with receipt + credit usage
receipt: null
```

Useful endpoints for this skill: company resolution (domain/email/name → firmographics, industry codes), person retrieve for known identities, `/web/extract` with schema + `factCheck` for team pages and fund announcements, and **change monitors** — page/sitemap-level baselines with webhook notification, the right tool for "tell me when this fund's team page changes" between cycles.

## LinkedIn discipline

Members supplied their LinkedIn URLs when they joined the community — that is the basis for reading their public profiles on their behalf. It is not a license to scrape.

- Authenticated session belongs to the user: live-view handoff for login, session persists in the thread's browser context thereafter.
- Human pace, sequential, one profile per member per cycle. The light pass skips even that for members with no open questions.
- **Stop at the first interstitial.** A challenge page is a stop sign; report the member as `blocked` this cycle and move on. Never a captcha, ever.
- Prefer the export: if the community can pull a LinkedIn/CSV export or the member confirms details directly, both outrank a profile read on the precedence ladder anyway.
- Store what the profile *says*, quoted — headline and about text verbatim, title/org as displayed. Paraphrase is where drift starts.

## Email verification states

Email is the required-and-current field, so it gets a state machine instead of a string:

| State | Meaning | Writeback |
|---|---|---|
| `verified` | Verification provider confirmed deliverable, inside the cadence window | Yes — as current |
| `accept_all` | Domain accepts everything; deliverability unprovable | Yes — flagged `accept_all` |
| `unknown` | Not yet checked this window, or provider inconclusive | Carries prior value; opens task |
| `bounced` | Hard bounce observed | Revokes current; re-verification task; invitation suppression |
| `candidate` | Found or pattern-inferred during enrichment, unverified | **Never** — promotes only through verification |

The provider is set in the profile (`email_verification.provider`); calls are batched in Step 5, one per member needing a check. A `candidate` that verifies becomes the new value with the verification as provenance. A `candidate` that bounces is discarded, and the discovery source gets a reliability note.

## Provenance record

Every field value in `members.json` is stored as:

```json
{
  "value": "Partner, Harborlight Ventures",
  "confidence": "Verified",
  "source": "linkedin_profile",
  "source_url": "https://linkedin.com/in/example",
  "observed_at": "2026-08-05",
  "history": [
    {"value": "Principal, Ashgrove Capital", "source": "platform_record", "observed_at": "2026-06-12", "superseded_by": "precedence:linkedin_profile"}
  ]
}
```

The `history` array is why conflicts are cheap: the ladder decides, nothing is lost, and a wrong resolution is reversible by pointing at the record.

## Precedence ladder

Default, overridable per profile:

```
member_confirmed > platform_record > linkedin_profile > contextdev > web_public > inferred
```

Within a rung, recency wins. Across rungs, the ladder wins even against fresher data — a member's own confirmation from May beats a scraper's guess from today. `inferred` values (an `Estimated` title from a fund's strategy page, say) exist to be displayed with their label, never to overwrite anything above them.
