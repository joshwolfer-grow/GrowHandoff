#!/usr/bin/env node
// Pull rep questions (and answers) out of the iMessage group chats that carry ISP
// field traffic: the "Support - ..." threads AND the chats labeled with just the
// ISP/market name ("Slic - 7/19", "I3 Peoria - 5/10", "TDS - 6/07", ...).
//
// Requires Full Disk Access for whatever app runs this (Terminal / Claude Code).
// System Settings > Privacy & Security > Full Disk Access > add the app, then restart it.
//
// Usage:
//   node scripts/imessage-support-questions.mjs                     # questions only
//   node scripts/imessage-support-questions.mjs --all-messages      # every message (Q + A)
//   node scripts/imessage-support-questions.mjs --since 2026-05-01
//   node scripts/imessage-support-questions.mjs --scope support     # only Support - ... chats
//   node scripts/imessage-support-questions.mjs --scope isp         # only ISP-labeled chats
//   node scripts/imessage-support-questions.mjs --match Baytown     # any chat name containing this
//
// Writes:
//   data/imessage-questions.csv   isp, chat, date, sender, text
//   data/imessage-questions.md    grouped by chat, ready to paste into a model
//   data/by-isp/<isp>.md          one file per ISP, chats in date order

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i === -1 ? dflt : args[i + 1];
};
const SCOPE = (argVal('--scope', 'all') || 'all').toLowerCase(); // all | support | isp
const MATCH = argVal('--match', null);
const SINCE = argVal('--since', null);
const ALL = args.includes('--all-messages');

const SRC = path.join(os.homedir(), 'Library/Messages/chat.db');

const APPLE_EPOCH = 978307200; // 2001-01-01 UTC
const sinceApple = SINCE
  ? Math.floor((new Date(SINCE + 'T00:00:00').getTime() / 1000 - APPLE_EPOCH) * 1e9)
  : 0;

const sqlite = (sql) =>
  execFileSync('sqlite3', ['-readonly', SRC], { input: sql, maxBuffer: 1024 * 1024 * 512 }).toString();

// Map a chat's market/ISP token to the underlying ISP. Order matters: the first
// pattern that matches the chat name wins. i3 sits above Ezee so "i3 Chicago"
// lands on i3 rather than on the Chicago-means-Ezee rule.
function ispFor(chat) {
  const n = chat.replace(/^Support( S\/F)? -? ?/i, '');
  const rules = [
    [/\bi3\b|peoria|\bstl\b/i, 'i3'],
    [/bluepeak/i, 'BluePeak'],
    [/ezee|chicago/i, 'Ezee'],
    [/\bslic\b/i, 'SLIC'],
    [/\btds\b/i, 'TDS'],
    [/omni/i, 'Omni'],
    [/cityside/i, 'Cityside'],
    [/gfiber/i, 'GFiber'],
    [/\bglo\b/i, 'Glo'],
    [/\bting\b/i, 'Ting'],
    // Lyte Texas markets
    [/lyte|baytown|beeville|coastal|uvalde|marshall|navarro|kingsville|sinton/i, 'Lyte'],
    [/northern lights|northline|\bnl\b/i, 'Northern Lights'],
  ];
  for (const [re, isp] of rules) if (re.test(n)) return isp;
  return 'Unmapped';
}

// Chat selection. "Support ..." threads are always ISP field traffic; the rest are
// only pulled in when the name itself resolves to an ISP, which keeps the personal
// and non-ISP group chats out.
const isSupport = (name) => /^support\b/i.test(name);
function wanted(name) {
  if (MATCH && !name.toLowerCase().includes(MATCH.toLowerCase())) return false;
  const support = isSupport(name);
  if (SCOPE === 'support') return support;
  const isp = ispFor(name) !== 'Unmapped';
  if (SCOPE === 'isp') return isp && !support;
  return support || isp;
}

let chatNames;
try {
  chatNames = sqlite(`.mode json\nSELECT DISTINCT display_name AS n FROM chat WHERE display_name IS NOT NULL AND display_name <> '';`);
  chatNames = (chatNames.trim() ? JSON.parse(chatNames) : []).map((r) => r.n).filter(wanted);
} catch (e) {
  console.error('sqlite read failed:', e.message);
  console.error('If this says "authorization denied", grant Full Disk Access and restart the app.');
  process.exit(1);
}
if (!chatNames.length) {
  console.error('No chats matched. Try a different --scope / --match.');
  process.exit(1);
}
const nameList = chatNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');

