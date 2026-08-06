#!/usr/bin/env node
/**
 * gate_prospects.mjs — mechanical suppression before any human sees the list.
 *
 *   node gate_prospects.mjs <WORKSPACE> --cycle YYYY-MM-DD [--event <slug>] [--profile <path>]
 *
 * Reads   {WORKSPACE}/cycles/{cycle}/prospects/found*.jsonl   discovery output
 *         {WORKSPACE}/members.json                            current member base
 *         {WORKSPACE}/outreach_state.json                     prior invites/declines/unsubs
 *         {WORKSPACE}/profile.json                            exclusions + cooldowns
 * Writes  {WORKSPACE}/cycles/{cycle}/prospects/eligible.jsonl
 *         {WORKSPACE}/cycles/{cycle}/prospects/suppressed.jsonl   every suppression with reason
 *
 * Order matters and is fixed: members → event rules → exclusions → outreach memory.
 * The gate never judges fit — that's the discovery evidence + the human at the review gate.
 * Must-invite bypasses fit scoring, never suppression. A name on both must_invite and a
 * do-not-contact list is surfaced as a conflict for the owner, never resolved silently.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const WORKSPACE = argv[0];
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
if (!WORKSPACE) {
  console.error("usage: node gate_prospects.mjs <WORKSPACE> --cycle YYYY-MM-DD [--profile <path>]");
  process.exit(1);
}
const CYCLE = flag("--cycle", new Date().toISOString().slice(0, 10));
const EVENT_SLUG = flag("--event", null);
const PROFILE_PATH = flag("--profile", join(WORKSPACE, "profile.json"));
const profile = existsSync(PROFILE_PATH) ? JSON.parse(readFileSync(PROFILE_PATH, "utf-8")) : {};
const COOLDOWN_DAYS = profile.outreach?.decline_cooldown_days ?? 180;

/** The event brief scopes lane two. Without one, only the community-wide rules apply. */
const event = EVENT_SLUG
  ? (profile.events?.catalog || []).find((e) => e.slug === EVENT_SLUG) || null
  : null;
if (EVENT_SLUG && !event) {
  console.error(`Event "${EVENT_SLUG}" is not in the profile's events.catalog — add the brief before gating.`);
  process.exit(1);
}

