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

function seedFromMatch(homeTeam, awayTeam, matchId) {
  const idNum = Number(matchId) || 1;
  const homeSum = homeTeam.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const awaySum = awayTeam.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return Math.abs(idNum * 13 + homeSum * 5 - awaySum * 3) % 100;
}

function buildTabData(homeTeam, awayTeam, matchId) {
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

  // Chiavi allineate a index.html: name, team, prob
  const player_stats = {
    marcatori: [
      { name: `${homeTeam} #9`, team: homeTeam, prob: `${32 + (seed % 25)}%` },
      { name: `${homeTeam} #11`, team: homeTeam, prob: `${22 + ((seed * 2) % 20)}%` },
      { name: `${awayTeam} #9`, team: awayTeam, prob: `${28 + ((seed * 3) % 24)}%` }
    ],
    ammoniti: [
      { name: `${homeTeam} #6`, team: homeTeam, prob: `${26 + (seed % 22)}%` },
      { name: `${awayTeam} #8`, team: awayTeam, prob: `${24 + ((seed * 2) % 22)}%` }
    ],
    tiri: [
      { name: `${homeTeam} #9`, team: homeTeam, prob: `${65 + (seed % 25)}%` },
      { name: `${awayTeam} #9`, team: awayTeam, prob: `${58 + ((seed * 2) % 26)}%` }
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      if (!m.id || !homeName || !awayName || !m.utcDate) continue;

      const tabData = buildTabData(homeName, awayName, m.id);

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
