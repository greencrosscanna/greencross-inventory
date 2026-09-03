#!/usr/bin/env node
/* ─── a calendar day is never derived from UTC ───────────────────────────────────────────────────
 *   RUN:  node tests/date_convention_test.js   (also run by the pre-push hook via gx-preflight.sh)
 *
 * THE CONVENTION: "A calendar day is Los Angeles; an instant is UTC."
 *
 * `.toISOString()` is UTC regardless of anything — the browser's zone, the Apps Script project's
 * zone, the machine's. Truncated to ten characters it becomes a calendar day, and from 17:00 PT to
 * midnight (seven hours of every day, eight in winter) that day is TOMORROW.
 *
 * WHAT IT COST HERE, found 2026-09-03: all three date helpers derived their day from a CLOCK
 * READING, and everything else in the file went through them. todayStr() stamps the "as of" date on
 * the inventory export, the retire-in-Dutchie list, and both the purchase-order and transfer CSV
 * builders — so from 5pm onward every one of those was dated tomorrow. daysAgoStr() and
 * monthStartStr() are window edges, and a window edge a day out quietly includes or excludes real
 * movement. Nothing errored and nothing looked broken. That is the whole hazard: this bug never
 * announces itself, it just hands someone a slightly wrong number in the evening.
 *
 * WHAT IS FINE, and deliberately not flagged:
 *   Date.parse(d + 'T12:00:00Z') stepped by 86400000, read back with .toISOString()
 *   new Date(Date.UTC(y, m, d)) with .setUTCDate()
 *       Both are CONSTRUCTED in UTC from calendar components, so reading them back in UTC returns
 *       the day they were built from. Round-trips exactly; the standard idiom for date-only
 *       arithmetic, and this app uses it correctly in three places.
 *   plain .toISOString() with no truncation — an INSTANT, where UTC is the right answer.
 *
 * THE CORRECT HELPERS in index.html — all three keep the names they always had, so no call site
 * changed; only what they derive from did:
 *   todayStr()      — today in America/Los_Angeles, via Intl, NOT the browser's own zone
 *   daysAgoStr(n)   — todayStr() stepped back n whole days in UTC (built with Date.UTC, read back
 *                     in UTC, so it round trips exactly)
 *   monthStartStr() — the first of the LA month, by string, with no Date arithmetic at all
 *
 * THE ORDER MATTERS in daysAgoStr: take the LA calendar day FIRST, then step it. The old version
 * stepped a local clock and then read it in UTC, so the two operations could land either side of
 * midnight UTC independently. Deriving the day first removes that entirely.
 *
 * ESCAPE HATCH:  @utc-ok <reason>  on the line. The reason is required — a bare marker is refused
 * below, because an exemption nobody had to justify is how a rule erodes.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const TRUNCATED = /\.toISOString\(\)\s*\.\s*(?:slice|substring)\s*\(\s*0\s*,\s*10\s*\)|\.toISOString\(\)\s*\.\s*split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]/;
const ROUNDTRIP = /Date\.UTC\s*\(|\.setUTC[A-Za-z]+\s*\(|['"]T\d{2}:\d{2}:\d{2}Z['"]/;
const LOOKBACK  = 4;

/* Blank out comments before matching, keeping line numbers intact. Not optional: this file's own
   header quotes the bad pattern in order to explain it, and index.html now carries a long comment
   doing the same. A gate that reports its own documentation as a defect teaches people to skim it. */
function decomment(src) {
  let inBlock = false;
  return src.split('\n').map(line => {
    let out = '', i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { i = line.length; break; }
        inBlock = false; i = end + 2; continue;
      }
      if (line[i] === '/' && line[i + 1] === '*') { inBlock = true; i += 2; continue; }
      if (line[i] === '/' && line[i + 1] === '/') break;
      out += line[i]; i++;
    }
    return out;
  });
}

