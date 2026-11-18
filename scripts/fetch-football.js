const teamPlayersCache = {};

async function getTeamTopPlayers(teamId, leagueId, season) {
  const cacheKey = `${teamId}-${leagueId}`;
  if (teamPlayersCache[cacheKey]) {
    return teamPlayersCache[cacheKey];
  }

  // Chiediamo le statistiche stagionali dei giocatori della squadra
  const data = await callApi(`/players?team=${teamId}&league=${leagueId}&season=${season}`);
  teamPlayersCache[cacheKey] = data || [];
  return teamPlayersCache[cacheKey];
}

async function generateFixturesFile() {
  try {
    console.log("🔄 Connessione ad API-Football per pronostici pre-partita (prossimi 7 giorni)...");

    const todayObj = new Date();
    const futureObj = new Date();
    futureObj.setDate(todayObj.getDate() + 7);

    const today = todayObj.toISOString().split('T')[0];
    const futureDate = futureObj.toISOString().split('T')[0];

    // Sostituisci o aggiungi qui gli ID dei tuoi campionati preferiti (es. 135 = Serie A, 39 = Premier League, 140 = La Liga)
    const LEAGUES = [135]; 
    const SEASON = 2026;
    const matches = [];

    for (const leagueId of LEAGUES) {
      console.log(`📅 Cerco partite Lega ${leagueId} dal ${today} al ${futureDate}`);
      const fixturesRaw = await callApi(`/fixtures?league=${leagueId}&season=${SEASON}&from=${today}&to=${futureDate}`);

      for (const f of fixturesRaw) {
        const fixtureId = f.fixture.id;
        const leagueName = f.league.name;
        const homeTeam = f.teams.home;
        const awayTeam = f.teams.away;
        const kickoff = f.fixture.date;

        // Recuperiamo le statistiche stagionali dei giocatori di entrambe le squadre
        const homePlayers = await getTeamTopPlayers(homeTeam.id, leagueId, SEASON);
        const awayPlayers = await getTeamTopPlayers(awayTeam.id, leagueId, SEASON);

        const allCandidates = [
          ...homePlayers.map(p => ({ ...p, teamName: homeTeam.name })),
          ...awayPlayers.map(p => ({ ...p, teamName: awayTeam.name }))
        ];

        const ammoniti = [];
        const tiri = [];
        const marcatori = [];

        for (const item of allCandidates) {
          const player = item.player;
          const stats = item.statistics && item.statistics[0];
          if (!stats) continue;

          const appearances = stats.games?.appearences || 1;
          const yellows = stats.cards?.yellow || 0;
          const shotsOn = stats.shots?.on || 0;
          const goals = stats.goals?.total || 0;

          // Filtriamo i giocatori più propensi in base ai numeri stagionali
          if (yellows >= 2) {
            const prob = Math.min(85, Math.round((yellows / appearances) * 100));
            ammoniti.push({
              name: player.name,
              team: item.teamName,
              yellows: yellows,
              prob: `${prob}% (${yellows} gialli)`
            });
          }

          if (shotsOn >= 3) {
            const avgShots = (shotsOn / appearances).toFixed(1);
            tiri.push({
              name: player.name,
              team: item.teamName,
              shotsOn: shotsOn,
              prob: `${avgShots} tiri in porta/partita`
            });
          }

          if (goals >= 2) {
            const probGoal = Math.min(80, Math.round((goals / appearances) * 100));
            marcatori.push({
              name: player.name,
              team: item.teamName,
              goals: goals,
              prob: `${probGoal}% (${goals} gol)`
            });
          }
        }

        // Ordiniamo per prendere i top 4 più probabili per categoria
        ammoniti.sort((a, b) => b.yellows - a.yellows);
        tiri.sort((a, b) => b.shotsOn - a.shotsOn);
        marcatori.sort((a, b) => b.goals - a.goals);

        matches.push({
          id: String(fixtureId),
          league: leagueName,
          home: homeTeam.name,
          away: awayTeam.name,
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
          playerStats: {
            ammoniti: ammoniti.slice(0, 4),
            tiri: tiri.slice(0, 4),
            marcatori: marcatori.slice(0, 4)
          }
        });
      }
    }

    const payload = { generatedAt: new Date().toISOString(), matches };

    if (!fs.existsSync('./data')) {
      fs.mkdirSync('./data');
    }

    fs.writeFileSync('./data/fixtures.json', JSON.stringify(payload, null, 2));
    console.log(`✅ File fixtures.json generato con pronostici giocatori! Partite: ${matches.length}`);
  } catch (error) {
    console.error("❌ Errore:", error);
    process.exit(1);
  }
}
