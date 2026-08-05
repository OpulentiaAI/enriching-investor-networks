#!/usr/bin/env node
/**
 * gate_prospects.mjs — mechanical suppression before any human sees the list.
 *
 *   node gate_prospects.mjs <WORKSPACE> --cycle YYYY-MM-DD [--profile <path>]
 *
 * Reads   {WORKSPACE}/cycles/{cycle}/prospects/found*.jsonl   discovery output
 *         {WORKSPACE}/members.json                            current member base
 *         {WORKSPACE}/outreach_state.json                     prior invites/declines/unsubs
 *         {WORKSPACE}/profile.json                            exclusions + cooldowns
 * Writes  {WORKSPACE}/cycles/{cycle}/prospects/eligible.jsonl
 *         {WORKSPACE}/cycles/{cycle}/prospects/suppressed.jsonl   every suppression with reason
 *
 * Order matters and is fixed: members → exclusions → outreach memory → bounced contacts.
 * The gate never judges fit — that's the discovery evidence + the human at the approval gate.
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
const PROFILE_PATH = flag("--profile", join(WORKSPACE, "profile.json"));
const profile = existsSync(PROFILE_PATH) ? JSON.parse(readFileSync(PROFILE_PATH, "utf-8")) : {};
const COOLDOWN_DAYS = profile.outreach?.decline_cooldown_days ?? 180;

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
const eligible = [], suppressed = [];
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

    let verdict = null;
    if ((url && memberUrl.has(url)) || (email && memberEmail.has(email)) || (nameOrg && memberNameOrg.has(nameOrg))) {
      verdict = { reason: "member:already_in_community" };
    } else if (exclOrgs.has(slug(p.organization)) || (dom && exclDomains.has(dom)) || exclPeople.has(slug(p.name))) {
      verdict = { reason: "exclusion:profile_list" };
    } else {
      verdict = outreachBlock([email, url, nameOrg].filter(Boolean));
    }

    if (verdict) suppressed.push({ ...p, suppressed: verdict.reason, gate_cycle: CYCLE });
    else eligible.push({ ...p, state: "eligible", gate_cycle: CYCLE });
  }
}

writeFileSync(join(pdir, "eligible.jsonl"), eligible.map((e) => JSON.stringify(e)).join("\n") + (eligible.length ? "\n" : ""));
writeFileSync(join(pdir, "suppressed.jsonl"), suppressed.map((s) => JSON.stringify(s)).join("\n") + (suppressed.length ? "\n" : ""));

const reasons = suppressed.reduce((a, s) => ({ ...a, [s.suppressed]: (a[s.suppressed] || 0) + 1 }), {});
console.log([
  `prospects:  ${read} read (${malformed} malformed) from ${files.length} file(s)`,
  `eligible:   ${eligible.length}`,
  `suppressed: ${suppressed.length}`,
  ...Object.entries(reasons).sort().map(([r, n]) => `  ${r.padEnd(44)} ${n}`),
  ``,
  `Eligible list goes to the approval gate — nothing is queued until a person approves.`,
].join("\n"));