function offenders(file) {
  const out = [];
  const src = fs.readFileSync(file, 'utf8');
  const raw = src.split('\n');
  const code = decomment(src);
  code.forEach((c, i) => {
    if (!TRUNCATED.test(c)) return;
    if (ROUNDTRIP.test(c)) return;                       // built and read on the same line
    /* The construction may sit a few lines above the read. Look back — but ONLY for the identifier
       actually being read. A blanket window scan is worse than no lookback: it would swallow a real
       offender sitting under an unrelated Date.UTC, a false negative in the one gate meant to catch
       this class. (Borrowed wholesale from the hub's version, which learned it the hard way.) */
    const recv = /([A-Za-z_$][\w$]*)\s*\.\s*toISOString\s*\(\)/.exec(c);
    if (recv) {
      /* \b matters, and its absence is a live false NEGATIVE in the hub's copy. Without it the
         name `d` matches inside `const end = …`, because "end" ends in a d — so a read of `d` was
         excused by an unrelated line that merely happened to contain 'T12:00:00Z'. Found here
         2026-09-03: index.html:1886 passed for that reason rather than on its merits. A gate that
         clears code by coincidence is worse than one that flags it, because nobody looks again. */
      const name  = recv[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const built = new RegExp('\\b' + name + '\\s*(?:=[^=]|\\.setUTC)');
      if (code.slice(Math.max(0, i - LOOKBACK), i).some(l => built.test(l) && ROUNDTRIP.test(l))) return;
    }
    if (/@utc-ok\s+\S/.test(raw[i])) return;             // exempted WITH a reason
    if (/@utc-ok\s*$/.test(raw[i])) { out.push({ line: i + 1, text: raw[i].trim(), bare: true }); return; }
    out.push({ line: i + 1, text: raw[i].trim() });
  });
  return out;
}

console.log('1. the detector catches the real shapes and spares the correct ones');
{
  const tmp = path.join(os.tmpdir(), 'gx-inv-datecheck-' + process.pid + '.js');
  fs.writeFileSync(tmp, [
    "const a = new Date().toISOString().slice(0, 10);",                          // 1 wrong
    "const b = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);",// 2 wrong
    "const c = cell.toISOString().split('T')[0];",                               // 3 wrong
    "const d = new Date(Date.UTC(y, m, dd)).toISOString().slice(0, 10);",        // fine, same line
    "const e = new Date(Date.parse(s + 'T12:00:00Z'));",
    "const f = e.toISOString().slice(0, 10);",                                   // fine, lookback
    "const g = new Date();",
    "const h = g.toISOString().slice(0, 10);",                                   // 4 wrong — lookback must NOT save it
    "const i2 = new Date().toISOString();",                                      // fine, an instant
    "const j = new Date().toISOString().slice(0, 10);   // @utc-ok compared only to other UTC days",
    "const k = new Date().toISOString().slice(0, 10);   // @utc-ok",             // 5 wrong — bare marker
    "// const l = new Date().toISOString().slice(0, 10);",                       // fine, a comment
    "const end = Date.parse(s + 'T12:00:00Z');",
    "const d = new Date(now);",
    "const m = d.toISOString().slice(0, 10);",                                   // 6 wrong — see \\b below
  ].join('\n'));
  const found = offenders(tmp);
  fs.unlinkSync(tmp);
  const lines = found.map(f => f.line);
  ok(lines.includes(1) && lines.includes(2) && lines.includes(3), 'flags the three clock-derived shapes');
  ok(lines.includes(8), 'lookback does not excuse a plain new Date() built above the read');
  ok(!lines.includes(4) && !lines.includes(6), 'spares a UTC round trip, same line and via lookback');
  ok(!lines.includes(9), 'spares an untruncated instant');
  ok(!lines.includes(10), 'honors @utc-ok WITH a reason');
  ok(found.some(f => f.line === 11 && f.bare), 'refuses a bare @utc-ok carrying no reason');
  ok(!lines.includes(12), 'ignores the pattern inside a comment');
  /* The \b regression guard: `d` must not be excused by `const end = …` on a nearby line just
     because "end" ends in a d and that line carries a UTC literal. */
  ok(lines.includes(15), 'an identifier is matched whole — "end" does not stand in for "d"');
  ok(found.length === 6, 'exactly six offenders in the fixture, no more');
}

console.log('\n2. the shipped source is clean');
{
  const files = ['index.html', 'dutchie_proxy.gs']
    .map(f => path.join(ROOT, f)).filter(fs.existsSync);
  ok(files.length >= 1, 'found the source files to check');
  for (const f of files) {
    const bad = offenders(f);
    if (bad.length) {
      console.log('       ' + path.basename(f) + ':');
      bad.forEach(b => console.log('         :' + b.line + '  ' + b.text.slice(0, 100)
                                  + (b.bare ? '     <- @utc-ok needs a reason' : '')));
    }
    ok(bad.length === 0, path.basename(f) + ' derives no calendar day from UTC');
  }
}

console.log('\n3. the helpers exist and answer the two different questions');
{
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(/America\/Los_Angeles/.test(src), 'the day is derived in America/Los_Angeles, not the browser zone');
  ok(/en-CA/.test(src), 'it uses the en-CA locale, which formats as YYYY-MM-DD');
  ok(/function todayStr\(\)\s*\{\s*return _LA_YMD\.format/.test(src),
     'todayStr() formats in LA rather than truncating an ISO instant');
  ok(/function monthStartStr\(\)\s*\{\s*return todayStr\(\)/.test(src),
     'monthStartStr() is derived from the LA day, by string, with no Date arithmetic');

  /* daysAgoStr must take the LA day FIRST and step it, not step a local clock and read it in UTC.
     Both orderings look the same on the page and differ by a day around midnight UTC. */
  const das = src.slice(src.indexOf('function daysAgoStr'), src.indexOf('function monthStartStr'));
  ok(/todayStr\(\)/.test(das), 'daysAgoStr() starts from the LA calendar day');
  ok(das.indexOf('todayStr()') < das.indexOf('setUTCDate'), 'and steps it AFTER deriving it, not before');
  ok(/Date\.UTC\(/.test(das) && /setUTCDate/.test(das),
     'its arithmetic is a UTC round trip, so the step cannot shift the day');

  /* Every caller goes through the helpers — no site re-derives a day inline. This is what the four
     export/CSV builders were doing, each with its own copy of the wrong idiom. */
  ok(!/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(src),
     'no call site derives today inline any more');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
