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

// Mappa di normalizzazione nomi squadre Serie A (API <-> Fonti italiane)
const SERIE_A_ALIASES = {
  atalanta: ['atalanta', 'atalanta bc'],
  bologna: ['bologna', 'bologna fc', 'bologna fc 1909'],
  cagliari: ['cagliari', 'cagliari calcio'],
  como: ['como', 'como 1907'],
  cremonese: ['cremonese', 'us cremonese'],
  empoli: ['empoli', 'empoli fc'],
  fiorentina: ['fiorentina', 'acf fiorentina'],
  genoa: ['genoa', 'genoa cfc'],
  inter: ['inter', 'internazionale', 'fc internazionale milano'],
  juventus: ['juventus', 'juventus fc'],
  lazio: ['lazio', 'ss lazio'],
  lecce: ['lecce', 'us lecce'],
  milan: ['milan', 'ac milan'],
  monza: ['monza', 'ac monza'],
  napoli: ['napoli', 'ssc napoli'],
  parma: ['parma', 'parma calcio', 'parma calcio 1913'],
  pisa: ['pisa', 'pisa sc'],
  roma: ['roma', 'as roma'],
  salernitana: ['salernitana', 'us salernitana'],
  sampdoria: ['sampdoria', 'uc sampdoria'],
  sassuolo: ['sassuolo', 'us sassuolo'],
  spezia: ['spezia', 'spezia calcio'],
  torino: ['torino', 'torino fc'],
  udinese: ['udinese', 'udinese calcio'],
  venezia: ['venezia', 'venezia fc'],
  verona: ['verona', 'hellas verona', 'hellas verona fc']
};

function canonicalTeamKey(rawName) {
  const clean = String(rawName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [canonical, aliases] of Object.entries(SERIE_A_ALIASES)) {
    if (aliases.some(a => clean === a || clean.includes(a))) {
      return canonical;
    }
  }
  return clean;
}

