#!/usr/bin/env node
/**
 * compile_refresh.mjs — the cycle report, the writeback payload, the invite queue proposal.
 *
 *   node compile_refresh.mjs <WORKSPACE> --cycle YYYY-MM-DD [--open]
 *
 * Reads   {WORKSPACE}/members.json
 *         {WORKSPACE}/cycles/{cycle}/events.jsonl
 *         {WORKSPACE}/cycles/{cycle}/prospects/{eligible,suppressed}.jsonl   (if lane two ran)
 * Writes  {WORKSPACE}/refresh.html          changes first, quiet members collapsed
 *         {WORKSPACE}/changes.csv
 *         {WORKSPACE}/writeback.json        API-ready payload — produced always, pushed never
 *         {WORKSPACE}/invite_queue.proposed.json
 *         {WORKSPACE}/summary.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const argv = process.argv.slice(2);
const WORKSPACE = argv[0];
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
if (!WORKSPACE) {
  console.error("usage: node compile_refresh.mjs <WORKSPACE> --cycle YYYY-MM-DD [--open]");
  process.exit(1);
}
const CYCLE = flag("--cycle", new Date().toISOString().slice(0, 10));

const membersPath = join(WORKSPACE, "members.json");
if (!existsSync(membersPath)) {
  console.error(`No members.json under ${WORKSPACE} — run ingest + diff first.`);
  process.exit(1);
}
const members = JSON.parse(readFileSync(membersPath, "utf-8")).members;

const readJsonl = (p) => (existsSync(p) ? readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const events = readJsonl(join(WORKSPACE, "cycles", CYCLE, "events.jsonl"));
const eligible = readJsonl(join(WORKSPACE, "cycles", CYCLE, "prospects", "eligible.jsonl"));
const suppressed = readJsonl(join(WORKSPACE, "cycles", CYCLE, "prospects", "suppressed.jsonl"));

const eventsByMember = events.reduce((a, e) => ((a[e.member_id] ||= []).push(e), a), {});
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const fv = (m, f) => m.fields?.[f]?.value ?? null;
/** Evidence often arrives already quoted; don't render nested quotes. */
const unquote = (s) => String(s ?? "").trim().replace(/^["“](.*)["”]$/s, "$1");

// ---------- writeback payload: only fields that changed this cycle, only writeback-safe values ----------
const writeback = [];
for (const m of members) {
  const evs = (eventsByMember[m.member_id] || []).filter((e) => e.field && e.type !== "conflict_resolved" && e.type !== "new_member");
  if (!evs.length) continue;
  const fields = {};
  for (const e of evs) {
    if (e.field === "email_status") { fields.email_status = { value: m.email_status?.value, checked_at: m.email_status?.checked_at ?? e.observed_at }; continue; }
    const rec = m.fields[e.field];
    if (!rec) continue;
    if (e.field === "email" && (m.email_status?.value === "candidate" || rec.confidence === "Estimated")) continue; // candidates never write back as current
    fields[e.field] = { value: rec.value, confidence: rec.confidence, source: rec.source, source_url: rec.source_url, observed_at: rec.observed_at };
  }
  if (Object.keys(fields).length) {
    writeback.push({ member_id: m.member_id, idempotency_key: `${m.member_id}:${Object.keys(fields).sort().join("+")}:${CYCLE}`, fields });
  }
}
writeFileSync(join(WORKSPACE, "writeback.json"), JSON.stringify({ cycle: CYCLE, dry_run: true, entries: writeback }, null, 2) + "\n");

// ---------- invite queue proposal ----------
writeFileSync(
  join(WORKSPACE, "invite_queue.proposed.json"),
  JSON.stringify({ cycle: CYCLE, state: "awaiting_approval", entries: eligible.map((p) => ({ kind: p.kind, name: p.name ?? null, organization: p.organization ?? null, email: p.email ?? null, icp_evidence: p.icp_evidence ?? null, source_url: p.source_url ?? null, state: "eligible" })) }, null, 2) + "\n",
);

