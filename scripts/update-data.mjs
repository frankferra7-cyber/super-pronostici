import https from 'https';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!API_FOOTBALL_KEY) throw new Error("Missing API_FOOTBALL_KEY secret");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL secret");
if (!SUPABASE_SECRET_KEY) throw new Error("Missing SUPABASE_SECRET_KEY secret");

const COMPETITIONS = [
  { name: 'Serie A', id: 135 },
  { name: 'Premier League', id: 39 },
  { name: 'La Liga', id: 140 },
  { name: 'Bundesliga', id: 78 },
  { name: 'Ligue 1', id: 61 },
  { name: 'Champions League', id: 2 },
  { name: 'Serie B', id: 136 }
];

function fetchFromApi(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'v3.football.api-sports.io',
      path: path,
      method: 'GET',
      headers: {
        'x-apisports-key': API_FOOTBALL_KEY.trim()
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Risposta API non JSON: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function calculateDynamicOdds(homeTeam, awayTeam, fixtureId) {
  const idNum = Number(fixtureId) || 1;
  const homeSum = homeTeam.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const awaySum = awayTeam.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

  const rawSeed = (idNum * 7 + homeSum * 3 - awaySum * 2);
  const seed = ((rawSeed % 60) + 60) % 60;

  let homePct = 30 + (seed % 40);
  let awayPct = 15 + ((seed * 5) % 40);
  let drawPct = 100 - homePct - awayPct;

  if (drawPct < 15) drawPct = 22;
  if (drawPct > 35) drawPct = 25;

  const total = homePct + drawPct + awayPct;
  const hFin = Math.round((homePct / total) * 100);
  const dFin = Math.round((drawPct / total) * 100);
  const aFin = 100 - hFin - dFin;
  const over25 = hFin > aFin ? 62 : 48;

  return {
    oneXTwo: { home: hFin, draw: dFin, away: aFin },
    over25: over25,
    under25: 100 - over25,
    bothTeamsToScore: 55,
    doubleChance: { "1X": hFin + dFin, "X2": aFin + dFin, "12": 100 - dFin },
    expectedGoals: { home: (hFin / 25).toFixed(1), away: (aFin / 25).toFixed(1) },
    mostLikelyOutcome: hFin > aFin ? "1" : (aFin > hFin ? "2" : "X"),
    likelyScore: hFin > aFin ? "2-1" : (aFin > hFin ? "1-2" : "1-1")
  };
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
  const allMatches = [];
  const now = new Date();
  const season = now.getMonth() < 7 ? now.getFullYear() - 1 : now.getFullYear();

  console.log(`Stagione usata: ${season}`);

  for (const comp of COMPETITIONS) {
    console.log(`\n--- ${comp.name} (ID ${comp.id}) ---`);

    const roundsData = await fetchFromApi(`/fixtures/rounds?league=${comp.id}&season=${season}&current=true`);
    if (roundsData?.errors && Object.keys(roundsData.errors).length > 0) {
      console.log(`Errore API rounds per ${comp.name}:`, JSON.stringify(roundsData.errors));
      continue;
    }

    const currentRound = roundsData?.response?.[0];
    if (!currentRound) {
      console.log(`Nessun round corrente per ${comp.name}`);
      continue;
    }

    console.log(`Round corrente: ${currentRound}`);
    const fixturesData = await fetchFromApi(`/fixtures?league=${comp.id}&season=${season}&round=${encodeURIComponent(currentRound)}`);
    if (fixturesData?.errors && Object.keys(fixturesData.errors).length > 0) {
      console.log(`Errore API fixtures per ${comp.name}:`, JSON.stringify(fixturesData.errors));
      continue;
    }

    const fixtures = fixturesData?.response || [];
    console.log(`Partite trovate: ${fixtures.length}`);

    for (const fixture of fixtures) {
      const fixtureId = fixture.fixture?.id;
      const homeName = fixture.teams?.home?.name;
      const awayName = fixture.teams?.away?.name;
      const kickoff = fixture.fixture?.date;

      if (!fixtureId || !homeName || !awayName || !kickoff) continue;

      console.log(`  - ${homeName} vs ${awayName} (${kickoff})`);

      allMatches.push({
        id: String(fixtureId),
        league: comp.name,
        home: homeName,
        away: awayName,
        kickoff,
        prediction: calculateDynamicOdds(homeName, awayName, fixtureId),
        player_stats: { marcatori: [], ammoniti: [], tiri: [] },
        lineups: {
          home: { teamName: homeName, formation: "In attesa", isOfficial: false, startXI: [] },
          away: { teamName: awayName, formation: "In attesa", isOfficial: false, startXI: [] }
        },
        updated_at: new Date().toISOString()
      });
    }

    await sleep(250);
  }

  if (allMatches.length === 0) {
    console.log("Nessuna partita reale trovata da salvare.");
    return;
  }

  console.log(`\nSalvataggio di ${allMatches.length} partite reali su Supabase...`);
  await upsertToSupabase(allMatches);
  console.log("Fatto.");
}

run().catch(err => {
  console.error("Errore:", err);
  process.exit(1);
});
