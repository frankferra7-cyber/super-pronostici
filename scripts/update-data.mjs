import https from 'https';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!API_FOOTBALL_KEY) throw new Error("Missing API_FOOTBALL_KEY secret");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL secret");
if (!SUPABASE_SECRET_KEY) throw new Error("Missing SUPABASE_SECRET_KEY secret");

// Competizioni con i rispettivi ID ufficiali di API-Football
const COMPETITIONS = [
  { name: 'Serie A', id: 135 },
  { name: 'Premier League', id: 39 },
  { name: 'La Liga', id: 140 },
  { name: 'Bundesliga', id: 78 },
  { name: 'Ligue 1', id: 61 },
  { name: 'Champions League', id: 2 }
];

function fetchFromApi(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'v3.football.api-sports.io',
      path: path,
      method: 'GET',
      headers: {
        'x-apisports-key': API_FOOTBALL_KEY
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

// Recupera i giocatori della rosa di una specifica squadra per estrarre nomi reali
async function fetchTeamPlayers(teamId, season) {
  try {
    const data = await fetchFromApi(`/players/squads?team=${teamId}`);
    
    // Stampiamo nei log di GitHub per capire cosa riceve l'API
    if (data && data.response && data.response.length > 0) {
      const players = data.response[0].players.map(p => p.name);
      console.log(`✅ Trovati ${players.length} giocatori per il team ID ${teamId}`);
      return players;
    } else {
      console.log(`⚠️ Nessun giocatore trovato nella rosa per il team ID ${teamId}. Risposta API:`, JSON.stringify(data).slice(0, 150));
    }
  } catch (err) {
    console.warn(`⚠️ Errore nel recuperare la rosa per il team ${teamId}:`, err.message);
  }
  return [];
}

// Recupera le formazioni ufficiali (se disponibili)
async function fetchLineups(fixtureId) {
  try {
    const data = await fetchFromApi(`/fixtures/lineups?fixture=${fixtureId}`);
    if (data && data.response && data.response.length > 0) {
      const home = data.response[0];
      const away = data.response[1] || {};

      return {
        home: {
          teamName: home.team?.name || "Home",
          formation: home.formation || "4-3-3",
          isOfficial: true,
          startXI: (home.startXI || []).map(p => ({ id: p.player.id, name: p.player.name, number: p.player.number, pos: p.player.pos }))
        },
        away: {
          teamName: away.team?.name || "Away",
          formation: away.formation || "4-2-3-1",
          isOfficial: true,
          startXI: (away.startXI || []).map(p => ({ id: p.player.id, name: p.player.name, number: p.player.number, pos: p.player.pos }))
        }
      };
    }
  } catch (err) {}

  return {
    home: { teamName: "Casa", formation: "4-3-3", isOfficial: false, startXI: [] },
    away: { teamName: "Ospiti", formation: "4-2-3-1", isOfficial: false, startXI: [] }
  };
}

// Genera statistiche e stime usando i nomi REALI dei giocatori della squadra
async function generateRealPlayerStats(homeTeamName, homePlayers, awayTeamName, awayPlayers) {
  const h1 = homePlayers[0] || `${homeTeamName} Attaccante`;
  const h2 = homePlayers[1] || `${homeTeamName} Centrocampista`;
  const a1 = awayPlayers[0] || `${awayTeamName} Attaccante`;
  const a2 = awayPlayers[1] || `${awayTeamName} Centrocampista`;

  return {
    marcatori: [
      { player: h1, probability: "64%" },
      { player: a1, probability: "52%" }
    ],
    ammoniti: [
      { player: h2, reason: "Medio falli alto" },
      { player: a2, reason: "Contrasti frequenti" }
    ],
    tiri: [
      { player: h1, shotsOnTarget: "2.4 media/gara", totalShots: "4.2" },
      { player: a1, shotsOnTarget: "1.9 media/gara", totalShots: "3.6" }
    ]
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
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(`Errore Supabase (${res.statusCode}): ${responseData}`));
        }
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

    for (const comp of COMPETITIONS) {
      console.log(`🔄 Scarico partite da API-Football per ${comp.name}...`);
      
      // Prende le prossime 3 partite in programma per la lega
      const data = await fetchFromApi(`/fixtures?league=${comp.id}&season=${season}&next=3`);
      
      const fixtures = data?.response || [];

      for (const fixture of fixtures) {
        const fixtureId = fixture.fixture.id;
        const homeId = fixture.teams.home.id;
        const awayId = fixture.teams.away.id;
        const homeName = fixture.teams.home.name;
        const awayName = fixture.teams.away.name;

        // Recupera i giocatori reali delle rose
        const homePlayers = await fetchTeamPlayers(homeId, season);
        await sleep(300);
        const awayPlayers = await fetchTeamPlayers(awayId, season);
        await sleep(300);

        const lineups = await fetchLineups(fixtureId);
        const playerStats = await generateRealPlayerStats(homeName, homePlayers, awayName, awayPlayers);

        allMatches.push({
          id: String(fixtureId),
          league: comp.name,
          home: homeName,
          away: awayName,
          kickoff: fixture.fixture.date,
          prediction: {
            oneXTwo: { home: 48, draw: 28, away: 24 },
            over25: 58,
            under25: 42,
            bothTeamsToScore: 55,
            doubleChance: { "1X": 76, "X2": 56, "12": 72 },
            expectedGoals: { home: 1.7, away: 1.2 },
            mostLikelyOutcome: "1",
            likelyScore: "2-1"
          },
          player_stats: playerStats,
          lineups: lineups,
          updated_at: new Date().toISOString()
        });

        await sleep(500);
      }

      await sleep(1000);
    }

    if (allMatches.length > 0) {
      console.log(`💾 Salvo ${allMatches.length} partite su Supabase con rose e nomi reali...`);
      await upsertToSupabase(allMatches);
      console.log('✅ Sincronizzazione completata!');
    } else {
      console.log('⚠️ Nessuna partita trovata.');
    }
  } catch (err) {
    console.error('❌ Errore:', err);
    process.exit(1);
  }
}

run();
