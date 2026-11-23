import https from 'https';

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ODDS_API_KEY = (process.env.ODDS_API_KEY || '').trim();
const API_FOOTBALL_KEY = (process.env.API_FOOTBALL_KEY || '').trim();

if (!FOOTBALL_DATA_KEY) throw new Error("Missing FOOTBALL_DATA_KEY secret");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL secret");
if (!SUPABASE_SECRET_KEY) throw new Error("Missing SUPABASE_SECRET_KEY secret");

const COMPETITIONS = [
  { name: 'Serie A', code: 'SA', oddsKey: 'soccer_italy_serie_a', apiFootballLeagueId: 135 },
  { name: 'Premier League', code: 'PL', oddsKey: 'soccer_epl', apiFootballLeagueId: 39 },
  { name: 'La Liga', code: 'PD', oddsKey: 'soccer_spain_la_liga', apiFootballLeagueId: 140 },
  { name: 'Bundesliga', code: 'BL1', oddsKey: 'soccer_germany_bundesliga', apiFootballLeagueId: 78 },
  { name: 'Ligue 1', code: 'FL1', oddsKey: 'soccer_france_ligue_one', apiFootballLeagueId: 61 },
  { name: 'Champions League', code: 'CL', oddsKey: 'soccer_uefa_champs_league', apiFootballLeagueId: 2 }
];

const REQUEST_SPACING_MS = 6500;
const RATE_LIMIT_WAIT_MS = 65000;
const OFFICIAL_LINEUP_WINDOW_MINUTES = 120;

const squadCache = new Map();
const apiFootballFixturesCache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function fetchFootballData(path, retryCount = 0) {
  const res = await httpGetJson(`https://api.football-data.org${path}`, {
    'X-Auth-Token': FOOTBALL_DATA_KEY.trim()
  });

  if (res.status === 429 && retryCount < 2) {
    console.log(`[Rate Limit 429] Attendo ${RATE_LIMIT_WAIT_MS / 1000}s prima di riprovare ${path}...`);
    await sleep(RATE_LIMIT_WAIT_MS);
    return fetchFootballData(path, retryCount + 1);
  }

  return res;
}

function normalizeTeamKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|ac|as|ss|us|sc|afc|bc|cfc|calcio|1907|1909|1913|united|city)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function normalizeRoleTag(rawPos) {
  const pos = String(rawPos || '').trim().toLowerCase();
  if (!pos) return 'midfield';

  if (pos === 'por' || pos === 'gk' || pos.includes('goal')) return 'goalkeeper';
  if (pos === 'dif' || pos.includes('def') || pos.includes('back')) return 'defence';
  if (
    pos === 'att' ||
    pos.includes('off') ||
    pos.includes('forw') ||
    pos.includes('attac') ||
    pos.includes('wing') ||
    pos.includes('strik')
  ) {
    return 'offence';
  }
  if (pos === 'cen' || pos.includes('mid')) return 'midfield';

  return pos;
}

function getApiFootballSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? year : year - 1;
}

function isMatchWithinLineupWindow(kickoffIso) {
  const kickoffMs = new Date(kickoffIso).getTime();
  if (Number.isNaN(kickoffMs)) return false;
  const diffMinutes = (kickoffMs - Date.now()) / 60000;
  return diffMinutes <= OFFICIAL_LINEUP_WINDOW_MINUTES && diffMinutes >= -120;
}

async function getApiFootballFixtureMap(leagueId, dateStr) {
  if (!API_FOOTBALL_KEY || !leagueId) return new Map();
  const cacheKey = `${leagueId}|${dateStr}`;
  if (apiFootballFixturesCache.has(cacheKey)) {
    return apiFootballFixturesCache.get(cacheKey);
  }

  const map = new Map();
  try {
    const season = getApiFootballSeason();
    const url = `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${season}&date=${encodeURIComponent(dateStr)}`;
    const res = await httpGetJson(url, {
      'x-apisports-key': API_FOOTBALL_KEY
    });

    if (res.status === 200 && Array.isArray(res.body?.response)) {
      for (const item of res.body.response) {
        const fixtureId = item?.fixture?.id;
        const hKey = normalizeTeamKey(item?.teams?.home?.name);
        const aKey = normalizeTeamKey(item?.teams?.away?.name);
        if (fixtureId && hKey && aKey) {
          map.set(`${hKey}|${aKey}`, fixtureId);
        }
      }
    }
  } catch (err) {
    console.log(`[API-Football fixtures ${leagueId}] Errore:`, err.message);
  }

  apiFootballFixturesCache.set(cacheKey, map);
  return map;
}

