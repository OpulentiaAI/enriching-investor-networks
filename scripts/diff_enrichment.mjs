#!/usr/bin/env node
/**
 * diff_enrichment.mjs — resolve observations onto the member baseline, emit typed changes.
 *
 *   node diff_enrichment.mjs <WORKSPACE> --cycle YYYY-MM-DD [--profile <path>]
 *
 * Reads   {WORKSPACE}/members.json                          canonical state (created if absent)
 *         {WORKSPACE}/cycles/{cycle}/observations/*.json    raw per-member observations
 *         {WORKSPACE}/profile.json                          precedence ladder + recency window
 * Writes  {WORKSPACE}/members.json                          updated, provenance + history intact
 *         {WORKSPACE}/changes.jsonl                         append-only change log (all cycles)
 *         {WORKSPACE}/cycles/{cycle}/events.jsonl           this cycle's events
 *         {WORKSPACE}/cycles/{cycle}/quarantine.jsonl       records with no identity key
 *
 * Idempotent: re-running the same cycle emits zero new events.
 * Precedence: a value with weaker provenance never overwrites a stronger one — it becomes
 * a conflict_resolved event and a history entry instead.
 */

import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const WORKSPACE = argv[0];
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
if (!WORKSPACE) {
  console.error("usage: node diff_enrichment.mjs <WORKSPACE> --cycle YYYY-MM-DD [--profile <path>]");
  process.exit(1);
}
const CYCLE = flag("--cycle", new Date().toISOString().slice(0, 10));
const PROFILE_PATH = flag("--profile", join(WORKSPACE, "profile.json"));

const profile = existsSync(PROFILE_PATH) ? JSON.parse(readFileSync(PROFILE_PATH, "utf-8")) : {};
const LADDER = profile.source_policy?.ladder || ["member_confirmed", "linkedin_profile", "contextdev", "web_public", "platform_record", "inferred"];
const RECENCY_MONTHS = profile.recency_months_actively_investing ?? 12;
const rung = (source) => {
  const i = LADDER.indexOf(source);
  return i === -1 ? LADDER.length : i; // unknown sources rank below the ladder
};

/** Field → event type. Anything unmapped is a profile_change-style generic. */
const EVENT_TYPE = {
  email: "contact_change", email_status: "contact_change", phone: "contact_change",
  title: "role_change", organization: "org_change", location: "location_change",
  linkedin_headline: "profile_change", linkedin_about: "profile_change",
  industries: "profile_change", actively_investing: "investing_status_change",
};

const normalizeUrl = (raw) => {
  if (!raw) return "";
  try {
    const u = new URL(String(raw).startsWith("http") ? raw : `https://${raw}`);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch { return String(raw).toLowerCase().trim(); }
};
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const normVal = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};
/** Material-difference check for prose fields: ignore whitespace/punctuation-only drift. */
const materially = (a, b) => {
  const fold = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return fold(a) !== fold(b);
};
const monthsBetween = (a, b) => (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 30.44);

// ---------- load ----------
const membersPath = join(WORKSPACE, "members.json");
const members = existsSync(membersPath) ? JSON.parse(readFileSync(membersPath, "utf-8")) : { members: [] };
const byId = new Map(members.members.map((m) => [m.member_id, m]));
const byUrl = new Map(), byEmail = new Map(), byNameOrg = new Map();
for (const m of members.members) {
  if (m.linkedin_url) byUrl.set(normalizeUrl(m.linkedin_url), m);
  const email = m.fields?.email?.value;
  if (email) byEmail.set(String(email).toLowerCase(), m);
  const org = m.fields?.organization?.value;
  if (m.name && org) byNameOrg.set(`${slug(m.name)}:${slug(org)}`, m);
}

const obsDir = join(WORKSPACE, "cycles", CYCLE, "observations");
if (!existsSync(obsDir)) {
  console.error(`No observations at ${obsDir} — run the enrichment wave first.`);
  process.exit(1);
}

