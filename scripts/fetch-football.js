const https = require('https');
const fs = require('fs');

const API_KEY = process.env.RAPIDAPI_KEY;
const API_HOST = 'api-football-v1.p.rapidapi.com';

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

  let allPlayers = [];
  try {
    const page1 = await callApi(`/players?team=${teamId}&league=${leagueId}&season=${season}&page=1`);
    const page2 = await callApi(`/players?team=${teamId}&league=${leagueId}&season=${season}&page=2`);
    allPlayers = [...(page1 || []), ...(page2 || [])];
  } catch (e) {
    console.log(`⚠️ Errore nel recupero giocatori per il team ${teamId}`);
  }

  teamStatsCache[key] = allPlayers;
  return allPlayers;
}

async function run() {
  try {
    // 135: Serie A, 39: Premier, 61: Ligue 1, 2: Champions, 140: Liga, 78: Bundesliga, 3: Europa League
    const LEAGUES = [135, 39, 61, 2, 140, 78, 3]; 
    const SEASON = 2026;
    const matches = [];

    for (const leagueId of LEAGUES) {
      console.log(`🔄 Scarico prossime partite per Lega ID ${leagueId} (Stagione ${SEASON})...`);
      // Usiamo next=2 per ogni campionato per restare nel limite delle 100 chiamate giornaliere gratuite
      const fixturesRaw = await callApi(`/fixtures?league=${leagueId}&season=${SEASON}&next=2`);
      console.log(`📊 Partite trovate per Lega ${leagueId}: ${fixturesRaw.length}`);

      for (const f of fixturesRaw) {
        const homeTeam = f.teams.home;
        const awayTeam = f.teams.away;

        console.log(`🔎 Analizzo statistiche per: ${homeTeam.name} vs ${awayTeam.name}`);

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
          if (!entry.statistics || entry.statistics.length === 0) continue;

          const stats = entry.statistics.find(s => s.league && s.league.id === leagueId);
          if (!stats) continue;

          const appearances = stats.games?.appearences || 1;
          const yellows = stats.cards?.yellow || 0;
          const shotsOn = stats.shots?.on || 0;
          const goals = stats.goals?.total || 0;

          if (yellows > 0) {
            const prob = Math.min(90, Math.round((yellows / appearances) * 100) + 15);
            ammonitiList.push({
              name: playerName,
              team: entry.teamName,
              count: yellows,
              prob: `${prob}% prob. (${yellows} gialli in stagione)`
            });
          }

          if (shotsOn > 0) {
            const avg = (shotsOn / appearances).toFixed(1);
            tiriList.push({
              name: playerName,
              team: entry.teamName,
              count: shotsOn,
              prob: `${avg} tiri in porta a partita`
            });
          }

          if (goals > 0) {
            const probGoal = Math.min(85, Math.round((goals / appearances) * 100) + 20);
            marcatoriList.push({
              name: playerName,
              team: entry.teamName,
              count: goals,
              prob: `${probGoal}% prob. (${goals} gol in stagione)`
            });
          }
        }

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
    console.log(`✅ File fixtures.json generato con successo (inclusa l'Europa League)!`);
  } catch (err) {
    console.error("❌ Errore:", err);
    process.exit(1);
  }
}

run();
