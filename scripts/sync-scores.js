#!/usr/bin/env node
// Pulls completed match results from ESPN's public tennis API and syncs them
// into Supabase (`results` + `eliminated` tables) using the same round-key
// convention as admin/index.html (draw_round, e.g. mens_qf).
//
// Usage:
//   node scripts/sync-scores.js            # dry run — prints planned writes, no network writes to Supabase
//   node scripts/sync-scores.js --apply    # actually upserts to Supabase
//
// Requires env vars SUPABASE_URL and SUPABASE_KEY when run with --apply.

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (APPLY && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('SUPABASE_URL and SUPABASE_KEY must be set in the environment when running with --apply.');
  process.exit(1);
}

const HEADERS = APPLY
  ? { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }
  : null;

// ── ROSTER ───────────────────────────────────────────────────────
// Extracted straight from index.html so the player list is never duplicated
// or allowed to drift out of sync with the pick page.
function loadRoster() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const match = html.match(/const PLAYERS = (\{[\s\S]*?\n\};)/);
  if (!match) throw new Error('Could not find `const PLAYERS = {...}` in index.html');
  const PLAYERS = new Function(`return ${match[1].slice(0, -1)}`)();

  const flatten = draw => [...draw.t1, ...draw.t2, ...draw.t3].map(p => p.name);
  return {
    mens: flatten(PLAYERS.mens),
    womens: flatten(PLAYERS.womens),
  };
}

// ── NAME MATCHING (alias map + last-name fallback) ──────────────
// Add entries here when ESPN's displayName doesn't match our roster verbatim,
// e.g. { 'Some ESPN Name': 'Our Roster Name' }.
// ESPN lists Chinese players family-name-first; our roster uses given-name-first.
const ALIAS_MAP = {
  'Wu Yibing': 'Yibing Wu',
  'Wang Xinyu': 'Xinyu Wang',
  'Zhang Shuai': 'Shuai Zhang',
  'Zheng Qinwen': 'Qinwen Zheng',
};

