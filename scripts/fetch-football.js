const https = require('https');

const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const COMPETITIONS = [
  { code: 'SA', name: 'Serie A' },
  { code: 'PL', name: 'Premier League' },
  { code: 'PD', name: 'La Liga' },
  { code: 'BL1', name: 'Bundesliga' },
  { code: 'FL1', name: 'Ligue 1' },
  { code: 'CL', name: 'Champions League' }
];

function fetchFootballData(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.football-data.org',
      path: `/v4${path}`,
      method: 'GET',
      headers: { 'X-Auth-Token': FOOTBALL_API_KEY }
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
      const data = await fetchFootballData(`/competitions/${comp.code}/matches?status=SCHEDULED`);
      const upcoming = (data.matches || []).slice(0, 5);

      for (const m of upcoming) {
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
          lineups: {
            home: { teamName: m.homeTeam.shortName || m.homeTeam.name, formation: "4-3-3", isOfficial: false, startXI: [] },
            away: { teamName: m.awayTeam.shortName || m.awayTeam.name, formation: "4-2-3-1", isOfficial: false, startXI: [] }
          },
          updated_at: new Date().toISOString()
        });
      }

      await sleep(6500); // Rispetta il limite gratuito di 10 chiamate al minuto
    }

    if (allMatches.length > 0) {
      console.log(`💾 Salvo ${allMatches.length} partite su Supabase...`);
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