const changesPath = join(WORKSPACE, "changes.jsonl");
/** Events already logged for THIS cycle — the dedupe set, and the base for a non-destructive rewrite. */
const priorThisCycle = (existsSync(changesPath) ? readFileSync(changesPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
  .filter((e) => e.cycle === CYCLE);
const already = new Set(priorThisCycle.map((e) => `${e.member_id}|${e.type}|${e.field}|${e.before}|${e.after}`));

const events = [];
const quarantine = [];
let malformed = 0, filesRead = 0;

const emit = (member_id, type, field, before, after, obs) => {
  const key = `${member_id}|${type}|${field}|${before}|${after}`;
  if (already.has(key)) return;
  already.add(key);
  events.push({
    member_id, type, field,
    before: before ?? null, after: after ?? null,
    observed_at: obs?.observed_at ?? CYCLE,
    source: obs?.source ?? null, source_url: obs?.source_url ?? null,
    confidence: obs?.confidence ?? "Unknown",
    evidence: obs?.evidence ?? null,
    cycle: CYCLE,
  });
};

const applyField = (member, field, obs) => {
  const incoming = { value: normVal(obs.value), confidence: obs.confidence || "Unknown", source: obs.source || "inferred", source_url: obs.source_url ?? null, observed_at: obs.observed_at || CYCLE, ...(obs.evidence ? { evidence: obs.evidence } : {}) };
  const current = member.fields[field];
  if (!current) {
    member.fields[field] = { ...incoming, history: [] };
    if (incoming.value !== null) emit(member.member_id, EVENT_TYPE[field] || "profile_change", field, null, incoming.value, incoming);
    return;
  }
  const same = (EVENT_TYPE[field] === "profile_change") ? !materially(current.value, incoming.value) : normVal(current.value) === incoming.value;
  if (same) { // refresh provenance if the incoming rung is at least as strong
    if (rung(incoming.source) <= rung(current.source)) Object.assign(current, incoming, { history: current.history });
    return;
  }
  if (rung(incoming.source) <= rung(current.source)) { // stronger or equal rung: incoming wins (equal rung → newer observation wins by arrival)
    current.history.push({ value: current.value, source: current.source, observed_at: current.observed_at, superseded_by: `precedence:${incoming.source}` });
    const before = current.value;
    Object.assign(current, incoming, { history: current.history });
    emit(member.member_id, EVENT_TYPE[field] || "profile_change", field, before, incoming.value, incoming);
  } else { // weaker rung: current stands, record the disagreement
    current.history.push({ value: incoming.value, source: incoming.source, observed_at: incoming.observed_at, rejected_by: `precedence:${current.source}` });
    emit(member.member_id, "conflict_resolved", field, incoming.value, current.value, { ...incoming, evidence: `kept ${current.source} value by precedence` });
  }
};

// ---------- process observations ----------
for (const file of readdirSync(obsDir).filter((f) => f.endsWith(".json")).sort()) {
  filesRead += 1;
  let obs;
  try { obs = JSON.parse(readFileSync(join(obsDir, file), "utf-8")); }
  catch { malformed += 1; continue; }

  const idy = obs.identity || {};
  let member =
    (obs.member_id && byId.get(obs.member_id)) ||
    (idy.linkedin_url && byUrl.get(normalizeUrl(idy.linkedin_url))) ||
    (idy.email && byEmail.get(String(idy.email).toLowerCase())) ||
    (idy.name && idy.organization && byNameOrg.get(`${slug(idy.name)}:${slug(idy.organization)}`));

  if (!member) {
    if (!idy.linkedin_url && !idy.email && !(idy.name && idy.organization)) {
      quarantine.push({ file, reason: "no identity key", identity: idy });
      continue;
    }
    member = {
      member_id: obs.member_id || `m-new-${slug(idy.name || idy.linkedin_url || idy.email)}`,
      name: idy.name ?? null, linkedin_url: idy.linkedin_url ?? null, fields: {},
    };
    members.members.push(member);
    byId.set(member.member_id, member);
    if (member.linkedin_url) byUrl.set(normalizeUrl(member.linkedin_url), member);
    emit(member.member_id, "new_member", null, null, member.name || member.member_id, { source: obs.observations?.[0]?.source, observed_at: CYCLE });
  }

  for (const o of obs.observations || []) {
    if (!o.field) continue;
    applyField(member, o.field, o);
  }
  if (obs.email_status) {
    const current = member.email_status?.value ?? null;
    if (current !== obs.email_status.value) {
      emit(member.member_id, "contact_change", "email_status", current, obs.email_status.value, { source: obs.email_status.provider || "email_verification", observed_at: obs.email_status.checked_at || CYCLE, confidence: "Verified" });
    }
    member.email_status = { ...obs.email_status };
  }
}

// ---------- actively_investing decay ----------
for (const member of members.members) {
  const f = member.fields?.actively_investing;
  if (!f || normVal(f.value) !== "true") continue;
  if (monthsBetween(f.observed_at, CYCLE) > RECENCY_MONTHS) {
    f.history.push({ value: f.value, source: f.source, observed_at: f.observed_at, superseded_by: "recency_window_expired" });
    emit(member.member_id, "investing_status_change", "actively_investing", "true", "Unknown",
      { source: "recency_policy", observed_at: CYCLE, confidence: "Unknown", evidence: `no dated signal within ${RECENCY_MONTHS} months — absence downgrades, never flips to false` });
    Object.assign(f, { value: "Unknown", confidence: "Unknown", source: "recency_policy", observed_at: CYCLE });
  }
}

// ---------- write ----------
members.updated_at = CYCLE;
writeFileSync(membersPath, JSON.stringify(members, null, 2) + "\n");
if (events.length) appendFileSync(changesPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
mkdirSync(join(WORKSPACE, "cycles", CYCLE), { recursive: true });
// The cycle file is the full record for this cycle, not just this run's emissions — otherwise a
// re-run of a completed cycle would blank it. changes.jsonl stays the append-only source of truth.
const cycleEvents = [...priorThisCycle, ...events];
writeFileSync(join(WORKSPACE, "cycles", CYCLE, "events.jsonl"), cycleEvents.map((e) => JSON.stringify(e)).join("\n") + (cycleEvents.length ? "\n" : ""));
writeFileSync(join(WORKSPACE, "cycles", CYCLE, "quarantine.jsonl"), quarantine.map((q) => JSON.stringify(q)).join("\n") + (quarantine.length ? "\n" : ""));

const byType = events.reduce((a, e) => ({ ...a, [e.type]: (a[e.type] || 0) + 1 }), {});
console.log([
  `observations: ${filesRead} files (${malformed} malformed, ${quarantine.length} quarantined)`,
  `members:      ${members.members.length}`,
  `events:       ${events.length}`,
  ...Object.entries(byType).sort().map(([t, n]) => `  ${t.padEnd(24)} ${n}`),
].join("\n"));
