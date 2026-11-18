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
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function calculateDynamicOdds(homeTeam, awayTeam, fixtureId) {
  const idNum = Number(fixtureId) || Math.floor(Math.random() * 100000);
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

async function fetchOfficialLineupsAndPlayerStats(fixtureId, homeTeamName, awayTeamName) {
  try {
    const data = await fetchFromApi(`/fixtures/lineups?fixture=${fixtureId}`);
    if (data && data.response && data.response.length > 0) {
      const home = data.response.find(r => r.team.name === homeTeamName) || data.response[0];
      const away = data.response.find(r => r.team.name === awayTeamName) || data.response[1];

      const homeXI = home?.startXI || [];
      const awayXI = away?.startXI || [];

      if (homeXI.length > 0 && awayXI.length > 0) {
        const homeForwards = homeXI.filter(p => p.player.pos === 'F').map(p => p.player.name);
        const awayForwards = awayXI.filter(p => p.player.pos === 'F').map(p => p.player.name);
        const homeMid = homeXI.filter(p => p.player.pos === 'M' || p.player.pos === 'D').map(p => p.player.name);
        const awayMid = awayXI.filter(p => p.player.pos === 'M' || p.player.pos === 'D').map(p => p.player.name);

        return {
          lineups: {
            home: {
              teamName: home.team.name,
              formation: home.formation || "N/D",
              isOfficial: true,
              startXI: homeXI.map(p => ({ id: p.player.id, name: p.player.name, number: p.player.number, pos: p.player.pos }))
            },
            away: {
              teamName: away.team.name,
              formation: away.formation || "N/D",
              isOfficial: true,
              startXI: awayXI.map(p => ({ id: p.player.id, name: p.player.name, number: p.player.number, pos: p.player.pos }))
            }
          },
          player_stats: {
            marcatori: [
              { player: homeForwards[0] || homeXI[0].player.name, probability: "55%" },
              { player: awayForwards[0] || awayXI[0].player.name, probability: "45%" }
            ],
            ammoniti: [
              { player: homeMid[0] || homeXI[1].player.name, reason: "Titolare - Rischio falli" },
              { player: awayMid[0] || awayXI[1].player.name, reason: "Titolare - Contrasti frequenti" }
            ],
            tiri: [
              { player: homeForwards[0] || homeXI[0].player.name, shotsOnTarget: "2.0 media", totalShots: "3.5" },
              { player: awayForwards[0] || awayXI[0].player.name, shotsOnTarget: "1.6 media", totalShots: "3.0" }
            ]
          }
        };
      }
    }
  } catch (err) {}

  return {
    lineups: {
      home: { teamName: homeTeamName, formation: "In attesa", isOfficial: false, startXI: [] },
      away: { teamName: awayTeamName, formation: "In attesa", isOfficial: false, startXI: [] }
    },
    player_stats: { marcatori: [], ammoniti: [], tiri: [] }
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
  try {
    const allMatches = [];
    const currentYear = new Date().getFullYear();
    const season = new Date().getMonth() < 7 ? currentYear - 1 : currentYear;

    console.log(`📅 Stagione di riferimento API-Football: ${season}`);

    for (const comp of COMPETITIONS) {
      console.log(`🔄 Scarico partite reali per ${comp.name} (ID: ${comp.id})...`);
      
      // Sfruttiamo il parametro ufficiale next=7 per prendere i prossimi 7 match reali della lega
      const data = await fetchFromApi(`/fixtures?league=${comp.id}&season=${season}&next=7`);
      const fixtures = data?.response || [];
      console.log(`⚽ Trovate ${fixtures.length} partite reali per ${comp.name}`);

      for (const fixture of fixtures) {
        const fixtureId = fixture.fixture.id;
        const homeName = fixture.teams.home.name;
        const awayName = fixture.teams.away.name;

        const predictions = calculateDynamicOdds(homeName, awayName, fixtureId);
        const matchData = await fetchOfficialLineupsAndPlayerStats(fixtureId, homeName, awayName);

        allMatches.push({
          id: String(fixtureId),
          league: comp.name,
          home: homeName,
          away: awayName,
          kickoff: fixture.fixture.date,
          prediction: predictions,
          player_stats: matchData.player_stats,
          lineups: matchData.lineups,
          updated_at: new Date().toISOString()
        });

        await sleep(300);
      }
    }

    if (allMatches.length > 0) {
      console.log(`💾 Salvataggio di ${allMatches.length} match reali totali su Supabase...`);
      await upsertToSupabase(allMatches);
      console.log('✅ Sincronizzazione completata con successo!');
    } else {
      console.log('⚠️ Nessuna partita trovata al momento per le leghe selezionate.');
    }
  } catch (err) {
    console.error('❌ Errore critico nello script:', err);
    process.exit(1);
  }
}

run();
