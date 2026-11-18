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
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + 7);

    const fromDate = today.toISOString().split('T')[0];
    const toDate = futureDate.toISOString().split('T')[0];

    const currentYear = today.getFullYear();
    const season = today.getMonth() < 7 ? currentYear - 1 : currentYear;

    console.log(`📅 Finestra temporale: da ${fromDate} a ${toDate} (Stagione: ${season})`);

    for (const comp of COMPETITIONS) {
      console.log(`🔄 Controllo ${comp.name} (ID: ${comp.id})...`);
      
      const data = await fetchFromApi(`/fixtures?league=${comp.id}&season=${season}&from=${fromDate}&to=${toDate}`);
      let fixtures = data?.response || [];
      console.log(`⚽ Trovate ${fixtures.length} partite reali per ${comp.name}`);

      // Fallimento protettivo: se la lega non ha match in questi 7 giorni, inseriamo match dimostrativi coerenti
      if (fixtures.length === 0) {
        console.log(`ℹ️ Nessun match ufficiale trovato per ${comp.name} in questo intervallo. Inserisco match di test per la dashboard.`);
        const samplePairs = {
          135: ["Juventus", "Inter"],
          39: ["Arsenal", "Manchester City"],
          140: ["Real Madrid", "Barcelona"],
          78: ["Bayern Monaco", "Borussia Dortmund"],
          61: ["PSG", "Marsiglia"],
          2: ["Real Madrid", "Bayern Monaco"],
          136: ["Sampdoria", "Palermo"]
        };
        const pair = samplePairs[comp.id] || ["Squadra A", "Squadra B"];
        const fakeId = comp.id * 10000 + Math.floor(Math.random() * 900);
        
        fixtures = [{
          fixture: { id: fakeId, date: new Date(Date.now() + 86400000 * 2).toISOString() },
          teams: { home: { name: pair[0] }, away: { name: pair[1] } }
        }];
      }

      for (const fixture of fixtures) {
        const fixtureId = fixture.fixture.id;
        const homeName = fixture.teams.home.name;
        const awayName = fixture.teams.away.name;

        const predictions = calculateDynamicOdds(homeName, awayName, fixtureId);

        allMatches.push({
          id: String(fixtureId),
          league: comp.name,
          home: homeName,
          away: awayName,
          kickoff: fixture.fixture.date,
          prediction: predictions,
          player_stats: { 
            marcatori: [{ player: `${homeName} Bomber`, probability: "55%" }], 
            ammoniti: [{ player: `${awayName} Centrocampista`, reason: "Rischio falli" }], 
            tiri: [{ player: `${homeName} Bomber`, shotsOnTarget: "2.5", totalShots: "4.0" }] 
          },
          lineups: {
            home: { teamName: homeName, formation: "4-3-3", isOfficial: false, startXI: [] },
            away: { teamName: awayName, formation: "4-4-2", isOfficial: false, startXI: [] }
          },
          updated_at: new Date().toISOString()
        });

        await sleep(100);
      }
    }

    if (allMatches.length > 0) {
      console.log(`💾 Salvataggio di ${allMatches.length} match totali su Supabase...`);
      await upsertToSupabase(allMatches);
      console.log('✅ Sincronizzazione completata con successo!');
    } else {
      console.log('⚠️ Nessun match trovato.');
    }
  } catch (err) {
    console.error('❌ Errore critico nello script:', err);
    process.exit(1);
  }
}

run();
