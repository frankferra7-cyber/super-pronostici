import https from 'https';

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!FOOTBALL_DATA_KEY) throw new Error("Missing FOOTBALL_DATA_KEY secret");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL secret");
if (!SUPABASE_SECRET_KEY) throw new Error("Missing SUPABASE_SECRET_KEY secret");

const COMPETITIONS = [
  { name: 'Serie A', code: 'SA' },
  { name: 'Premier League', code: 'PL' },
  { name: 'La Liga', code: 'PD' },
  { name: 'Bundesliga', code: 'BL1' },
  { name: 'Ligue 1', code: 'FL1' },
  { name: 'Champions League', code: 'CL' }
];

const squadCache = new Map();

function fetchFootballData(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.football-data.org',
      path,
      method: 'GET',
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_KEY.trim()
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (err) {
          reject(new Error(`Risposta non JSON (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTeamSquad(teamId) {
  if (!teamId) return [];
  if (squadCache.has(teamId)) {
    return squadCache.get(teamId);
  }

  await sleep(6500);
  const res = await fetchFootballData(`/v4/teams/${teamId}`);
  if (res.status !== 200 || !Array.isArray(res.body?.squad)) {
    console.log(`[Team ${teamId}] Impossibile leggere la rosa (${res.status})`);
    squadCache.set(teamId, []);
    return [];
  }

  const squad = res.body.squad.filter(p => p?.name);
  squadCache.set(teamId, squad);
  return squad;
}

function normalizeStartXI(rawPlayers) {
  if (!Array.isArray(rawPlayers)) return [];
  return rawPlayers
    .map((p, idx) => {
      const name = p?.name || p?.player?.name;
      if (!name) return null;
      return {
        pos: p?.position || p?.pos || 'P',
        name,
        number: p?.shirtNumber ?? p?.number ?? (idx + 1)
      };
    })
    .filter(Boolean);
}

function extractOfficialLineups(matchObj, homeTeam, awayTeam, seed) {
  const rawHomeXI =
    matchObj?.homeTeam?.lineup ||
    matchObj?.lineups?.home?.startXI ||
    matchObj?.lineup?.home ||
    [];
  const rawAwayXI =
    matchObj?.awayTeam?.lineup ||
    matchObj?.lineups?.away?.startXI ||
    matchObj?.lineup?.away ||
    [];

  const homeXI = normalizeStartXI(rawHomeXI);
  const awayXI = normalizeStartXI(rawAwayXI);

  const hasOfficial = homeXI.length >= 7 && awayXI.length >= 7;
  if (!hasOfficial) {
    return {
      isOfficial: false,
      homePlayers: [],
      awayPlayers: [],
      lineups: {
        home: {
          teamName: homeTeam,
          formation: (seed % 2) === 0 ? "4-3-3" : "3-5-2",
          isOfficial: false,
          startXI: []
        },
        away: {
          teamName: awayTeam,
          formation: ((seed >>> 1) % 2) === 0 ? "4-2-3-1" : "4-4-2",
          isOfficial: false,
          startXI: []
        }
      }
    };
  }

  return {
    isOfficial: true,
    homePlayers: homeXI.map(p => ({ name: p.name, position: p.pos })),
    awayPlayers: awayXI.map(p => ({ name: p.name, position: p.pos })),
    lineups: {
      home: {
        teamName: homeTeam,
        formation: matchObj?.homeTeam?.formation || ((seed % 2) === 0 ? "4-3-3" : "3-5-2"),
        isOfficial: true,
        startXI: homeXI
      },
      away: {
        teamName: awayTeam,
        formation: matchObj?.awayTeam?.formation || (((seed >>> 1) % 2) === 0 ? "4-2-3-1" : "4-4-2"),
        isOfficial: true,
        startXI: awayXI
      }
    }
  };
}

function hashSeed(homeTeam, awayTeam, matchId) {
  const input = `${String(matchId ?? '')}|${String(homeTeam ?? '')}|${String(awayTeam ?? '')}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function pickPlayersByRole(poolSource, teamName, roles, count, seedOffset = 0) {
  const normalizedRoles = roles.map(r => r.toLowerCase());
  const matching = poolSource.filter(p => {
    const pos = String(p.position || '').toLowerCase();
    return normalizedRoles.some(role => pos.includes(role));
  });

  const pool = matching.length >= count ? matching : (poolSource.length ? poolSource : []);
  if (!pool.length) {
    return Array.from({ length: count }, (_, idx) => `${teamName} - Giocatore ${idx + 1}`);
  }

  const picked = [];
  for (let i = 0; i < count; i++) {
    const player = pool[(seedOffset + i * 3) % pool.length];
    if (!picked.includes(player.name)) {
      picked.push(player.name);
    }
  }

  let extraIdx = 0;
  while (picked.length < count && extraIdx < pool.length) {
    const candidate = pool[(seedOffset + extraIdx) % pool.length].name;
    if (!picked.includes(candidate)) picked.push(candidate);
    extraIdx++;
  }

  return picked;
}

function buildTabData(matchObj, homeTeam, awayTeam, homeSquad, awaySquad, matchId) {
  const h = hashSeed(homeTeam, awayTeam, matchId);

  const homeWeight = 22 + (h % 51);
  const awayWeight = 18 + ((h >>> 8) % 47);
  const drawWeight = 14 + ((h >>> 16) % 21);

  const sum = homeWeight + awayWeight + drawWeight;
  const homePct = Math.round((homeWeight / sum) * 100);
  const drawPct = Math.round((drawWeight / sum) * 100);
  const awayPct = Math.max(1, 100 - homePct - drawPct);
  const diff = 100 - (homePct + drawPct + awayPct);
  const finalHome = homePct + diff;

  const over25 = 38 + ((h >>> 5) % 41);
  const under25 = 100 - over25;
  const bothTeamsToScore = 36 + ((h >>> 11) % 43);

  const expHome = Number((0.7 + ((h % 19) / 10)).toFixed(1));
  const expAway = Number((0.6 + (((h >>> 7) % 18) / 10)).toFixed(1));

  let mostLikelyOutcome = "X";
  if (finalHome >= awayPct && finalHome >= drawPct) mostLikelyOutcome = "1";
  else if (awayPct > finalHome && awayPct >= drawPct) mostLikelyOutcome = "2";

  const likelyScore =
    mostLikelyOutcome === "1"
      ? (over25 >= 55 ? "2-1" : "1-0")
      : mostLikelyOutcome === "2"
      ? (over25 >= 55 ? "1-2" : "0-1")
      : (over25 >= 55 ? "2-2" : "1-1");

  const prediction = {
    oneXTwo: { home: finalHome, draw: drawPct, away: awayPct },
    over25,
    under25,
    bothTeamsToScore,
    doubleChance: {
      "1X": Math.min(99, finalHome + drawPct),
      "X2": Math.min(99, awayPct + drawPct),
      "12": Math.min(99, finalHome + awayPct)
    },
    expectedGoals: { home: expHome, away: expAway },
    mostLikelyOutcome,
    likelyScore
  };

  const officialInfo = extractOfficialLineups(matchObj, homeTeam, awayTeam, h);
  const homePool = officialInfo.isOfficial ? officialInfo.homePlayers : homeSquad;
  const awayPool = officialInfo.isOfficial ? officialInfo.awayPlayers : awaySquad;

  const homeAttackers = pickPlayersByRole(homePool, homeTeam, ['offence', 'forward', 'attacker', 'winger', 'att', 'fwd'], 2, h % 97);
  const awayAttackers = pickPlayersByRole(awayPool, awayTeam, ['offence', 'forward', 'attacker', 'winger', 'att', 'fwd'], 2, (h >>> 4) % 97);
  const homeCardCandidates = pickPlayersByRole(homePool, homeTeam, ['midfield', 'defence', 'defender', 'midfielder', 'mid', 'def'], 2, (h >>> 8) % 97);
  const awayCardCandidates = pickPlayersByRole(awayPool, awayTeam, ['midfield', 'defence', 'defender', 'midfielder', 'mid', 'def'], 2, (h >>> 12) % 97);

  const bonusOfficial = officialInfo.isOfficial ? 4 : 0;

  const player_stats = {
    marcatori: [
      { name: homeAttackers[0], team: homeTeam, prob: `${Math.min(95, 22 + (h % 34) + bonusOfficial)}%` },
      { name: homeAttackers[1] || homeAttackers[0], team: homeTeam, prob: `${Math.min(95, 15 + ((h >>> 3) % 26) + bonusOfficial)}%` },
      { name: awayAttackers[0], team: awayTeam, prob: `${Math.min(95, 20 + ((h >>> 6) % 33) + bonusOfficial)}%` }
    ],
    ammoniti: [
      { name: homeCardCandidates[0], team: homeTeam, prob: `${Math.min(95, 18 + ((h >>> 9) % 28) + bonusOfficial)}%` },
      { name: awayCardCandidates[0], team: awayTeam, prob: `${Math.min(95, 17 + ((h >>> 13) % 28) + bonusOfficial)}%` }
    ],
    tiri: [
      { name: homeAttackers[0], team: homeTeam, prob: `${Math.min(98, 52 + ((h >>> 2) % 36) + bonusOfficial)}%` },
      { name: awayAttackers[0], team: awayTeam, prob: `${Math.min(98, 48 + ((h >>> 10) % 37) + bonusOfficial)}%` }
    ]
  };

  return { prediction, player_stats, lineups: officialInfo.lineups };
}

function upsertToSupabase(matches) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/matches`);
    const body = JSON.stringify(matches);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log(`Status Supabase: ${res.statusCode}`);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(responseData);
        else reject(new Error(`Errore Supabase (${res.statusCode}): ${responseData}`));
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  const now = new Date();
  const future = new Date(now);
  future.setDate(now.getDate() + 7);

  const dateFrom = now.toISOString().split('T')[0];
  const dateTo = future.toISOString().split('T')[0];

  const allMatches = [];

  for (const comp of COMPETITIONS) {
    const res = await fetchFootballData(
      `/v4/competitions/${comp.code}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );

    if (res.status !== 200 || !Array.isArray(res.body?.matches)) {
      console.log(`[${comp.name}] Risposta API ${res.status}:`, JSON.stringify(res.body?.message || res.body || {}));
      await sleep(6500);
      continue;
    }

    const matches = res.body.matches;
    console.log(`[${comp.name}] Partite trovate: ${matches.length}`);

    for (const m of matches) {
      const homeName = m.homeTeam?.shortName || m.homeTeam?.name;
      const awayName = m.awayTeam?.shortName || m.awayTeam?.name;
      const homeId = m.homeTeam?.id;
      const awayId = m.awayTeam?.id;
      if (!m.id || !homeName || !awayName || !m.utcDate) continue;

      const hasOfficialPreview =
        Array.isArray(m.homeTeam?.lineup) && m.homeTeam.lineup.length >= 7 &&
        Array.isArray(m.awayTeam?.lineup) && m.awayTeam.lineup.length >= 7;

      const homeSquad = hasOfficialPreview ? [] : await getTeamSquad(homeId);
      const awaySquad = hasOfficialPreview ? [] : await getTeamSquad(awayId);
      const tabData = buildTabData(m, homeName, awayName, homeSquad, awaySquad, m.id);

      allMatches.push({
        id: String(m.id),
        league: comp.name,
        home: homeName,
        away: awayName,
        kickoff: m.utcDate,
        prediction: tabData.prediction,
        player_stats: tabData.player_stats,
        lineups: tabData.lineups,
        updated_at: new Date().toISOString()
      });
    }

    await sleep(6500);
  }

  if (allMatches.length === 0) {
    console.log("Nessuna partita trovata nella finestra di 7 giorni.");
    return;
  }

  console.log(`Salvataggio di ${allMatches.length} partite su Supabase...`);
  await upsertToSupabase(allMatches);
  console.log("Sincronizzazione completata.");
}

run().catch(err => {
  console.error("Errore:", err);
  process.exit(1);
});
