const fs = require('fs');
const https = https = require('https');

const API_KEY = process.env.RAPIDAPI_KEY;
const API_HOST = 'api-football-v1.p.rapidapi.com';

async function callApi(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      path: path,
      method: 'GET',
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': API_HOST
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || []);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function generateFixturesFile() {
  try {
    console.log("🔄 Connessione ad API-Football in corso...");
    const today = new Date().toISOString().split('T')[0];
    const fixturesRaw = await callApi(`/fixtures?date=${today}`);
    const matches = [];

    for (const f of fixturesRaw) {
      const fixtureId = f.fixture.id;
      const leagueName = f.league.name;
      const homeTeam = f.teams.home.name;
      const awayTeam = f.teams.away.name;
      const kickoff = f.fixture.date;

      const playersStatsRaw = await callApi(`/fixtures/players?fixture=${fixtureId}`);
      const ammoniti = [];
      const tiri = [];
      const marcatori = [];

      if (playersStatsRaw && playersStatsRaw.length > 0) {
        for (const teamData of playersStatsRaw) {
          const teamName = teamData.team.name;
          for (const p of teamData.players) {
            const player = p.player;
            const stats = p.statistics[0];
            if (!stats) continue;

            if (stats.cards && stats.cards.yellow > 0) {
              ammoniti.push({ name: player.name, team: teamName, prob: "Verificato (Cartellino)" });
            }
            if (stats.shots && stats.shots.on > 0) {
              tiri.push({ name: player.name, team: teamName, prob: `${stats.shots.on} tiri in porta` });
            }
            if (stats.goals && stats.goals.total > 0) {
              marcatori.push({ name: player.name, team: teamName, prob: `${stats.goals.total} gol` });
            }
          }
        }
      }

      matches.push({
        id: String(fixtureId),
        league: leagueName,
        home: homeTeam,
        away: awayTeam,
        kickoff: kickoff,
        prediction: {
          oneXTwo: { home: 50, draw: 30, away: 20 },
          over25: 50,
          under25: 50,
          bothTeamsToScore: 50,
          doubleChance: { "1X": 70, "X2": 60, "12": 70 },
          expectedGoals: { home: 1.5, away: 1.0 },
          mostLikelyOutcome: "1",
          likelyScore: "1-0"
        },
        playerStats: { ammoniti, tiri, marcatori }
      });
    }

    const payload = { generatedAt: new Date().toISOString(), matches };

    if (!fs.existsSync('./data')) {
      fs.mkdirSync('./data');
    }

    fs.writeFileSync('./data/fixtures.json', JSON.stringify(payload, null, 2));
    console.log("✅ File fixtures.json generato con successo!");
  } catch (error) {
    console.error("❌ Errore:", error);
    process.exit(1);
  }
}

generateFixturesFile();