const SQL = `
.mode json
SELECT
  c.display_name              AS chat,
  m.date                      AS ts,
  m.is_from_me                AS fromMe,
  COALESCE(h.id, '')          AS sender,
  COALESCE(m.text, '')        AS text,
  COALESCE(hex(m.attributedBody), '') AS blob
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE c.display_name IN (${nameList})
  AND m.date >= ${sinceApple}
  AND m.associated_message_type = 0
ORDER BY c.display_name, m.date;
`;

let rows;
try {
  // sqlite3 opens the live db read-only; -readonly avoids WAL lock issues.
  const out = sqlite(SQL);
  rows = out.trim() ? JSON.parse(out) : [];
} catch (e) {
  console.error('sqlite read failed:', e.message);
  console.error('If this says "authorization denied", grant Full Disk Access and restart the app.');
  process.exit(1);
}

// Newer messages store text in an NSAttributedString typedstream blob instead of
// message.text. After the "NSString" class marker comes a length-prefixed UTF-8
// string: a 0x2B/0x2A marker byte, then a 1-byte length (<0x80) or 0x81 + uint16 LE.
function fromBlob(hex) {
  if (!hex) return '';
  const buf = Buffer.from(hex, 'hex');
  const marker = buf.indexOf('NSString', 0, 'latin1');
  if (marker === -1) return '';
  let i = marker + 8;
  while (i < buf.length && buf[i] !== 0x2b && buf[i] !== 0x2a) i++;
  i++; // consume the marker byte
  if (i >= buf.length) return '';
  let len = buf[i++];
  if (len === 0x81) { len = buf[i] | (buf[i + 1] << 8); i += 2; }
  else if (len === 0x82) { len = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16); i += 3; }
  if (len <= 0 || i + len > buf.length) return '';
  return buf.toString('utf8', i, i + len).trim();
}

const QUESTION_WORDS = /^(who|what|when|where|why|how|which|can|could|do|does|did|is|are|was|were|should|would|will|any|anyone|anybody)\b/i;
const isQuestion = (t) => t.includes('?') || QUESTION_WORDS.test(t.trim());

// Pinned/system boilerplate we never want in the output.
const SKIP = [
  /this chat is to only be used/i,
  /^__kIM/,
  /kIMFileTransferGUID/,
  /kIMMessagePartAttribute/,
];

const clean = [];
for (const r of rows) {
  let text = (r.text || '').trim() || fromBlob(r.blob);
  // strip object-replacement chars (attachments) and collapse whitespace
  text = text.replace(/￼/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 4) continue;
  if (SKIP.some((re) => re.test(text))) continue;
  if (!ALL && !isQuestion(text)) continue;
  clean.push({
    isp: ispFor(r.chat),
    chat: r.chat,
    ts: r.ts,
    date: new Date((r.ts / 1e9 + APPLE_EPOCH) * 1000).toISOString().slice(0, 10),
    sender: r.fromMe ? 'me' : (r.sender || 'unknown'),
    text,
  });
}

fs.mkdirSync('data', { recursive: true });

const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
fs.writeFileSync(
  'data/imessage-questions.csv',
  ['isp,chat,date,sender,text', ...clean.map((r) => [r.isp, r.chat, r.date, r.sender, r.text].map(esc).join(','))].join('\n')
);

const byChat = {};
for (const r of clean) (byChat[r.chat] ||= []).push(r);
const md = Object.entries(byChat)
  .map(([chat, list]) => `## ${chat} (${list.length})\n\n` + list.map((r) => `- [${r.date}] ${r.sender}: ${r.text}`).join('\n'))
  .join('\n\n');
fs.writeFileSync('data/imessage-questions.md', md);

