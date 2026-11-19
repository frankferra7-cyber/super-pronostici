import https from 'https';

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ODDS_API_KEY = (process.env.ODDS_API_KEY || '').trim(); // Opzionale (The Odds API)

if (!FOOTBALL_DATA_KEY) throw new Error("Missing FOOTBALL_DATA_KEY secret");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL secret");
if (!SUPABASE_SECRET_KEY) throw new Error("Missing SUPABASE_SECRET_KEY secret");

const COMPETITIONS = [
  { name: 'Serie A', code: 'SA', oddsKey: 'soccer_italy_serie_a' },
  { name: 'Premier League', code: 'PL', oddsKey: 'soccer_epl' },
  { name: 'La Liga', code: 'PD', oddsKey: 'soccer_spain_la_liga' },
  { name: 'Bundesliga', code: 'BL1', oddsKey: 'soccer_germany_bundesliga' },
  { name: 'Ligue 1', code: 'FL1', oddsKey: 'soccer_france_ligue_one' },
  { name: 'Champions League', code: 'CL', oddsKey: 'soccer_uefa_champs_league' }
];

const squadCache = new Map();

function httpGetJson(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const options = {
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          reject(new Error(`Risposta non JSON (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function fetchFootballData(path) {
  return httpGetJson(`https://api.football-data.org${path}`, {
    'X-Auth-Token': FOOTBALL_DATA_KEY.trim()
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeTeamKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|ac|as|ss|us|sc|afc|bc|cfc|calcio|1907|1909|1913|united|city)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Carica classifica (TOTAL, HOME, AWAY) e forma recente (ultime 5 FINISHED)
 */
async function buildLeagueAnalytics(compCode) {
  const analytics = {
    avgHomeGoals: 1.48,
    avgAwayGoals: 1.18,
    teams: new Map() // teamId -> stats
  };

  // 1. Classifica
  const standRes = await fetchFootballData(`/v4/competitions/${compCode}/standings`);
  await sleep(6500);

  if (standRes.status === 200 && Array.isArray(standRes.body?.standings)) {
    const totalTable = standRes.body.standings.find(s => s.type === 'TOTAL')?.table || [];
    const homeTable = standRes.body.standings.find(s => s.type === 'HOME')?.table || [];
    const awayTable = standRes.body.standings.find(s => s.type === 'AWAY')?.table || [];

    let totalHomeGoals = 0;
    let totalHomeGames = 0;
    let totalAwayGoals = 0;
    let totalAwayGames = 0;

    for (const row of homeTable) {
      totalHomeGoals += Number(row.goalsFor || 0);
      totalHomeGames += Number(row.playedGames || 0);
    }
    for (const row of awayTable) {
      totalAwayGoals += Number(row.goalsFor || 0);
      totalAwayGames += Number(row.playedGames || 0);
    }

    if (totalHomeGames >= 10) analytics.avgHomeGoals = Math.max(0.8, totalHomeGoals / totalHomeGames);
    if (totalAwayGames >= 10) analytics.avgAwayGoals = Math.max(0.7, totalAwayGoals / totalAwayGames);

    const homeById = new Map(homeTable.map(r => [r.team?.id, r]));
    const awayById = new Map(awayTable.map(r => [r.team?.id, r]));

    for (const row of totalTable) {
      const id = row.team?.id;
      if (!id) continue;
      const hRow = homeById.get(id) || row;
      const aRow = awayById.get(id) || row;

      const tGames = Math.max(1, Number(row.playedGames || 1));
      const hGames = Math.max(1, Number(hRow.playedGames || tGames));
      const aGames = Math.max(1, Number(aRow.playedGames || tGames));

      analytics.teams.set(id, {
        position: Number(row.position || 10),
        pointsPerGame: Number(row.points || 0) / tGames,
        homeGfPg: Number(hRow.goalsFor || 0) / hGames,
        homeGaPg: Number(hRow.goalsAgainst || 0) / hGames,
        awayGfPg: Number(aRow.goalsFor || 0) / aGames,
        awayGaPg: Number(aRow.goalsAgainst || 0) / aGames,
        recentFormRatio: 0.5,
        recentGfPg: null,
        recentGaPg: null
      });
    }
  }

  // 2. Ultime partite concluse per forma recente (ultime 5 gare per squadra)
  const finRes = await fetchFootballData(`/v4/competitions/${compCode}/matches?status=FINISHED`);
  await sleep(6500);

  if (finRes.status === 200 && Array.isArray(finRes.body?.matches)) {
    const finished = finRes.body.matches
      .filter(m => m.score?.fullTime?.home != null && m.score?.fullTime?.away != null)
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));

    const recentByTeam = new Map();
    for (const m of finished) {
      const hId = m.homeTeam?.id;
      const aId = m.awayTeam?.id;
      const hGoals = Number(m.score.fullTime.home);
      const aGoals = Number(m.score.fullTime.away);

      if (hId) {
        const list = recentByTeam.get(hId) || [];
        if (list.length < 5) {
          list.push({ pts: hGoals > aGoals ? 3 : (hGoals === aGoals ? 1 : 0), gf: hGoals, ga: aGoals });
          recentByTeam.set(hId, list);
        }
      }
      if (aId) {
        const list = recentByTeam.get(aId) || [];
        if (list.length < 5) {
          list.push({ pts: aGoals > hGoals ? 3 : (aGoals === hGoals ? 1 : 0), gf: aGoals, ga: hGoals });
          recentByTeam.set(aId, list);
        }
      }
    }

    for (const [teamId, games] of recentByTeam.entries()) {
      if (!games.length) continue;
      const pts = games.reduce((s, g) => s + g.pts, 0);
      const gf = games.reduce((s, g) => s + g.gf, 0);
      const ga = games.reduce((s, g) => s + g.ga, 0);

      const existing = analytics.teams.get(teamId) || {
        position: 10,
        pointsPerGame: pts / games.length,
        homeGfPg: analytics.avgHomeGoals,
        homeGaPg: analytics.avgAwayGoals,
        awayGfPg: analytics.avgAwayGoals,
        awayGaPg: analytics.avgHomeGoals
      };

      existing.recentFormRatio = pts / (games.length * 3);
      existing.recentGfPg = gf / games.length;
      existing.recentGaPg = ga / games.length;
      analytics.teams.set(teamId, existing);
    }
  }

  return analytics;
}

/**
 * Quote reali opzionali da The Odds API (se ODDS_API_KEY è impostata)
 */
async function fetchMarketOddsMap(oddsSportKey) {
  const map = new Map();
  if (!ODDS_API_KEY || !oddsSportKey) return map;

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${oddsSportKey}/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=eu&markets=h2h,totals&oddsFormat=decimal`;
    const res = await httpGetJson(url);
    if (res.status !== 200 || !Array.isArray(res.body)) {
      console.log(`[Odds API ${oddsSportKey}] Status ${res.status}`);
      return map;
    }

    for (const ev of res.body) {
      const hKey = normalizeTeamKey(ev.home_team);
      const aKey = normalizeTeamKey(ev.away_team);
      if (!hKey || !aKey || !Array.isArray(ev.bookmakers)) continue;

      let sumH = 0, sumD = 0, sumA = 0, count1x2 = 0;
      let sumOver = 0, sumUnder = 0, countTot = 0;

      for (const bk of ev.bookmakers) {
        const h2h = bk.markets?.find(m => m.key === 'h2h');
        if (h2h && Array.isArray(h2h.outcomes)) {
          const oH = h2h.outcomes.find(o => normalizeTeamKey(o.name) === hKey)?.price;
          const oA = h2h.outcomes.find(o => normalizeTeamKey(o.name) === aKey)?.price;
          const oD = h2h.outcomes.find(o => String(o.name).toLowerCase() === 'draw')?.price;
          if (oH > 1 && oD > 1 && oA > 1) {
            const invSum = (1 / oH) + (1 / oD) + (1 / oA);
            sumH += (1 / oH) / invSum;
            sumD += (1 / oD) / invSum;
            sumA += (1 / oA) / invSum;
            count1x2++;
          }
        }

        const totals = bk.markets?.find(m => m.key === 'totals');
        if (totals && Array.isArray(totals.outcomes)) {
          const over25 = totals.outcomes.find(o => o.name === 'Over' && Number(o.point) === 2.5)?.price;
          const under25 = totals.outcomes.find(o => o.name === 'Under' && Number(o.point) === 2.5)?.price;
          if (over25 > 1 && under25 > 1) {
            const invTot = (1 / over25) + (1 / under25);
            sumOver += (1 / over25) / invTot;
            sumUnder += (1 / under25) / invTot;
            countTot++;
          }
        }
      }

      if (count1x2 > 0) {
        map.set(`${hKey}|${aKey}`, {
          homeProb: sumH / count1x2,
          drawProb: sumD / count1x2,
          awayProb: sumA / count1x2,
          over25Prob: countTot > 0 ? (sumOver / countTot) : null
        });
      }
    }
  } catch (err) {
    console.log(`[Odds API ${oddsSportKey}] Errore:`, err.message);
  }

  return map;
}

function poissonPmf(k, lambda) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

function computeMatchPrediction(homeId, awayId, homeName, awayName, analytics, marketOddsMap, fallbackSeed) {
  const hStats = analytics.teams.get(homeId);
  const aStats = analytics.teams.get(awayId);

  const avgH = analytics.avgHomeGoals;
  const avgA = analytics.avgAwayGoals;

  let lambdaHome;
  let lambdaAway;

  if (hStats && aStats) {
    const hAttack = hStats.homeGfPg / avgH;
    const aDefense = aStats.awayGaPg / avgH;
    const aAttack = aStats.awayGfPg / avgA;
    const hDefense = hStats.homeGaPg / avgA;

    // Media pesata tra rendimento stagionale e forma recente (ultime 5)
    const hRecentAttack = hStats.recentGfPg != null ? (hStats.recentGfPg / ((avgH + avgA) / 2)) : hAttack;
    const aRecentAttack = aStats.recentGfPg != null ? (aStats.recentGfPg / ((avgH + avgA) / 2)) : aAttack;

    const effHAttack = 0.72 * hAttack + 0.28 * hRecentAttack;
    const effAAttack = 0.72 * aAttack + 0.28 * aRecentAttack;

    // Aggiustamento leggero sulla forma recente (Punti ultime 5)
    const formDiff = (hStats.recentFormRatio - aStats.recentFormRatio) * 0.22;

    lambdaHome = Math.min(3.4, Math.max(0.45, effHAttack * aDefense * avgH * (1 + formDiff)));
    lambdaAway = Math.min(3.1, Math.max(0.35, effAAttack * hDefense * avgA * (1 - formDiff)));
  } else {
    // Fallback solo per coppe/squadre senza classifica (es. turni preliminari)
    lambdaHome = Number((1.15 + ((fallbackSeed % 11) / 10)).toFixed(2));
    lambdaAway = Number((0.95 + (((fallbackSeed >>> 4) % 10) / 10)).toFixed(2));
  }

  // Calcolo matrice Poisson (0..6 gol per squadra)
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let pOver25 = 0;
  let pBtts = 0;
  let bestScore = '1-0';
  let bestScoreProb = -1;

  for (let i = 0; i <= 6; i++) {
    const pi = poissonPmf(i, lambdaHome);
    for (let j = 0; j <= 6; j++) {
      const pj = poissonPmf(j, lambdaAway);
      const p = pi * pj;

      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;

      if (i + j >= 3) pOver25 += p;
      if (i >= 1 && j >= 1) pBtts += p;

      if (p > bestScoreProb) {
        bestScoreProb = p;
        bestScore = `${i}-${j}`;
      }
    }
  }

  // Normalizzazione somma 1X2
  const sum1x2 = pHome + pDraw + pAway || 1;
  pHome /= sum1x2;
  pDraw /= sum1x2;
  pAway /= sum1x2;

  // Blend con quote reali di mercato se disponibili (55% Mercato + 45% Modello Poisson)
  const marketKey = `${normalizeTeamKey(homeName)}|${normalizeTeamKey(awayName)}`;
  const market = marketOddsMap.get(marketKey);
  if (market) {
    pHome = 0.45 * pHome + 0.55 * market.homeProb;
    pDraw = 0.45 * pDraw + 0.55 * market.drawProb;
    pAway = 0.45 * pAway + 0.55 * market.awayProb;
    if (market.over25Prob != null) {
      pOver25 = 0.45 * pOver25 + 0.55 * market.over25Prob;
    }
  }

  const homePct = Math.max(4, Math.min(88, Math.round(pHome * 100)));
  const drawPct = Math.max(8, Math.min(45, Math.round(pDraw * 100)));
  const awayPct = Math.max(4, 100 - homePct - drawPct);

  const over25 = Math.max(15, Math.min(88, Math.round(pOver25 * 100)));
  const under25 = 100 - over25;
  const bothTeamsToScore = Math.max(15, Math.min(86, Math.round(pBtts * 100)));

  let mostLikelyOutcome = 'X';
  if (homePct >= awayPct && homePct >= drawPct) mostLikelyOutcome = '1';
  else if (awayPct > homePct && awayPct >= drawPct) mostLikelyOutcome = '2';

  return {
    oneXTwo: { home: homePct, draw: drawPct, away: awayPct },
    over25,
    under25,
    bothTeamsToScore,
    doubleChance: {
      '1X': Math.min(96, homePct + drawPct),
      'X2': Math.min(96, awayPct + drawPct),
      '12': Math.min(96, homePct + awayPct)
    },
    expectedGoals: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2))
    },
    mostLikelyOutcome,
    likelyScore: bestScore,
    source: market ? 'poisson+market' : 'poisson+standings'
  };
}

function isEligiblePlayer(player) {
  if (!player || !player.name) return false;
  const status = String(player.status || player.injuryStatus || '').toLowerCase();
  if (
    status.includes('injur') ||
    status.includes('suspend') ||
    status.includes('out') ||
    status.includes('doubt')
  ) {
    return false;
  }
  return true;
}

function filterLowMinutesPlayers(squad) {
  const withPositiveUsage = squad.filter(p =>
    (typeof p?.minutes === 'number' && p.minutes > 0) ||
    (typeof p?.playedMatches === 'number' && p.playedMatches > 0) ||
    (typeof p?.appearances === 'number' && p.appearances > 0)
  );

  if (withPositiveUsage.length < 15) return squad;

  const active = squad.filter(p => {
    if (typeof p?.minutes === 'number' && p.minutes < 180) return false;
    if (typeof p?.playedMatches === 'number' && p.playedMatches < 2) return false;
    if (typeof p?.appearances === 'number' && p.appearances < 2) return false;
    return true;
  });

  return active.length >= 14 ? active : squad;
}

async function getTeamSquad(teamId) {
  if (!teamId) return [];
  if (squadCache.has(teamId)) return squadCache.get(teamId);

  await sleep(6500);
  const res = await fetchFootballData(`/v4/teams/${teamId}`);
  if (res.status !== 200 || !Array.isArray(res.body?.squad)) {
    console.log(`[Team ${teamId}] Impossibile leggere la rosa (${res.status})`);
    squadCache.set(teamId, []);
    return [];
  }

  const eligible = res.body.squad.filter(isEligiblePlayer);
  const squad = filterLowMinutesPlayers(eligible);
  squadCache.set(teamId, squad);
  return squad;
}

function hashSeed(homeTeam, awayTeam, matchId) {
  const input = `${String(matchId ?? '')}|${String(homeTeam ?? '')}|${String(awayTeam ?? '')}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function normalizeStartXI(rawPlayers) {
  if (!Array.isArray(rawPlayers)) return [];
  return rawPlayers
    .map((p, idx) => {
      const name = p?.name || p?.player?.name;
      if (!name) return null;
      return {
        pos: p?.position || p?.pos || 'P',
        name,
        number: p?.shirtNumber ?? p?.number ?? (idx + 1)
      };
    })
    .filter(Boolean);
}

function buildProbableEleven(squad, teamName, formation, seed) {
  const getByRole = (roles, count, offset) => {
    const matching = squad.filter(p =>
      roles.some(r => String(p.position || '').toLowerCase().includes(r))
    );
    const pool = matching.length ? matching : squad;
    if (!pool.length) {
      return Array.from({ length: count }, (_, i) => ({
        name: `${teamName} #${offset + i + 1}`,
        position: roles[0].toUpperCase(),
        shirtNumber: offset + i + 1
      }));
    }

    const picked = [];
    for (let i = 0; i < count; i++) {
      const candidate = pool[(seed + offset + i * 2) % pool.length];
      if (!picked.some(x => x.name === candidate.name)) {
        picked.push(candidate);
      }
    }

    let idx = 0;
    while (picked.length < count && idx < pool.length) {
      if (!picked.some(x => x.name === pool[idx].name)) {
        picked.push(pool[idx]);
      }
      idx++;
    }

    return picked;
  };

  const is352 = formation === '3-5-2';
  const gk = getByRole(['goalkeeper'], 1, 1);
  const def = getByRole(['defence', 'defender'], is352 ? 3 : 4, 2);
  const mid = getByRole(['midfield', 'midfielder'], is352 ? 5 : 3, 6);
  const att = getByRole(['offence', 'forward', 'attacker', 'winger'], is352 ? 2 : 3, 9);

  return [
    ...gk.map((p, i) => ({ pos: 'POR', name: p.name, number: p.shirtNumber || (i + 1) })),
    ...def.map((p, i) => ({ pos: 'DIF', name: p.name, number: p.shirtNumber || (i + 2) })),
    ...mid.map((p, i) => ({ pos: 'CEN', name: p.name, number: p.shirtNumber || (i + 6) })),
    ...att.map((p, i) => ({ pos: 'ATT', name: p.name, number: p.shirtNumber || (i + 9) }))
  ];
}

function resolveLineups(matchObj, homeTeam, awayTeam, homeSquad, awaySquad, seed) {
  const rawHomeXI = matchObj?.homeTeam?.lineup || matchObj?.lineups?.home?.startXI || [];
  const rawAwayXI = matchObj?.awayTeam?.lineup || matchObj?.lineups?.away?.startXI || [];

  const homeXI = normalizeStartXI(rawHomeXI);
  const awayXI = normalizeStartXI(rawAwayXI);

  const hasOfficial = homeXI.length >= 7 && awayXI.length >= 7;

  if (hasOfficial) {
    return {
      isOfficial: true,
      homePlayers: homeXI.map(p => ({ name: p.name, position: p.pos })),
      awayPlayers: awayXI.map(p => ({ name: p.name, position: p.pos })),
      lineups: {
        home: {
          teamName: homeTeam,
          formation: matchObj?.homeTeam?.formation || ((seed % 2) === 0 ? '4-3-3' : '3-5-2'),
          isOfficial: true,
          startXI: homeXI
        },
        away: {
          teamName: awayTeam,
          formation: matchObj?.awayTeam?.formation || (((seed >>> 1) % 2) === 0 ? '4-2-3-1' : '4-4-2'),
          isOfficial: true,
          startXI: awayXI
        }
      }
    };
  }

  const homeFormation = (seed % 2) === 0 ? '4-3-3' : '3-5-2';
  const awayFormation = ((seed >>> 1) % 2) === 0 ? '4-3-3' : '3-5-2';

  const probHomeXI = buildProbableEleven(homeSquad, homeTeam, homeFormation, seed);
  const probAwayXI = buildProbableEleven(awaySquad, awayTeam, awayFormation, seed + 13);

  const mapPos = (pos) =>
    pos === 'ATT' ? 'offence' :
    pos === 'CEN' ? 'midfield' :
    pos === 'DIF' ? 'defence' : 'goalkeeper';

  return {
    isOfficial: false,
    homePlayers: probHomeXI.map(p => ({ name: p.name, position: mapPos(p.pos) })),
    awayPlayers: probAwayXI.map(p => ({ name: p.name, position: mapPos(p.pos) })),
    lineups: {
      home: {
        teamName: homeTeam,
        formation: homeFormation,
        isOfficial: false,
        startXI: probHomeXI
      },
      away: {
        teamName: awayTeam,
        formation: awayFormation,
        isOfficial: false,
        startXI: probAwayXI
      }
    }
  };
}

function pickPlayersByRole(poolSource, teamName, roles, count, seedOffset = 0) {
  const normalizedRoles = roles.map(r => r.toLowerCase());
  const matching = poolSource.filter(p => {
    const pos = String(p.position || '').toLowerCase();
    return normalizedRoles.some(role => pos.includes(role));
  });

  const pool = matching.length >= count ? matching : (poolSource.length ? poolSource : []);
  if (!pool.length) {
    return Array.from({ length: count }, (_, idx) => `${teamName} - Giocatore ${idx + 1}`);
  }

  const picked = [];
  for (let i = 0; i < count; i++) {
    const player = pool[(seedOffset + i * 3) % pool.length];
    if (player?.name && !picked.includes(player.name)) {
      picked.push(player.name);
    }
  }

  let extraIdx = 0;
  while (picked.length < count && extraIdx < pool.length) {
    const candidate = pool[(seedOffset + extraIdx) % pool.length]?.name;
    if (candidate && !picked.includes(candidate)) picked.push(candidate);
    extraIdx++;
  }

  while (picked.length < count) {
    picked.push(`${teamName} - Giocatore ${picked.length + 1}`);
  }

  return picked;
}

function ensureNonEmptyPlayerList(list, fallbackTeam, fallbackNames, seed) {
  const valid = Array.isArray(list)
    ? list.filter(item => item && typeof item.name === 'string' && item.name.trim().length > 0 && item.team && item.prob)
    : [];

  if (valid.length > 0) return valid;

  return fallbackNames.map((name, idx) => ({
    name: name || `${fallbackTeam} - Giocatore ${idx + 1}`,
    team: fallbackTeam,
    prob: `${25 + ((seed + idx * 7) % 30)}%`
  }));
}

function buildTabData(matchObj, homeTeam, awayTeam, homeId, awayId, homeSquad, awaySquad, analytics, marketOddsMap, matchId) {
  const h = hashSeed(homeTeam, awayTeam, matchId);

  const prediction = computeMatchPrediction(
    homeId,
    awayId,
    homeTeam,
    awayTeam,
    analytics,
    marketOddsMap,
    h
  );

  const lineupInfo = resolveLineups(matchObj, homeTeam, awayTeam, homeSquad, awaySquad, h);
  const homePool = lineupInfo.homePlayers.length ? lineupInfo.homePlayers : homeSquad;
  const awayPool = lineupInfo.awayPlayers.length ? lineupInfo.awayPlayers : awaySquad;

  const homeAttackers = pickPlayersByRole(homePool, homeTeam, ['offence', 'forward', 'attacker', 'winger', 'att', 'fwd'], 2, h % 97);
  const awayAttackers = pickPlayersByRole(awayPool, awayTeam, ['offence', 'forward', 'attacker', 'winger', 'att', 'fwd'], 2, (h >>> 4) % 97);
  const homeCardCandidates = pickPlayersByRole(homePool, homeTeam, ['midfield', 'defence', 'defender', 'midfielder', 'mid', 'def'], 2, (h >>> 8) % 97);
  const awayCardCandidates = pickPlayersByRole(awayPool, awayTeam, ['midfield', 'defence', 'defender', 'midfielder', 'mid', 'def'], 2, (h >>> 12) % 97);

  // Probabilità marcatori/tiri coerenti con i gol attesi (expectedGoals) del match
  const homeGoalFactor = Math.min(22, Math.round(prediction.expectedGoals.home * 11));
  const awayGoalFactor = Math.min(22, Math.round(prediction.expectedGoals.away * 11));
  const bonusOfficial = lineupInfo.isOfficial ? 4 : 0;

  const rawMarcatori = [
    { name: homeAttackers[0], team: homeTeam, prob: `${Math.min(72, 18 + homeGoalFactor + (h % 14) + bonusOfficial)}%` },
    { name: homeAttackers[1] || homeAttackers[0], team: homeTeam, prob: `${Math.min(62, 12 + Math.round(homeGoalFactor * 0.75) + ((h >>> 3) % 12) + bonusOfficial)}%` },
    { name: awayAttackers[0], team: awayTeam, prob: `${Math.min(70, 16 + awayGoalFactor + ((h >>> 6) % 14) + bonusOfficial)}%` }
  ];

  const rawAmmoniti = [
    { name: homeCardCandidates[0], team: homeTeam, prob: `${Math.min(65, 20 + ((h >>> 9) % 24) + bonusOfficial)}%` },
    { name: awayCardCandidates[0], team: awayTeam, prob: `${Math.min(65, 20 + ((h >>> 13) % 24) + bonusOfficial)}%` }
  ];

  const rawTiri = [
    { name: homeAttackers[0], team: homeTeam, prob: `${Math.min(92, 46 + homeGoalFactor + ((h >>> 2) % 18) + bonusOfficial)}%` },
    { name: awayAttackers[0], team: awayTeam, prob: `${Math.min(90, 44 + awayGoalFactor + ((h >>> 10) % 18) + bonusOfficial)}%` }
  ];

  const player_stats = {
    marcatori: ensureNonEmptyPlayerList(rawMarcatori, homeTeam, [homeAttackers[0], awayAttackers[0]], h),
    ammoniti: ensureNonEmptyPlayerList(rawAmmoniti, homeTeam, [homeCardCandidates[0], awayCardCandidates[0]], h + 19),
    tiri: ensureNonEmptyPlayerList(rawTiri, homeTeam, [homeAttackers[0], awayAttackers[0]], h + 37)
  };

  return {
    prediction,
    player_stats,
    lineups: lineupInfo.lineups,
    isOfficial: lineupInfo.isOfficial
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

async function run() {
  const now = new Date();
  const future = new Date(now);
  future.setDate(now.getDate() + 7);

  const dateFrom = now.toISOString().split('T')[0];
  const dateTo = future.toISOString().split('T')[0];

  const allMatches = [];
  let officialCount = 0;

  for (const comp of COMPETITIONS) {
    const res = await fetchFootballData(
      `/v4/competitions/${comp.code}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );

    if (res.status !== 200 || !Array.isArray(res.body?.matches)) {
      console.log(`[${comp.name}] Risposta API ${res.status}:`, JSON.stringify(res.body?.message || res.body || {}));
      await sleep(6500);
      continue;
    }

    const matches = res.body.matches;
    console.log(`[${comp.name}] Partite trovate: ${matches.length}`);

    if (matches.length === 0) {
      await sleep(6500);
      continue;
    }

    // Carica classifica + ultimi risultati reali + eventuali quote di mercato per questo campionato
    const analytics = await buildLeagueAnalytics(comp.code);
    const marketOddsMap = await fetchMarketOddsMap(comp.oddsKey);

    for (const m of matches) {
      const homeName = m.homeTeam?.shortName || m.homeTeam?.name;
      const awayName = m.awayTeam?.shortName || m.awayTeam?.name;
      const homeId = m.homeTeam?.id;
      const awayId = m.awayTeam?.id;
      if (!m.id || !homeName || !awayName || !m.utcDate) continue;

      const hasOfficialPreview =
        Array.isArray(m.homeTeam?.lineup) && m.homeTeam.lineup.length >= 7 &&
        Array.isArray(m.awayTeam?.lineup) && m.awayTeam.lineup.length >= 7;

      const homeSquad = hasOfficialPreview ? [] : await getTeamSquad(homeId);
      const awaySquad = hasOfficialPreview ? [] : await getTeamSquad(awayId);
      const tabData = buildTabData(
        m,
        homeName,
        awayName,
        homeId,
        awayId,
        homeSquad,
        awaySquad,
        analytics,
        marketOddsMap,
        m.id
      );

      if (tabData.isOfficial) officialCount++;

      allMatches.push({
        id: String(m.id),
        league: comp.name,
        home: homeName,
        away: awayName,
        kickoff: m.utcDate,
        prediction: tabData.prediction,
        player_stats: tabData.player_stats,
        lineups: tabData.lineups,
        updated_at: new Date().toISOString()
      });
    }

    await sleep(6500);
  }

  if (allMatches.length === 0) {
    console.log("Nessuna partita trovata nella finestra di 7 giorni.");
    return;
  }

  console.log(`Partite con formazioni ufficiali: ${officialCount}/${allMatches.length}`);
  console.log(`Salvataggio di ${allMatches.length} partite su Supabase...`);
  await upsertToSupabase(allMatches);
  console.log("Sincronizzazione completata.");
}

run().catch(err => {
  console.error("Errore:", err);
  process.exit(1);
});
