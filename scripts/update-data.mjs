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

  await sleep(6500); // Rispetta il limite di ~10 richieste al minuto del piano free
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

function pickPlayersByRole(squad, teamName, roles, count, seedOffset = 0) {
  const normalizedRoles = roles.map(r => r.toLowerCase());
  const matching = squad.filter(p => {
    const pos = String(p.position || '').toLowerCase();
    return normalizedRoles.some(role => pos.includes(role));
  });

  const pool = matching.length >= count ? matching : (squad.length ? squad : []);
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

function seedFromMatch(homeTeam, awayTeam, matchId) {
  const idNum = Number(matchId) || 1;
  const homeSum = homeTeam.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const awaySum = awayTeam.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return Math.abs(idNum * 13 + homeSum * 5 - awaySum * 3) % 100;
}

function buildTabData(homeTeam, awayTeam, homeSquad, awaySquad, matchId) {
  const seed = seedFromMatch(homeTeam, awayTeam, matchId);

  let homePct = 28 + (seed % 42);
  let awayPct = 16 + ((seed * 7) % 38);
  let drawPct = 100 - homePct - awayPct;

  if (drawPct < 16) drawPct = 22;
  if (drawPct > 34) drawPct = 26;

  const total = homePct + drawPct + awayPct;
  const hFin = Math.round((homePct / total) * 100);
  const dFin = Math.round((drawPct / total) * 100);
  const aFin = 100 - hFin - dFin;

  const over25 = 45 + (seed % 32);
  const under25 = 100 - over25;
  const bttsYes = 44 + ((seed * 3) % 30);

  const prediction = {
    oneXTwo: { home: hFin, draw: dFin, away: aFin },
    over25,
    under25,
    bothTeamsToScore: bttsYes,
    doubleChance: {
      "1X": hFin + dFin,
      "X2": aFin + dFin,
      "12": 100 - dFin
    },
    expectedGoals: {
      home: Number((0.9 + (hFin / 55)).toFixed(1)),
      away: Number((0.7 + (aFin / 60)).toFixed(1))
    },
    mostLikelyOutcome: hFin >= aFin && hFin >= dFin ? "1" : (aFin > hFin ? "2" : "X"),
    likelyScore: hFin > aFin + 10 ? "2-1" : (aFin > hFin + 10 ? "1-2" : "1-1")
  };

  const homeAttackers = pickPlayersByRole(homeSquad, homeTeam, ['offence', 'forward', 'attacker', 'winger'], 2, seed);
  const awayAttackers = pickPlayersByRole(awaySquad, awayTeam, ['offence', 'forward', 'attacker', 'winger'], 2, seed + 5);
  const homeCardCandidates = pickPlayersByRole(homeSquad, homeTeam, ['midfield', 'defence', 'defender', 'midfielder'], 2, seed + 11);
  const awayCardCandidates = pickPlayersByRole(awaySquad, awayTeam, ['midfield', 'defence', 'defender', 'midfielder'], 2, seed + 17);

  const player_stats = {
    marcatori: [
      { name: homeAttackers[0], team: homeTeam, prob: `${30 + (seed % 25)}%` },
      { name: homeAttackers[1] || homeAttackers[0], team: homeTeam, prob: `${20 + ((seed * 2) % 20)}%` },
      { name: awayAttackers[0], team: awayTeam, prob: `${26 + ((seed * 3) % 24)}%` }
    ],
    ammoniti: [
      { name: homeCardCandidates[0], team: homeTeam, prob: `${24 + (seed % 22)}%` },
      { name: awayCardCandidates[0], team: awayTeam, prob: `${22 + ((seed * 2) % 22)}%` }
    ],
    tiri: [
      { name: homeAttackers[0], team: homeTeam, prob: `${62 + (seed % 26)}%` },
      { name: awayAttackers[0], team: awayTeam, prob: `${56 + ((seed * 2) % 26)}%` }
    ]
  };

  const lineups = {
    home: {
      teamName: homeTeam,
      formation: seed % 2 === 0 ? "4-3-3" : "3-5-2",
      isOfficial: false,
      startXI: []
    },
    away: {
      teamName: awayTeam,
      formation: seed % 2 === 0 ? "4-2-3-1" : "4-4-2",
      isOfficial: false,
      startXI: []
    }
  };

  return { prediction, player_stats, lineups };
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

      const homeSquad = await getTeamSquad(homeId);
      const awaySquad = await getTeamSquad(awayId);
      const tabData = buildTabData(homeName, awayName, homeSquad, awaySquad, m.id);

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
