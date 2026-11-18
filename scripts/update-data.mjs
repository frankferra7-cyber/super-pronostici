import https from 'https';

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!FOOTBALL_DATA_KEY) throw new Error("Missing FOOTBALL_DATA_KEY secret");
if (!API_FOOTBALL_KEY) throw new Error("Missing API_FOOTBALL_KEY secret");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL secret");
if (!SUPABASE_SERVICE_KEY) throw new Error("Missing SUPABASE_SERVICE_KEY secret");

const COMPETITIONS = [
  { code: 'SA', name: 'Serie A' },
  { code: 'PL', name: 'Premier League' },
  { code: 'PD', name: 'La Liga' },
  { code: 'BL1', name: 'Bundesliga' },
  { code: 'FL1', name: 'Ligue 1' },
  { code: 'CL', name: 'Champions League' }
];

function fetchFromApi(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers };

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

async function fetchLineups(fixtureId) {
  try {
    // Endpoint ufficiale di API-Football per le formazioni
    const data = await fetchFromApi(
      'v3.football.api-sports.io',
      `/fixtures/lineups?fixture=${fixtureId}`,
      { 'x-apisports-key': API_FOOTBALL_KEY }
    );

    if (data && data.response && data.response.length > 0) {
      const homeLineupData = data.response[0];
      const awayLineupData = data.response[1] || {};

      return {
        home: {
          teamName: homeLineupData.team?.name || "Home",
          formation: homeLineupData.formation || "4-3-3",
          isOfficial: true,
          startXI: (homeLineupData.startXI || []).map(p => ({ id: p.player.id, name: p.player.name, number: p.player.number, pos: p.player.pos }))
        },
        away: {
          teamName: awayLineupData.team?.name || "Away",
          formation: awayLineupData.formation || "4-2-3-1",
          isOfficial: true,
          startXI: (awayLineupData.startXI || []).map(p => ({ id: p.player.id, name: p.player.name, number: p.player.number, pos: p.player.pos }))
        }
      };
    }
  } catch (err) {
    console.warn(`⚠️ Impossibile recuperare le formazioni per il match ${fixtureId}:`, err.message);
  }

  // Fallback di default se le formazioni non sono ancora disponibili (es. match a giorni di distanza)
  return {
    home: { teamName: "Casa", formation: "4-3-3", isOfficial: false, startXI: [] },
    away: { teamName: "Ospiti", formation: "4-2-3-1", isOfficial: false, startXI: [] }
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
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
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

    for (const comp of COMPETITIONS) {
      console.log(`🔄 Scarico partite per ${comp.name}...`);
      const data = await fetchFromApi(
        'api.football-data.org',
        `/v4/competitions/${comp.code}/matches?status=SCHEDULED`,
        { 'X-Auth-Token': FOOTBALL_DATA_KEY }
      );
      
      const upcoming = (data.matches || []).slice(0, 3); // Limitiamo per preservare i limiti delle API

      for (const m of upcoming) {
        // Nota: se gli ID tra football-data e api-football differiscono, 
        // qui andrebbe mappato l'ID. Per ora usiamo m.id come riferimento.
        const lineups = await fetchLineups(m.id);

        allMatches.push({
          id: String(m.id),
          league: comp.name,
          home: m.homeTeam.shortName || m.homeTeam.name,
          away: m.awayTeam.shortName || m.awayTeam.name,
          kickoff: m.utcDate,
          prediction: {
            oneXTwo: { home: 45, draw: 30, away: 25 },
            over25: 55,
            under25: 45,
            bothTeamsToScore: 52,
            doubleChance: { "1X": 75, "X2": 55, "12": 70 },
            expectedGoals: { home: 1.6, away: 1.1 },
            mostLikelyOutcome: "1",
            likelyScore: "2-1"
          },
          player_stats: { ammoniti: [], tiri: [], marcatori: [] },
          lineups: lineups,
          updated_at: new Date().toISOString()
        });

        await sleep(500); // Pausa breve tra una richiesta di lineup e l'altra
      }

      await sleep(2000);
    }

    if (allMatches.length > 0) {
      console.log(`💾 Salvo ${allMatches.length} partite su Supabase con relative formazioni...`);
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
