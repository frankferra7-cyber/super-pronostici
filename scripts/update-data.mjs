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

const SQUAD_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 ore di cache su Supabase
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

function supabaseRequest(method, pathWithQuery, payload = null) {
  return new Promise((resolve, reject) => {
    const baseUrl = new URL(SUPABASE_URL);
    const fullPath = `${baseUrl.pathname.replace(/\/$/, '')}${pathWithQuery}`;
    const body = payload ? JSON.stringify(payload) : null;

    const options = {
      hostname: baseUrl.hostname,
      path: fullPath,
      method,
      headers: {
        'apikey': SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Prefer': 'resolution=merge-duplicates' } : {})
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(responseData ? JSON.parse(responseData) : null);
          } catch {
            resolve(null);
          }
        } else {
          reject(new Error(`Errore Supabase (${res.statusCode}): ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchExistingMatchesMap(dateFromIso, dateToIso) {
  try {
    const query = `/rest/v1/matches?select=id,kickoff,prediction,player_stats,lineups,updated_at&kickoff=gte.${encodeURIComponent(dateFromIso)}&kickoff=lte.${encodeURIComponent(dateToIso)}`;
    const rows = await supabaseRequest('GET', query);
    const map = new Map();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row?.id != null) map.set(String(row.id), row);
      }
    }
    return map;
  } catch (err) {
    console.log("Avviso lettura match esistenti da Supabase:", err.message);
    return new Map();
  }
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

function sortSquadRealistically(squad) {
  return [...squad].sort((a, b) => {
    const numA = typeof a?.shirtNumber === 'number' ? a.shirtNumber : 99;
    const numB = typeof b?.shirtNumber === 'number' ? b.shirtNumber : 99;
    if (numA !== numB) return numA - numB;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
}

async function getTeamSquad(teamId, existingRow = null) {
  if (!teamId) return [];
  if (squadCache.has(teamId)) {
    return squadCache.get(teamId);
  }

  // Se il match su Supabase è già stato aggiornato di recente (meno di 12h) e ha una formazione, riusa i giocatori esistenti
  if (existingRow?.updated_at) {
    const ageMs = Date.now() - new Date(existingRow.updated_at).getTime();
    const cachedHomeXI = existingRow?.lineups?.home?.startXI;
    const cachedAwayXI = existingRow?.lineups?.away?.startXI;
    if (ageMs < SQUAD_CACHE_TTL_MS && Array.isArray(cachedHomeXI) && cachedHomeXI.length >= 11 && Array.isArray(cachedAwayXI) && cachedAwayXI.length >= 11) {
      return null; // Segnala che possiamo riusare la formazione già salvata
    }
  }

  await sleep(6500);
  const res = await fetchFootballData(`/v4/teams/${teamId}`);
  if (res.status !== 200 || !Array.isArray(res.body?.squad)) {
    console.log(`[Team ${teamId}] Impossibile leggere la rosa (${res.status})`);
    squadCache.set(teamId, []);
    return [];
  }

  const eligible = sortSquadRealistically(res.body.squad.filter(isEligiblePlayer));
  squadCache.set(teamId, eligible);
  return eligible;
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

// Selezione stabile per ruolo: mantiene i profili principali in ordine di maglia e ruota solo 1 posto di ballottaggio
function buildProbableEleven(squad, teamName, formation, seed) {
  const getByRole = (roles, count, rotationSlot) => {
    const matching = squad.filter(p =>
      roles.some(r => String(p.position || '').toLowerCase().includes(r))
    );
    const pool = matching.length ? matching : squad;
    if (!pool.length) {
      return Array.from({ length: count }, (_, i) => ({
        name: `${teamName} #${i + 1}`,
        position: roles[0].toUpperCase(),
        shirtNumber: i + 1
      }));
    }

    const baseSlice = pool.slice(0, Math.min(pool.length, count + 1));
    const picked = [];

    for (let i = 0; i < count; i++) {
      let candidate = baseSlice[i % baseSlice.length];
      // Solo sull'ultimo slot del reparto applichiamo una leggera rotazione tra i ballottaggi
      if (i === count - 1 && baseSlice.length > count) {
        candidate = baseSlice[(count - 1 + (seed % 2)) % baseSlice.length];
      }
      if (!picked.some(x => x.name === candidate.name)) {
        picked.push(candidate);
      }
    }

    let idx = 0;
    while (picked.length < count && idx < pool.length) {
      const candidate = pool[(idx + rotationSlot) % pool.length];
      if (!picked.some(x => x.name === candidate.name)) {
        picked.push(candidate);
      }
      idx++;
    }

    return picked;
  };

  const is352 = formation === "3-5-2";
  const gk = getByRole(['goalkeeper'], 1, 0);
  const def = getByRole(['defence', 'defender'], is352 ? 3 : 4, 1);
  const mid = getByRole(['midfield', 'midfielder'], is352 ? 5 : 3, 2);
  const att = getByRole(['offence', 'forward', 'attacker', 'winger'], is352 ? 2 : 3, 3);

  return [
    ...gk.map((p, i) => ({ pos: 'POR', name: p.name, number: p.shirtNumber || (i + 1) })),
    ...def.map((p, i) => ({ pos: 'DIF', name: p.name, number: p.shirtNumber || (i + 2) })),
    ...mid.map((p, i) => ({ pos: 'CEN', name: p.name, number: p.shirtNumber || (i + 6) })),
    ...att.map((p, i) => ({ pos: 'ATT', name: p.name, number: p.shirtNumber || (i + 9) }))
  ];
}