// One file per ISP, chats in date order, so each ISP's Q+A thread reads cleanly.
const byIsp = {};
for (const r of clean) (byIsp[r.isp] ||= {});
for (const r of clean) ((byIsp[r.isp][r.chat] ||= [])).push(r);
fs.mkdirSync('data/by-isp', { recursive: true });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ispCounts = [];
for (const [isp, chats] of Object.entries(byIsp)) {
  const chunks = Object.entries(chats)
    .sort((a, b) => (a[1][0]?.date || '').localeCompare(b[1][0]?.date || ''))
    .map(([chat, list]) => `## ${chat}\n\n` + list.map((r) => `- [${r.date}] ${r.sender}: ${r.text}`).join('\n'));
  const n = Object.values(chats).reduce((s, l) => s + l.length, 0);
  ispCounts.push([isp, n]);
  fs.writeFileSync(`data/by-isp/${slug(isp)}.md`, `# ${isp} — support ${ALL ? 'messages' : 'questions'} (${n})\n\n` + chunks.join('\n\n'));
}

// ---------------------------------------------------------------------------
// Q&A view: every question followed by the replies that landed after it, so a
// guide writer reads an answered thread instead of 400KB of raw chat. Only makes
// sense with --all-messages, since the answers are non-question messages.
// ---------------------------------------------------------------------------
const REPLY_WINDOW_NS = 6 * 3600 * 1e9; // answers usually land within a few hours
const MAX_REPLIES = 6;

// Roll-call posts ("Josh Wolfer") are the single biggest source of noise: reps
// post their name on Monday in every chat. Drop a reply that looks like a bare
// personal name and contains no ordinary support vocabulary.
const COMMON = /\b(yes|no|yep|yeah|nope|call|text|email|order|install|support|use|check|send|ask|it|the|is|are|was|do|does|can|will|not|and|or|for|to|on|in|at|his|her|their|my|your|our|this|that|day|week|app|link|code|id|rep|lead|sale|sold|fiber|address|number|price|plan|deal|free|fixed|done|good|thanks|ty|lol|ok|okay)\b/i;
const NAME_ONLY = /^[A-Z][a-z'’.-]{1,15}(\s+[A-Za-z'’.-]{2,20}){1,2}$/;
const isRollCall = (t) => NAME_ONLY.test(t) && !COMMON.test(t);

const qaByIsp = {};
if (ALL) {
  const byChatOrdered = {};
  for (const r of clean) (byChatOrdered[r.chat] ||= []).push(r);
  for (const [chat, list] of Object.entries(byChatOrdered)) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      if (!isQuestion(q.text) || isRollCall(q.text)) continue;
      const replies = [];
      for (let j = i + 1; j < list.length && replies.length < MAX_REPLIES; j++) {
        const a = list[j];
        if (a.ts - q.ts > REPLY_WINDOW_NS) break;
        if (a.sender === q.sender) continue;     // same person still typing
        if (isRollCall(a.text)) continue;
        if (isQuestion(a.text) && !replies.length) break; // someone piled on, not an answer
        replies.push(a);
      }
      if (!replies.length) continue;             // unanswered — nothing to mine
      (qaByIsp[q.isp] ||= []).push({ chat, q, replies });
    }
  }

  fs.mkdirSync('data/by-isp-qa', { recursive: true });
  for (const [isp, pairs] of Object.entries(qaByIsp)) {
    const body = pairs
      .map(({ chat, q, replies }) =>
        `### [${q.date}] ${chat}\n**Q (${q.sender}):** ${q.text}\n` +
        replies.map((a) => `> **${a.sender}:** ${a.text}`).join('\n')
      )
      .join('\n\n');
    fs.writeFileSync(
      `data/by-isp-qa/${slug(isp)}.md`,
      `# ${isp} — answered questions from the field (${pairs.length})\n\n` +
      `Source: iMessage Support + ISP chats. Each block is a rep question with the\n` +
      `replies that followed it within 6 hours. Verify anything that looks\n` +
      `market-specific or time-sensitive before it goes in the guide.\n\n${body}\n`
    );
  }
}

const chats = Object.keys(byChat).length;
console.log(`${rows.length} messages scanned across ${chats} chats`);
console.log(`${clean.length} ${ALL ? 'messages' : 'questions'} written to data/imessage-questions.csv/.md`);
console.log('Per-ISP files in data/by-isp/:');
for (const [isp, n] of ispCounts.sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${isp}`);
if (ALL) {
  const total = Object.values(qaByIsp).reduce((s, p) => s + p.length, 0);
  console.log(`\n${total} answered Q&A pairs in data/by-isp-qa/:`);
  for (const [isp, p] of Object.entries(qaByIsp).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(p.length).padStart(4)}  ${isp}`);
  }
}