function fetchUrl(urlString, extraHeaders = {}, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 4) {
      return reject(new Error(`Troppi redirect per ${urlString}`));
    }
    const parsed = new URL(urlString);
    const options = {
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
        ...extraHeaders
      }
    };

    https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, urlString).toString();
        res.resume();
        return resolve(fetchUrl(nextUrl, extraHeaders, redirectDepth + 1));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function fetchFootballData(path) {
  const res = await fetchUrl(`https://api.football-data.org${path}`, {
    'X-Auth-Token': FOOTBALL_DATA_KEY.trim(),
    'Accept': 'application/json'
  });
  try {
    return { status: res.status, body: JSON.parse(res.body) };
  } catch {
    throw new Error(`Risposta non JSON (${res.status}): ${res.body.slice(0, 200)}`);
  }
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function assignRolesByFormation(players, formation) {
  const parts = String(formation || '4-3-3')
    .split('-')
    .map(n => parseInt(n, 10))
    .filter(n => !isNaN(n) && n > 0);

  const defCount = parts[0] || 4;
  const attCount = parts.length >= 2 ? parts[parts.length - 1] : 3;
  const midCount = Math.max(1, 10 - defCount - attCount);

  return players.slice(0, 11).map((name, idx) => {
    let pos = 'CEN';
    if (idx === 0) pos = 'POR';
    else if (idx <= defCount) pos = 'DIF';
    else if (idx <= defCount + midCount) pos = 'CEN';
    else pos = 'ATT';

    return {
      pos,
      name: name.trim(),
      number: idx + 1
    };
  });
}

/**
 * Estrae le probabili formazioni reali di Serie A da Fantacalcio.it
 * Ritorna una Map con chiave "homeCanonical|awayCanonical"
 */
async function fetchSerieAProbableLineups() {
  const lineupMap = new Map();
  const sources = [
    'https://www.fantacalcio.it/probabili-formazioni-serie-a',
    'https://sport.sky.it/calcio/serie-a/probabili-formazioni'
  ];

  for (const url of sources) {
    try {
      const res = await fetchUrl(url, {
        'Accept': 'text/html,application/xhtml+xml'
      });

      if (res.status !== 200 || !res.body) {
        console.log(`[Serie A Scraper] ${url} -> status ${res.status}`);
        continue;
      }

      const html = res.body;

      // Pattern 1: blocchi match con nomi squadre e liste titolari (Fantacalcio / Sky)
      const matchBlocks = html.split(/(?=<(?:article|section|div)[^>]+class="[^"]*(?:match|incontro|probabili|lineup-card)[^"]*")/i);

      for (const block of matchBlocks) {
        if (block.length < 200 || block.length > 60000) continue;

        // Estrae eventuali moduli tipo 3-5-2, 4-3-3, 4-2-3-1
        const formationsFound = [...block.matchAll(/\b([345]-[12345]-[12345](?:-[12])?)\b/g)].map(m => m[1]);

        // Estrae i link/nomi dei giocatori dentro contenitori titolari
        const playerCandidates = [];
        const playerRegex = /<(?:a|span|div|li)[^>]*class="[^"]*(?:player-name|nome-giocatore|player|calciatore)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div|li)>/gi;
        let pMatch;
        while ((pMatch = playerRegex.exec(block)) !== null) {
          const cleanName = stripTags(pMatch[1]);
          if (
            cleanName.length >= 3 &&
            cleanName.length <= 28 &&
            !/\d+%/.test(cleanName) &&
            !playerCandidates.includes(cleanName)
          ) {
            playerCandidates.push(cleanName);
          }
        }

        // Individua le due squadre presenti nel blocco
        const blockText = stripTags(block).toLowerCase();
        const foundTeams = [];
        for (const [canonical, aliases] of Object.entries(SERIE_A_ALIASES)) {
          let firstPos = Infinity;
          for (const alias of aliases) {
            const idx = blockText.search(new RegExp(`\\b${alias}\\b`, 'i'));
            if (idx !== -1 && idx < firstPos) firstPos = idx;
          }
          if (firstPos !== Infinity) {
            foundTeams.push({ canonical, pos: firstPos });
          }
        }

        foundTeams.sort((a, b) => a.pos - b.pos);

        if (foundTeams.length >= 2 && playerCandidates.length >= 22) {
          const homeKey = foundTeams[0].canonical;
          const awayKey = foundTeams[1].canonical;
          const pairKey = `${homeKey}|${awayKey}`;

          if (!lineupMap.has(pairKey)) {
            const homeFormation = formationsFound[0] || '4-3-3';
            const awayFormation = formationsFound[1] || formationsFound[0] || '4-2-3-1';

            const homeRaw = playerCandidates.slice(0, 11);
            const awayRaw = playerCandidates.slice(11, 22);

            lineupMap.set(pairKey, {
              homeFormation,
              awayFormation,
              homeXI: assignRolesByFormation(homeRaw, homeFormation),
              awayXI: assignRolesByFormation(awayRaw, awayFormation)
            });
          }
        }
      }

      if (lineupMap.size > 0) {
        console.log(`[Serie A Scraper] Probabili formazioni reali estratte: ${lineupMap.size} partite da ${url}`);
        break;
      }
    } catch (err) {
      console.log(`[Serie A Scraper] Errore su ${url}:`, err.message);
    }
  }

  return lineupMap;
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
  // Filtra giovani aggregati Primavera (nati dal 2007 in poi) se c'è data di nascita
  if (player.dateOfBirth) {
    const birthYear = parseInt(String(player.dateOfBirth).slice(0, 4), 10);
    if (!isNaN(birthYear) && birthYear >= 2007) return false;
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

function buildProbableElevenFallback(squad, teamName, formation, seed) {
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

function resolveLineups(homeTeam, awayTeam, homeSquad, awaySquad, scrapedMatch, seed) {
  const mapPos = (pos) =>
    pos === 'ATT' ? 'offence' :
    pos === 'CEN' ? 'midfield' :
    pos === 'DIF' ? 'defence' : 'goalkeeper';

  // Priorità 1: Probabili formazioni reali estratte per la Serie A
  if (scrapedMatch && scrapedMatch.homeXI?.length === 11 && scrapedMatch.awayXI?.length === 11) {
    return {
      isOfficial: false,
      isRealProbable: true,
      homePlayers: scrapedMatch.homeXI.map(p => ({ name: p.name, position: mapPos(p.pos) })),
      awayPlayers: scrapedMatch.awayXI.map(p => ({ name: p.name, position: mapPos(p.pos) })),
      lineups: {
        home: {
          teamName: homeTeam,
          formation: scrapedMatch.homeFormation,
          isOfficial: false,
          startXI: scrapedMatch.homeXI
        },
        away: {
          teamName: awayTeam,
          formation: scrapedMatch.awayFormation,
          isOfficial: false,
          startXI: scrapedMatch.awayXI
        }
      }
    };
  }

  // Priorità 2: Fallback dalla rosa filtrata per gli altri campionati
  const homeFormation = (seed % 2) === 0 ? "4-3-3" : "3-5-2";
  const awayFormation = ((seed >>> 1) % 2) === 0 ? "4-3-3" : "3-5-2";

  const probHomeXI = buildProbableElevenFallback(homeSquad, homeTeam, homeFormation, seed);
  const probAwayXI = buildProbableElevenFallback(awaySquad, awayTeam, awayFormation, seed + 13);

  return {
    isOfficial: false,
    isRealProbable: false,
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

function buildTabData(homeTeam, awayTeam, homeSquad, awaySquad, scrapedMatch, matchId) {
  const h = hashSeed(homeTeam, awayTeam, matchId);
  const lineupInfo = resolveLineups(homeTeam, awayTeam, homeSquad, awaySquad, scrapedMatch, h);

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

  const homePool = lineupInfo.homePlayers.length ? lineupInfo.homePlayers : homeSquad;
  const awayPool = lineupInfo.awayPlayers.length ? lineupInfo.awayPlayers : awaySquad;

  const homeAttackers = pickPlayersByRole(homePool, homeTeam, ['offence', 'forward', 'attacker', 'winger', 'att', 'fwd'], 2, h % 97);
  const awayAttackers = pickPlayersByRole(awayPool, awayTeam, ['offence', 'forward', 'attacker', 'winger', 'att', 'fwd'], 2, (h >>> 4) % 97);
  const homeCardCandidates = pickPlayersByRole(homePool, homeTeam, ['midfield', 'defence', 'defender', 'midfielder', 'mid', 'def'], 2, (h >>> 8) % 97);
  const awayCardCandidates = pickPlayersByRole(awayPool, awayTeam, ['midfield', 'defence', 'defender', 'midfielder', 'mid', 'def'], 2, (h >>> 12) % 97);

  const rawMarcatori = [
    { name: homeAttackers[0], team: homeTeam, prob: `${Math.min(95, 22 + (h % 34))}%` },
    { name: homeAttackers[1] || homeAttackers[0], team: homeTeam, prob: `${Math.min(95, 15 + ((h >>> 3) % 26))}%` },
    { name: awayAttackers[0], team: awayTeam, prob: `${Math.min(95, 20 + ((h >>> 6) % 33))}%` }
  ];

  const rawAmmoniti = [
    { name: homeCardCandidates[0], team: homeTeam, prob: `${Math.min(95, 18 + ((h >>> 9) % 28))}%` },
    { name: awayCardCandidates[0], team: awayTeam, prob: `${Math.min(95, 17 + ((h >>> 13) % 28))}%` }
  ];

  const rawTiri = [
    { name: homeAttackers[0], team: homeTeam, prob: `${Math.min(98, 52 + ((h >>> 2) % 36))}%` },
    { name: awayAttackers[0], team: awayTeam, prob: `${Math.min(98, 48 + ((h >>> 10) % 37))}%` }
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
    isRealProbable: lineupInfo.isRealProbable
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

  const serieALineupsMap = await fetchSerieAProbableLineups();
  const allMatches = [];
  let realProbableCount = 0;

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

      let scrapedMatch = null;
      if (comp.code === 'SA') {
        const pairKey = `${canonicalTeamKey(homeName)}|${canonicalTeamKey(awayName)}`;
        scrapedMatch = serieALineupsMap.get(pairKey) || null;
      }

      const homeSquad = scrapedMatch ? [] : await getTeamSquad(homeId);
      const awaySquad = scrapedMatch ? [] : await getTeamSquad(awayId);

      const tabData = buildTabData(homeName, awayName, homeSquad, awaySquad, scrapedMatch, m.id);
      if (tabData.isRealProbable) realProbableCount++;

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

  console.log(`Partite con probabili formazioni reali (Serie A): ${realProbableCount}/${allMatches.length}`);
  console.log(`Salvataggio di ${allMatches.length} partite su Supabase...`);
  await upsertToSupabase(allMatches);
  console.log("Sincronizzazione completata.");
}

run().catch(err => {
  console.error("Errore:", err);
  process.exit(1);
});