function normalize(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function matchPlayer(espnName, rosterNames) {
  if (ALIAS_MAP[espnName]) {
    const aliased = rosterNames.find(n => n === ALIAS_MAP[espnName]);
    if (aliased) return { name: aliased, reason: 'alias' };
  }

  const norm = normalize(espnName);
  const exact = rosterNames.find(n => normalize(n) === norm);
  if (exact) return { name: exact, reason: 'exact' };

  const espnLast = norm.split(' ').pop();
  const lastNameMatches = rosterNames.filter(n => normalize(n).split(' ').pop() === espnLast);
  if (lastNameMatches.length === 1) return { name: lastNameMatches[0], reason: 'last-name' };

  return { name: null, reason: lastNameMatches.length > 1 ? 'ambiguous-last-name' : 'no-match' };
}

// ── ESPN ─────────────────────────────────────────────────────────
// The scoreboard endpoint returns TOURNAMENT-level events (e.g. "Wimbledon"),
// each with groupings per draw ("Men's Singles", "Women's Singles", doubles...)
// and the actual matches nested under groupings[].competitions[]. Omitting
// `dates` defaults to "today", which is what correctly resolves to the
// currently-running Wimbledon event — passing a date range instead matched
// an unrelated concurrent ATP Challenger event.
const LEAGUE_TO_DRAW = { atp: 'mens', wta: 'womens' };
const GROUPING_LABEL = { mens: "Men's Singles", womens: "Women's Singles" };

async function fetchWimbledonMatches(league, draw) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/tennis/${league}/scoreboard`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`ESPN ${league} scoreboard fetch failed: ${resp.status}`);
  const data = await resp.json();
  const wimbledon = (data.events || []).find(e => e.name === 'Wimbledon');
  if (!wimbledon) return [];
  const grouping = (wimbledon.groupings || []).find(g => g.grouping?.displayName === GROUPING_LABEL[draw]);
  return grouping?.competitions || [];
}

// Main-draw rounds only — Qualifying 1st/2nd Round and Qualifying Final are excluded.
// Round the winner has now REACHED -> results.round suffix (points table key).
// "Round 1" has no entry: scoring starts once a player wins their Round 2 match.
const RESULT_ROUND_KEY = {
  'Round 2': 'r3',
  'Round 3': 'r4',
  'Round 4': 'qf',
  'Quarterfinal': 'sf',
  'Semifinal': 'f',
  'Final': 'w',
};

// Round the loser went OUT in -> eliminated.round (matches admin dropdown values).
const ELIMINATED_ROUND_KEY = {
  'Round 1': null,
  'Round 2': 'r2',
  'Round 3': 'r3',
  'Round 4': 'r4',
  'Quarterfinal': 'qf',
  'Semifinal': 'sf',
  'Final': 'f',
};

function isStraightSets(loser) {
  return loser.linescores.every(set => set.winner === false);
}

// ── BUILD PLANNED WRITES ─────────────────────────────────────────
async function buildPlan(roster) {
  const resultRows = [];
  const eliminatedRows = [];
  const skipped = [];

  for (const [league, draw] of Object.entries(LEAGUE_TO_DRAW)) {
    const matches = await fetchWimbledonMatches(league, draw);

    for (const match of matches) {
      const roundName = match.round?.displayName;
      const label = match.notes?.[0]?.text || match.id;

      if (!roundName || !(roundName in ELIMINATED_ROUND_KEY)) continue; // skip qualifying rounds silently
      if (match.status?.type?.state !== 'post') continue; // not completed yet

      const competitors = match.competitors || [];
      const winnerC = competitors.find(c => c.winner === true);
      const loserC = competitors.find(c => c.winner === false);
      if (!winnerC || !loserC) {
        skipped.push({ event: label, reason: 'no clear winner/loser' });
        continue;
      }

      const winnerName = winnerC.athlete.fullName || winnerC.athlete.displayName;
      const loserName = loserC.athlete.fullName || loserC.athlete.displayName;
      const winnerMatch = matchPlayer(winnerName, roster[draw]);
      const loserMatch = matchPlayer(loserName, roster[draw]);

      if (!winnerMatch.name) {
        skipped.push({ event: label, reason: `winner "${winnerName}" ${winnerMatch.reason}` });
        continue;
      }
      if (!loserMatch.name) {
        skipped.push({ event: label, reason: `loser "${loserName}" ${loserMatch.reason}` });
        continue;
      }

      const resultKey = RESULT_ROUND_KEY[roundName];
      if (resultKey) {
        resultRows.push({
          round: `${draw}_${resultKey}`,
          winner: winnerMatch.name,
          straight_sets: isStraightSets(loserC),
        });
        if (resultKey === 'w') {
          resultRows.push({ round: `champion_${draw}`, winner: winnerMatch.name, straight_sets: false });
        }
      }

      eliminatedRows.push({
        name: loserMatch.name,
        draw,
        round: ELIMINATED_ROUND_KEY[roundName],
      });
    }
  }

  return { resultRows, eliminatedRows, skipped };
}

// ── SUPABASE UPSERT ───────────────────────────────────────────────
async function upsertResult(row) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/results?on_conflict=round,winner`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
    throw new Error(`results upsert failed (${resp.status}): ${await resp.text()}`);
  }
}

async function upsertEliminated(row) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/eliminated?on_conflict=name,draw`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
    throw new Error(`eliminated upsert failed (${resp.status}): ${await resp.text()}`);
  }
}

// ── MAIN ───────────────────────────────────────────────────────────
async function main() {
  const roster = loadRoster();
  const { resultRows, eliminatedRows, skipped } = await buildPlan(roster);

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — sync-scores.js`);
  console.log(`Roster loaded: ${roster.mens.length} men's, ${roster.womens.length} women's players\n`);

  console.log(`Results to upsert (${resultRows.length}):`);
  resultRows.forEach(r => console.log(`  ${r.round.padEnd(16)} winner=${r.winner}${r.straight_sets ? ' (straight sets)' : ''}`));

  console.log(`\nEliminated to upsert (${eliminatedRows.length}):`);
  eliminatedRows.forEach(r => console.log(`  ${r.name.padEnd(28)} draw=${r.draw} round=${r.round ?? '(none)'}`));

  if (skipped.length) {
    console.log(`\nSkipped matches (${skipped.length}) — needs manual review or an ALIAS_MAP entry:`);
    skipped.forEach(s => console.log(`  ${s.event}: ${s.reason}`));
  }

  if (!APPLY) {
    console.log('\nDry run only — no writes performed. Re-run with --apply to write to Supabase.');
    return;
  }

  for (const row of resultRows) await upsertResult(row);
  for (const row of eliminatedRows) await upsertEliminated(row);
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
