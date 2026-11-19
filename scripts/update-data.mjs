import https from 'https';

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!FOOTBALL_DATA_KEY) throw new Error("Missing FOOTBALL_DATA_KEY secret");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL secret");
if (!SUPABASE_SECRET_KEY) throw new Error("Missing SUPABASE_SECRET_KEY secret");

const COMPETITIONS = [
  { name: 'Serie A', code: 'SA' },
  { name: 'Premier League', code: 'PL' },
  { name: 'La Liga', code: 'PD' },
  { name: 'Bundesliga', code: 'BL1' },
  { name: 'Ligue 1', code: 'FL1' },
  { name: 'Champions League', code: 'CL' }
];

const squadCache = new Map();

function fetchFootballData(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.football-data.org',
      path,
      method: 'GET',
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_KEY.trim()
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (err) {
          reject(new Error(`Risposta non JSON (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // Applica il filtro solo se c'è una base solida di dati d'impiego
  if (withPositiveUsage.length < 15) {
    return squad;
  }

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
  if (squadCache.has(teamId)) {
    return squadCache.get(teamId);
  }

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

  const is352 = formation === "3-5-2";
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
          formation: matchObj?.homeTeam?.formation || ((seed % 2) === 0 ? "4-3-3" : "3-5-2"),
          isOfficial: true,
          startXI: homeXI
        },
        away: {
          teamName: awayTeam,
          formation: matchObj?.awayTeam?.formation || (((seed >>> 1) % 2) === 0 ? "4-2-3-1" : "4-4-2"),
          isOfficial: true,
          startXI: awayXI
        }
      }
    };
  }

  const homeFormation = (seed % 2) === 0 ? "4-3-3" : "3-5-2";
  const awayFormation = ((seed >>> 1) % 2) === 0 ? "4-3-3" : "3-5-2";

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

function buildTabData(matchObj, homeTeam, awayTeam, homeSquad, awaySquad, matchId) {
  const h = hashSeed(homeTeam, awayTeam, matchId);

  const homeWeight = 22 + (h % 51);
  const awayWeight = 18 + ((h >>> 8) % 47);
  const drawWeight = 14 + ((h >>> 16) % 21);

  const sum = homeWeight + awayWeight + drawWeight;
  const homePct = Math.round((homeWeight / sum) * 100);
  const drawPct = Math.round((drawWeight / sum) * 100);
  const awayPct = Math.max(1, 100 - homePct - drawPct);
  const diff = 100 - (homePct + drawPct + awayPct);
  const finalHome = homePct + diff;

  const over25 = 38 + ((h >>> 5) % 41);
  const under25 = 100 - over25;
  const bothTeamsToScore = 36 + ((h >>> 11) % 43);

  const expHome = Number((0.7 + ((h % 19) / 10)).toFixed(1));
  const expAway = Number((0.6 + (((h >>> 7) % 18) / 10)).toFixed(1));

  let mostLikelyOutcome = "X";
  if (finalHome >= awayPct && finalHome >= drawPct) mostLikelyOutcome = "1";
  else if (awayPct > finalHome && awayPct >= drawPct) mostLikelyOutcome = "2";

  const likelyScore =
    mostLikelyOutcome === "1"
      ? (over25 >= 55 ? "2-1" : "1-0")
      : mostLikelyOutcome === "2"
      ? (over25 >= 55 ? "1-2" : "0-1")
      : (over25 >= 55 ? "2-2" : "1-1");

  const