// ---------- CSV ----------
const CSV = [
  ["member_id", (m) => m.member_id], ["name", (m) => m.name],
  ["title", (m) => fv(m, "title")], ["organization", (m) => fv(m, "organization")],
  ["location", (m) => fv(m, "location")], ["email", (m) => fv(m, "email")],
  ["email_status", (m) => m.email_status?.value], ["actively_investing", (m) => fv(m, "actively_investing")],
  ["changes_this_cycle", (m) => (eventsByMember[m.member_id] || []).length],
  ["change_types", (m) => [...new Set((eventsByMember[m.member_id] || []).map((e) => e.type))].join("; ")],
];
writeFileSync(join(WORKSPACE, "changes.csv"),
  [CSV.map(([h]) => csvCell(h)).join(","), ...members.map((m) => CSV.map(([, g]) => csvCell(g(m))).join(","))].join("\n") + "\n");

// ---------- HTML ----------
const TYPE_LABEL = {
  contact_change: "Contact", role_change: "Role", org_change: "Organization", location_change: "Location",
  profile_change: "Profile", investing_status_change: "Investing", new_member: "New member", conflict_resolved: "Conflict",
};
const changed = members.filter((m) => (eventsByMember[m.member_id] || []).length)
  .sort((a, b) => (eventsByMember[b.member_id]?.length || 0) - (eventsByMember[a.member_id]?.length || 0));
const quiet = members.filter((m) => !(eventsByMember[m.member_id] || []).length);

const evLine = (e) => `
      <li class="ev ev-${esc(e.type)}"><span class="etype">${esc(TYPE_LABEL[e.type] || e.type)}</span>
        <span class="ebody">${e.field ? `${esc(e.field)}: ` : ""}${e.before !== null ? `<s>${esc(e.before)}</s> → ` : ""}<strong>${esc(e.after)}</strong>
        ${e.evidence ? `<span class="quote">“${esc(unquote(e.evidence))}”</span>` : ""}
        <span class="prov">${esc(e.source || "")}${e.confidence ? ` · ${esc(e.confidence)}` : ""}</span></span></li>`;

const card = (m) => `
    <article class="card">
      <header><div><h2>${esc(m.name || m.member_id)}</h2>
        <p class="meta">${esc([fv(m, "title"), fv(m, "organization")].filter(Boolean).join(" · ") || "—")}${fv(m, "location") ? ` · ${esc(fv(m, "location"))}` : ""}</p></div>
        <div class="badges">${m.email_status ? `<span class="chip st-${esc(m.email_status.value)}">${esc(m.email_status.value)}</span>` : ""}
        <span class="chip">investing: ${esc(fv(m, "actively_investing") ?? "Unknown")}</span></div></header>
      <ul class="events">${(eventsByMember[m.member_id] || []).map(evLine).join("")}</ul>
    </article>`;