async function fetchApiFootballOfficialLineups(matchObj, comp, homeName, awayName) {
  if (!API_FOOTBALL_KEY || !comp?.apiFootballLeagueId || !matchObj?.utcDate) {
    return null;
  }
  if (!isMatchWithinLineupWindow(matchObj.utcDate)) {
    return null;
  }

  try {
    const dateStr = new Date(matchObj.utcDate).toISOString().split('T')[0];
    const fixtureMap = await getApiFootballFixtureMap(comp.apiFootballLeagueId, dateStr);
    const key = `${normalizeTeamKey(homeName)}|${normalizeTeamKey(awayName)}`;
    const fixtureId = fixtureMap.get(key);
    if (!fixtureId) return null;

    const url = `https://v3.football.api-sports.io/fixtures/lineups?fixture=${fixtureId}`;
    const res = await httpGetJson(url, {
      'x-apisports-key': API_FOOTBALL_KEY
    });

    if (res.status !== 200 || !Array.isArray(res.body?.response) || res.body.response.length < 2) {
      return null;
    }

    const homeEntry =
      res.body.response.find(r => normalizeTeamKey(r?.team?.name) === normalizeTeamKey(homeName)) ||
      res.body.response[0];
    const awayEntry =
      res.body.response.find(r => normalizeTeamKey(r?.team?.name) === normalizeTeamKey(awayName)) ||
      res.body.response[1];

    const homeStartXI = Array.isArray(homeEntry?.startXI) ? homeEntry.startXI : [];
    const awayStartXI = Array.isArray(awayEntry?.startXI) ? awayEntry.startXI : [];

    if (homeStartXI.length < 7 || awayStartXI.length < 7) {
      return null;
    }

    return {
      home: {
        formation: homeEntry?.formation || '4-3-3',
        startXI: homeStartXI.map((entry, idx) => ({
          pos: entry?.player?.pos || 'CEN',
          name: entry?.player?.name || `${homeName} #${idx + 1}`,
          number: entry?.player?.number ?? (idx + 1)
        }))
      },
      away: {
        formation: awayEntry?.formation || '4-3-3',
        startXI: awayStartXI.map((entry, idx) => ({
          pos: entry?.player?.pos || 'CEN',
          name: entry?.player?.name || `${awayName} #${idx + 1}`,
          number: entry?.player?.number ?? (idx + 1)
        }))
      }
    };
  } catch (err) {
    console.log(`[API-Football lineups ${homeName} vs ${awayName}] Errore:`, err.message);
    return null;
  }
}

async function buildLeagueAnalytics(compCode) {
  const analytics = {
    avgHomeGoals: 1.48,
    avgAwayGoals: 1.18,
    teams: new Map()
  };

  const standRes = await fetchFootballData(`/v4/competitions/${compCode}/standings`);
  await sleep(REQUEST_SPACING_MS);

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

  const finRes = await fetchFootballData(`/v4/competitions/${compCode}/matches?status=FINISHED`);
  await sleep(REQUEST_SPACING_MS);

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

    const hRecentAttack = hStats.recentGfPg != null ? (hStats.recentGfPg / ((avgH + avgA) / 2)) : hAttack;
    const aRecentAttack = aStats.recentGfPg != null ? (aStats.recentGfPg / ((avgH + avgA) / 2)) : aAttack;

    const effHAttack = 0.72 * hAttack + 0.28 * hRecentAttack;
    const effAAttack = 0.72 * aAttack + 0.28 * aRecentAttack;

    const formDiff = (hStats.recentFormRatio - aStats.recentFormRatio) * 0.22;

    lambdaHome = Math.min(3.4, Math.max(0.45, effHAttack * aDefense * avgH * (1 + formDiff)));
    lambdaAway = Math.min(3.1, Math.max(0.35, effAAttack * hDefense * avgA * (1 - formDiff)));
  } else {
    lambdaHome = Number((1.15 + ((fallbackSeed % 11) / 10)).toFixed(2));
    lambdaAway = Number((0.95 + (((fallbackSeed >>> 4) % 10) / 10)).toFixed(2));
  }

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

  const sum1x2 = pHome + pDraw + pAway || 1;
  pHome /= sum1x2;
  pDraw /= sum1x2;
  pAway /= sum1x2;

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

  await sleep(REQUEST_SPACING_MS);
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
  return Math