const normalizeUrl = (raw) => {
  if (!raw) return "";
  try {
    const u = new URL(String(raw).startsWith("http") ? raw : `https://${raw}`);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch { return String(raw).toLowerCase().trim(); }
};
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const domainOf = (v) => String(v || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24);

// ---------- member index ----------
const members = existsSync(join(WORKSPACE, "members.json"))
  ? JSON.parse(readFileSync(join(WORKSPACE, "members.json"), "utf-8")).members
  : [];
const memberUrl = new Set(), memberEmail = new Set(), memberNameOrg = new Set();
for (const m of members) {
  if (m.linkedin_url) memberUrl.add(normalizeUrl(m.linkedin_url));
  const email = m.fields?.email?.value;
  if (email) memberEmail.add(String(email).toLowerCase());
  const org = m.fields?.organization?.value;
  if (m.name && org) memberNameOrg.add(`${slug(m.name)}:${slug(org)}`);
}

// ---------- exclusions + outreach memory ----------
const excl = profile.exclusions || {};
const exclOrgs = new Set((excl.organizations || []).map(slug));
const exclDomains = new Set((excl.domains || []).map(domainOf));
const exclPeople = new Set((excl.people || []).map(slug));

const outreach = existsSync(join(WORKSPACE, "outreach_state.json"))
  ? JSON.parse(readFileSync(join(WORKSPACE, "outreach_state.json"), "utf-8"))
  : {};

// ---------- event rules ----------
const eventKeys = (list) => new Set((list || []).flatMap((v) => [slug(v), normalizeUrl(v), String(v).toLowerCase()]).filter(Boolean));
const mustInvite = eventKeys(event?.must_invite);
const doNotInvite = eventKeys(event?.do_not_invite);
const conflictExcl = new Set((event?.conflict_exclusions || []).map(domainOf).filter(Boolean));

/** Anyone already coming, or already asked, is not a prospect for this event. */
const eventDir = event ? join(WORKSPACE, "cycles", CYCLE, "events", event.slug) : null;
const readKeySet = (file) => {
  const out = new Set();
  if (!eventDir || !existsSync(join(eventDir, file))) return out;
  for (const line of readFileSync(join(eventDir, file), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    for (const v of [r.email, r.linkedin_url, r.url]) if (v) out.add(normalizeUrl(v) || String(v).toLowerCase());
    if (r.email) out.add(String(r.email).toLowerCase());
    if (r.name && r.organization) out.add(`${slug(r.name)}:${slug(r.organization)}`);
    // Sponsor rows are companies with no person name — match them on org and domain too.
    if (r.organization) out.add(`org:${slug(r.organization)}`);
    if (r.domain) out.add(`dom:${domainOf(r.domain)}`);
  }
  return out;
};
const rsvped = readKeySet("rsvp.jsonl");
const alreadyInvited = readKeySet("invited.jsonl");

function outreachBlock(keys) {
  for (const key of keys) {
    const rec = key && outreach[key];
    if (!rec) continue;
    const state = rec.state;
    if (state === "unsubscribed") return { reason: "outreach:unsubscribed", key };
    if (state === "bounced") return { reason: "outreach:bounced_contact", key };
    if (state === "declined") {
      const age = daysBetween(rec.at || "1970-01-01", CYCLE);
      if (age < COOLDOWN_DAYS) return { reason: `outreach:declined_${Math.round(age)}d_ago (cooldown ${COOLDOWN_DAYS}d)`, key };
      continue; // expired decline — eligible again
    }
    if (state && state !== "none" && state !== "expired") return { reason: `outreach:${state}`, key };
  }
  return null;
}

// ---------- gate ----------
const pdir = join(WORKSPACE, "cycles", CYCLE, "prospects");
if (!existsSync(pdir)) {
  console.error(`No prospects at ${pdir} — run discovery first.`);
  process.exit(1);
}
const files = readdirSync(pdir).filter((f) => f.startsWith("found") && f.endsWith(".jsonl")).sort();
const eligible = [], suppressed = [], conflicts = [];
let read = 0, malformed = 0;

for (const file of files) {
  for (const line of readFileSync(join(pdir, file), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    read += 1;
    let p;
    try { p = JSON.parse(line); } catch { malformed += 1; continue; }

    const url = normalizeUrl(p.linkedin_url || p.url);
    const email = String(p.email || "").toLowerCase();
    const nameOrg = p.name && p.organization ? `${slug(p.name)}:${slug(p.organization)}` : "";
    const dom = domainOf(p.domain || (email.includes("@") ? email.split("@")[1] : ""));

    const keys = [email, url, nameOrg,
                  p.organization ? `org:${slug(p.organization)}` : "",
                  dom ? `dom:${dom}` : ""].filter(Boolean);
    const named = [slug(p.name), slug(p.organization), url, email].filter(Boolean);
    const isMustInvite = named.some((k) => mustInvite.has(k));

    let verdict = null;
    if ((url && memberUrl.has(url)) || (email && memberEmail.has(email)) || (nameOrg && memberNameOrg.has(nameOrg))) {
      verdict = { reason: "member:already_in_community" };
    } else if (keys.some((k) => rsvped.has(k))) {
      verdict = { reason: "event:already_rsvpd" };
    } else if (keys.some((k) => alreadyInvited.has(k))) {
      verdict = { reason: "event:already_invited" };
    } else if (named.some((k) => doNotInvite.has(k))) {
      verdict = { reason: "event:do_not_invite" };
    } else if (dom && conflictExcl.has(dom)) {
      verdict = { reason: "event:conflict_exclusion" };
    } else if (exclOrgs.has(slug(p.organization)) || (dom && exclDomains.has(dom)) || exclPeople.has(slug(p.name))) {
      verdict = { reason: "exclusion:profile_list" };
    } else {
      verdict = outreachBlock(keys);
    }

    // Must-invite bypasses fit, never suppression. Both-lists is the owner's call, not the gate's.
    if (verdict && isMustInvite) {
      conflicts.push({ ...p, must_invite: true, suppressed_by: verdict.reason, gate_cycle: CYCLE,
        resolve: "On the must-invite list and suppressed. Owner decides — the gate will not." });
      continue;
    }

    if (verdict) suppressed.push({ ...p, suppressed: verdict.reason, gate_cycle: CYCLE });
    else eligible.push({ ...p, state: "eligible", must_invite: isMustInvite || undefined, gate_cycle: CYCLE });
  }
}

writeFileSync(join(pdir, "eligible.jsonl"), eligible.map((e) => JSON.stringify(e)).join("\n") + (eligible.length ? "\n" : ""));
writeFileSync(join(pdir, "suppressed.jsonl"), suppressed.map((s) => JSON.stringify(s)).join("\n") + (suppressed.length ? "\n" : ""));
writeFileSync(join(pdir, "conflicts.jsonl"), conflicts.map((c) => JSON.stringify(c)).join("\n") + (conflicts.length ? "\n" : ""));

const reasons = suppressed.reduce((a, s) => ({ ...a, [s.suppressed]: (a[s.suppressed] || 0) + 1 }), {});
console.log([
  `event:      ${event ? `${event.slug} (capacity ${event.venue_capacity ?? "?"})` : "none — community-wide rules only"}`,
  `prospects:  ${read} read (${malformed} malformed) from ${files.length} file(s)`,
  `eligible:   ${eligible.length}`,
  `suppressed: ${suppressed.length}`,
  ...Object.entries(reasons).sort().map(([r, n]) => `  ${r.padEnd(44)} ${n}`),
  ...(conflicts.length ? [``, `CONFLICTS: ${conflicts.length} must-invite name(s) also suppressed — owner resolves, see conflicts.jsonl`] : []),
  ``,
  `Eligible list goes to review: approve, hold, or reject, per candidate and per message.`,
  ...(event?.venue_capacity && eligible.length > event.venue_capacity
      ? [`Queue exceeds capacity (${eligible.length} > ${event.venue_capacity}) — ranking decides the cutoff.`] : []),
].join("\n"));
