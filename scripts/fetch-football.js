const https = require('https');
const fs = require('fs');

const API_KEY = process.env.RAPIDAPI_KEY;
const API_HOST = 'api-football-v1.p.rapidapi.com';

// Cache per non scaricare due volte la stessa squadra e risparmiare chiamate API
const teamStatsCache = {};

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

async function getSeasonPlayers(teamId, leagueId, season) {
  const key = `${teamId}_${leagueId}_${season}`;
  if (teamStatsCache[key]) return teamStatsCache[key];

  // Scarica la rosa con le statistiche stagionali (pagina 1 = primi 20 giocatori)
  const response = await callApi(`/players?team=${teamId}&league=${leagueId}&season=${season}&page=1`);
  teamStatsCache[key] = response || [];
  return teamStatsCache[key];
}

async function run() {
  try {
    // Inserisci qui gli ID dei campionati che vuoi (es. 135 = Serie A, 39 = Premier League, 140 = La Liga)
    const LEAGUES = [135];
    const SEASON = 2026;
    const matches = [];

    for (const leagueId of LEAGUES) {
      console.log(`🔄 Scarico prossime partite per Lega ${leagueId} (Stagione ${SEASON})...`);
      // Prendiamo le prossime 5 partite della lega per restare dentro i limiti del piano gratuito
      const fixturesRaw = await callApi(`/fixtures?league=${leagueId}&season=${SEASON}&next=5`);
      console.log(`📊 Partite trovate: ${fixturesRaw.length}`);

      for (const f of fixturesRaw) {
        const homeTeam = f.teams.home;
        const awayTeam = f.teams.away;

        console.log(`🔎 Analizzo statistiche giocatori: ${homeTeam.name} vs ${awayTeam.name}`);

        const homePlayers = await getSeasonPlayers(homeTeam.id, leagueId, SEASON);
        const awayPlayers = await getSeasonPlayers(awayTeam.id, leagueId, SEASON);

        const combinedPlayers = [
          ...homePlayers.map(item => ({ ...item, teamName: homeTeam.name })),
          ...awayPlayers.map(item => ({ ...item, teamName: awayTeam.name }))
        ];

        const ammonitiList = [];
        const tiriList = [];
        const marcatoriList = [];

        for (const entry of combinedPlayers) {
          const playerName = entry.player.name;
          const stats = entry.statistics && entry.statistics[0];
          if (!stats) continue;

          const appearances = stats.games?.appearences || 1;
          const yellows = stats.cards?.yellow || 0;
          const shotsOn = stats.shots?.on || 0;
          const goals = stats.goals?.total || 0;

          if (yellows > 0) {
            const prob = Math.min(85, Math.round((yellows / appearances) * 100));
            ammonitiList.push({
              name: playerName,
              team: entry.teamName,
              count: yellows,
              prob: `${prob}% (${yellows} gialli)`
            });
          }

          if (shotsOn > 0) {
            const avg = (shotsOn / appearances).toFixed(1);
            tiriList.push({
              name: playerName,
              team: entry.teamName,
              count: shotsOn,
              prob: `${avg} tiri in porta/gara`
            });
          }

          if (goals > 0) {
            const probGoal = Math.min(80, Math.round((goals / appearances) * 100));
            marcatoriList.push({
              name: playerName,
              team: entry.teamName,
              count: goals,
              prob: `${probGoal}% (${goals} gol)`
            });
          }
        }

        // Ordiniamo dal più alto al più basso e prendiamo i primi 4 per ogni categoria
        ammonitiList.sort((a, b) => b.count - a.count);
        tiriList.sort((a, b) => b.count - a.count);
        marcatoriList.sort((a, b) => b.count - a.count);

        matches.push({
          id: String(f.fixture.id),
          league: f.league.name,
          home: homeTeam.name,
          away: awayTeam.name,
          kickoff: f.fixture.date,
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
          playerStats: {
            ammoniti: ammonitiList.slice(0, 4).map(({ count, ...rest }) => rest),
            tiri: tiriList.slice(0, 4).map(({ count, ...rest }) => rest),
            marcatori: marcatoriList.slice(0, 4).map(({ count, ...rest }) => rest)
          }
        });
      }
    }

    const payload = { generatedAt: new Date().toISOString(), matches };

    if (!fs.existsSync('./data')) {
      fs.mkdirSync('./data');
    }

    fs.writeFileSync('./data/fixtures.json', JSON.stringify(payload, null, 2));
    console.log(`✅ Completato! Salvate ${matches.length} partite con pronostici giocatori.`);
  } catch (err) {
    console.error("❌ Errore durante l'esecuzione:", err);
    process.exit(1);
  }
}

run();