const counts = {
  members: members.length, changed: changed.length, events: events.length,
  by_type: events.reduce((a, e) => ({ ...a, [e.type]: (a[e.type] || 0) + 1 }), {}),
  writeback_entries: writeback.length,
  eligible: eligible.length, suppressed: suppressed.length,
  bounced: members.filter((m) => m.email_status?.value === "bounced").length,
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Network cycle — ${esc(CYCLE)}</title>
<style>
  :root{color-scheme:light dark;--bg:#fbfbfa;--panel:#fff;--ink:#16161a;--muted:#6b6b76;--line:#e6e6e3;--sunk:#f4f4f1;
    --ok:#1a7f5a;--warn:#9a6b12;--bad:#b3261e;--info:#3f6ea8}
  @media (prefers-color-scheme:dark){:root{--bg:#131315;--panel:#1a1a1d;--ink:#ececef;--muted:#9a9aa4;--line:#2a2a2f;--sunk:#202024;
    --ok:#4ec99a;--warn:#d9a648;--bad:#f2857c;--info:#7fb0e6}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
  .wrap{max-width:940px;margin:0 auto;padding:40px 20px 80px}
  h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 24px}
  .note{background:var(--sunk);border:1px solid var(--line);border-radius:8px;padding:10px 14px;color:var(--muted);font-size:13px;margin:0 0 24px}
  h3{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:28px 0 10px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:12px}
  .card header{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}
  .card h2{font-size:16px;margin:0 0 2px}.meta{margin:0;color:var(--muted);font-size:13px}
  .badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .chip{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
  .st-verified{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}
  .st-bounced{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
  .st-candidate,.st-unknown,.st-accept_all{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
  .events{list-style:none;margin:12px 0 0;padding:12px 0 0;border-top:1px solid var(--line)}
  .ev{display:flex;gap:10px;align-items:baseline;padding:4px 0;font-size:13px}
  .etype{flex:0 0 92px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .ev-investing_status_change .etype{color:var(--warn)}.ev-contact_change .etype{color:var(--bad)}
  .ev-org_change .etype,.ev-role_change .etype{color:var(--info)}.ev-new_member .etype{color:var(--ok)}
  .ebody s{color:var(--muted)}.quote{display:block;color:var(--muted);font-style:italic;margin-top:2px}
  .prov{display:block;color:var(--muted);font-size:11px;margin-top:2px}
  .quietlist{color:var(--muted);font-size:13px;line-height:1.9}
  .prospect{display:flex;gap:10px;align-items:baseline;padding:5px 0;font-size:13px;border-bottom:1px solid var(--line)}
  .prospect:last-child{border-bottom:none}.pkind{flex:0 0 70px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .reason{color:var(--warn);font-size:12px;margin-left:auto;text-align:right}
</style></head><body><div class="wrap">
  <h1>Network cycle — ${esc(CYCLE)}</h1>
  <p class="sub">${counts.members} members · ${counts.changed} changed · ${counts.events} events · ${counts.writeback_entries} writeback entries · ${counts.eligible} prospects eligible</p>
  <p class="note"><strong>Writeback is a dry-run payload</strong> (writeback.json) until a person approves the push, and the
  invitation queue is a proposal until a person approves the batch. Candidate emails never write back as current.</p>
  <h3>Changed this cycle — ${counts.changed}</h3>
  ${changed.map(card).join("") || '<p class="quietlist">No changes this cycle.</p>'}
  <h3>Quiet — ${quiet.length}</h3>
  <p class="quietlist">${quiet.map((m) => esc(m.name || m.member_id)).join(" · ") || "—"}</p>
  ${eligible.length || suppressed.length ? `
  <h3>Prospects — ${counts.eligible} eligible, ${counts.suppressed} suppressed</h3>
  <div class="card">${eligible.map((p) => `<div class="prospect"><span class="pkind">${esc(p.kind)}</span>
    <span><strong>${esc(p.name || p.organization)}</strong>${p.organization && p.name ? ` · ${esc(p.organization)}` : ""}
    ${p.icp_evidence ? `<span class="quote">“${esc(unquote(p.icp_evidence))}”</span>` : ""}</span></div>`).join("")}
  ${suppressed.map((p) => `<div class="prospect"><span class="pkind">${esc(p.kind)}</span>
    <span>${esc(p.name || p.organization)}</span><span class="reason">${esc(p.suppressed)}</span></div>`).join("")}</div>` : ""}
</div></body></html>
`;
writeFileSync(join(WORKSPACE, "refresh.html"), html);

writeFileSync(join(WORKSPACE, "summary.json"), JSON.stringify({ cycle: CYCLE, counts }, null, 2) + "\n");

console.log([
  `members:    ${counts.members} (${counts.changed} changed, ${quiet.length} quiet)`,
  `events:     ${counts.events}`,
  ...Object.entries(counts.by_type).sort().map(([t, n]) => `  ${t.padEnd(24)} ${n}`),
  `writeback:  ${counts.writeback_entries} entries (dry run)`,
  `prospects:  ${counts.eligible} eligible · ${counts.suppressed} suppressed`,
  ``,
  join(WORKSPACE, "refresh.html"),
  join(WORKSPACE, "changes.csv"),
  join(WORKSPACE, "writeback.json"),
  join(WORKSPACE, "invite_queue.proposed.json"),
].join("\n"));

if (argv.includes("--open")) execFile(process.platform === "darwin" ? "open" : "xdg-open", [join(WORKSPACE, "refresh.html")], () => {});
