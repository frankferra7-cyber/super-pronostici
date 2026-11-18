async function generateFixturesFile() {
  try {
    console.log("🔄 Connessione ad API-Football per i prossimi 7 giorni...");
    
    const todayObj = new Date();
    const futureObj = new Date();
    futureObj.setDate(todayObj.getDate() + 7);

    const today = todayObj.toISOString().split('T')[0];
    const futureDate = futureObj.toISOString().split('T')[0];

    console.log(`📅 Cerco partite in programma da ${today} a ${futureDate}`);
    
    // Intervallo di 7 giorni nel futuro per i campionati selezionati
    const fixturesRaw = await callApi(`/fixtures?from=${today}&to=${futureDate}`);
    const matches = [];

    if (!fixturesRaw || fixturesRaw.length === 0) {
      console.log("⚠️ Nessuna partita trovata nei prossimi 7 giorni.");
    }

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
    console.log(`✅ File fixtures.json generato con successo! Totale partite: ${matches.length}`);
  } catch (error) {
    console.error("❌ Errore:", error);
    process.exit(1);
  }
}