function resolveLineups(matchObj, homeTeam, awayTeam, homeSquad, awaySquad, existingRow, seed) {
  const alreadyOfficial =
    Boolean(existingRow?.lineups?.home?.isOfficial) &&
    Boolean(existingRow?.lineups?.away?.isOfficial) &&
    Array.isArray(existingRow?.lineups?.home?.startXI) &&
    existingRow.lineups.home.startXI.length >= 11 &&
    Array.isArray(existingRow?.lineups?.away?.startXI) &&
    existingRow.lineups.away.startXI.length >= 11;

  if (alreadyOfficial) {
    const mapPos = (pos) =>
      pos === 'ATT' ? 'offence' :
      pos === 'CEN' ? 'midfield' :
      pos === 'DIF' ? 'defence' : 'goalkeeper';

    return {
      isOfficial: true,
      homePlayers: existingRow.lineups.home.startXI.map(p => ({ name: p.name, position: mapPos(p.pos) })),
      awayPlayers: existingRow.lineups.away.startXI.map(p => ({ name: p.name, position: mapPos(p.pos) })),
      lineups: existingRow.lineups
    };
  }

  const rawHomeXI = matchObj?.homeTeam?.lineup || matchObj?.lineups?.home?.startXI || [];
  const rawAwayXI = matchObj?.awayTeam?.lineup || matchObj?.lineups?.away?.startXI || [];

  const homeXI = normalizeStartXI(rawHomeXI);
  const awayXI = normalizeStartXI(rawAwayXI);
  const hasOfficialNow = homeXI.length >= 7 && awayXI.length >= 7;

  if (hasOfficialNow) {
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

  // Se abbiamo già una probabile formazione valida in cache e nessuna nuova rosa scaricata, riusala
  if (homeSquad === null && awaySquad === null && existingRow?.lineups?.home?.startXI && existingRow?.lineups?.away?.startXI) {
    const mapPos = (pos) =>
      pos === 'ATT' ? 'offence' :
      pos === 'CEN' ? 'midfield' :
      pos === 'DIF' ? 'defence' : 'goalkeeper';

    return {
      isOfficial: false,
      homePlayers: existingRow.lineups.home.startXI.map(p => ({ name: p.name, position: mapPos(p.pos) })),
      awayPlayers: existingRow.lineups.away.startXI.map(p => ({ name: p.name, position: mapPos(p.pos) })),
      lineups: existingRow.lineups
    };
  }

  const safeHomeSquad = Array.isArray(homeSquad) ? homeSquad : [];
  const safeAwaySquad = Array.isArray(awaySquad) ? awaySquad : [];

  const homeFormation = (seed % 2) === 0 ? "4-3-3" : "3-5-2";
  const awayFormation = ((seed >>> 1) % 2) === 0 ? "4-3-3" : "3-5-2";

  const probHomeXI = buildProbableEleven(safeHomeSquad, homeTeam, homeFormation, seed);
  const probAwayXI = buildProbableEleven(safeAwaySquad, awayTeam, awayFormation, seed + 13);

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
    const player = pool[(seedOffset + i) % pool.length];
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

function buildTabData(matchObj, homeTeam, awayTeam, homeSquad, awaySquad, existingRow, matchId) {
  const h = hashSeed(homeTeam, awayTeam, matchId);
  const lineupInfo = resolveLineups(matchObj, homeTeam, awayTeam, homeSquad, awaySquad, existingRow, h);

  const officialShift = lineupInfo.isOfficial ? 3 : 0;
  const homeWeight = Math.min(82, 22 + (h % 51) + officialShift);
  const awayWeight = Math.min(80, 18 + ((h >>> 8) % 47) + officialShift);
  const drawWeight = 14 + ((h >>> 16) % 21);

  const sum = homeWeight + awayWeight + drawWeight;
  const homePct = Math.round((homeWeight / sum) * 100);
  const drawPct = Math.round((drawWeight / sum) * 100);
  const awayPct = Math.max(1, 100 - homePct - drawPct);
  const diff = 100 - (homePct + drawPct + awayPct);
  const finalHome = homePct + diff;

  const over25 = Math.min(88, 38 + ((h >>> 5) % 41) + (lineupInfo.isOfficial ? 2 : 0));
  const under25 = 100 - over25;
  const bothTeamsToScore = Math.min(88, 36 + ((h >>> 11) % 43) + (lineupInfo.isOfficial ? 2 : 0));

  const expHome = Number((0.7 + ((h % 19) / 10) + (lineupInfo.isOfficial ? 0.1 : 0)).toFixed(1));
  const expAway = Number((0.6 + (((h >>> 7) % 18) / 10) + (lineupInfo.isOfficial ? 0.1 : 0)).toFixed(1));

  let mostLikelyOutcome = "X";
  if (finalHome >= awayPct && finalHome >= drawPct) mostLikelyOutcome = "1";
  else if (awayPct > finalHome && awayPct >= drawPct) mostLikelyOutcome = "2";

  const likelyScore =
    mostLikelyOutcome === "1"
      ? (over25 >= 55 ? "2-1" : "1-0")
      : mostLikelyOutcome === "2"
      ? (over25 >= 55 ? "1-2" : "0-1")
      : (over25 >= 55 ? "2-2" : "1-1");

  const prediction = {
    oneXTwo: { home: finalHome, draw: drawPct, away: awayPct },
    over25,
    under25,
    bothTeamsToScore,
    doubleChance: {
      "1X": Math.min(99, finalHome + drawPct),
      "X2": Math.min(99, awayPct + drawPct),
      "12": Math.min(99, finalHome + awayPct)
    },
    expectedGoals: { home: expHome, away: expAway },
    mostLikelyOutcome,
    likelyScore
  };

  const homePool = lineupInfo.homePlayers.length ? lineupInfo.homePlayers : (Array.isArray(homeSquad) ? homeSquad : []);
  const awayPool = lineupInfo.awayPlayers.length ? lineupInfo.awayPlayers : (Array.isArray(awaySquad) ? awaySquad : []);

  const homeAttackers = pickPlayersByRole(homePool, homeTeam, ['offence', 'forward', 'attacker', 'winger', 'att', 'fwd'], 2, h % 97);
  const awayAttackers = pickPlayersByRole(awayPool, awayTeam, ['offence', 'forward', 'attacker', 'winger', 'att', 'fwd'], 2, (h >>> 4) % 97);
  const homeCardCandidates = pickPlayersByRole(homePool, homeTeam, ['midfield', 'defence', 'defender', 'midfielder', 'mid', 'def'], 2, (h >>> 8) % 97);
  const awayCardCandidates = pickPlayersByRole(awayPool, awayTeam, ['midfield', 'defence', 'defender', 'midfielder', 'mid', 'def'], 2, (h >>> 12) % 97);

  const bonusOfficial = lineupInfo.isOfficial ? 5 : 0;

  const rawMarcatori = [
    { name: homeAttackers[0], team: homeTeam, prob: `${Math.min(95, 22 + (h % 34) + bonusOfficial)}%` },
    { name: homeAttackers[1] || homeAttackers[0], team: homeTeam, prob: `${Math.min(95, 15 + ((h >>> 3) % 26) + bonusOfficial)}%` },
    { name: awayAttackers[0], team: awayTeam, prob: `${Math.min(95, 20 + ((h >>> 6) % 33) + bonusOfficial)}%` }
  ];

  const rawAmmoniti = [
    { name: homeCardCandidates[0], team: homeTeam, prob: `${Math.min(95, 18 + ((h >>> 9) % 28) + bonusOfficial)}%` },
    { name: awayCardCandidates[0], team: awayTeam, prob: `${Math.min(95, 17 + ((h >>> 13) % 28) + bonusOfficial)}%` }
  ];

  const rawTiri = [
    { name: homeAttackers[0], team: homeTeam, prob: `${Math.min(98, 52 + ((h >>> 2) % 36) + bonusOfficial)}%` },
    { name: awayAttackers[0], team: awayTeam, prob: `${Math.min(98, 48 + ((h >>> 10) % 37) + bonusOfficial)}%` }
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

async function upsertToSupabase(matches) {
  await supabaseRequest('POST', '/rest/v1/matches', matches);
  console.log(`Salvataggio completato (${matches.length} partite).`);
}

async function run() {
  const now = new Date();
  const future = new Date(now);
  future.setDate(now.getDate() + 7);

  const dateFrom = now.toISOString().split('T')[0];
  const dateTo = future.toISOString().split('T')[0];

  const existingMap = await fetchExistingMatchesMap(now.toISOString(), future.toISOString());
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

    for (const m of matches) {
      const homeName = m.homeTeam?.shortName || m.homeTeam?.name;
      const awayName = m.awayTeam?.shortName || m.awayTeam?.name;
      const homeId = m.homeTeam?.id;
      const awayId = m.awayTeam?.id;
      if (!m.id || !homeName || !awayName || !m.utcDate) continue;

      const existingRow = existingMap.get(String(m.id)) || null;
      const kickoffMs = new Date(m.utcDate).getTime();
      const minsToKickoff = (kickoffMs - Date.now()) / 60000;

      // Finestra critica: tra -15 e +90 minuti dal kickoff controlla sempre formazioni fresche
      const isCriticalWindow = minsToKickoff >= -15 && minsToKickoff <= 90;

      const hasOfficialPreview =
        Array.isArray(m.homeTeam?.lineup) && m.homeTeam.lineup.length >= 7 &&
        Array.isArray(m.awayTeam?.lineup) && m.awayTeam.lineup.length >= 7;

      const homeSquad = hasOfficialPreview ? [] : await getTeamSquad(homeId, isCriticalWindow ? null : existingRow);
      const awaySquad = hasOfficialPreview ? [] : await getTeamSquad(awayId, isCriticalWindow ? null : existingRow);

      const tabData = buildTabData(m, homeName, awayName, homeSquad, awaySquad, existingRow, m.id);
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
  await upsertToSupabase(allMatches);
}

run().catch(err => {
  console.error("Errore:", err);
  process.exit(1);
});
