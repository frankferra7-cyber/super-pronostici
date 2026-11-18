import https from 'https';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!API_FOOTBALL_KEY) throw new Error("Missing API_FOOTBALL_KEY secret");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL secret");
if (!SUPABASE_SECRET_KEY) throw new Error("Missing SUPABASE_SECRET_KEY secret");

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
        console.log(`Risposta Supabase: ${responseData}`);
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
  try {
    console.log('🧪 Test di scrittura forzata su Supabase...');
    
    const testMatch = [{
      id: "999999",
      league: "Test League",
      home: "Squadra Casa Test",
      away: "Squadra Ospite Test",
      kickoff: new Date().toISOString(),
      prediction: {
        oneXTwo: { home: 50, draw: 25, away: 25 },
        over25: 60,
        under25: 40,
        bothTeamsToScore: 55,
        doubleChance: { "1X": 75, "X2": 50, "12": 75 },
        expectedGoals: { home: 2.0, away: 1.0 },
        mostLikelyOutcome: "1",
        likelyScore: "2-1"
      },
      player_stats: { marcatori: [], ammoniti: [], tiri: [] },
      lineups: {
        home: { teamName: "Squadra Casa Test", formation: "4-3-3", isOfficial: false, startXI: [] },
        away: { teamName: "Squadra Ospite Test", formation: "4-4-2", isOfficial: false, startXI: [] }
      },
      updated_at: new Date().toISOString()
    }];

    await upsertToSupabase(testMatch);
    console.log('✅ Riga di test inviata con successo!');
  } catch (err) {
    console.error('❌ Errore nel test:', err);
    process.exit(1);
  }
}

run();
