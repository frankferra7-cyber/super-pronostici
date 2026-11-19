import https from 'https';

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ODDS_API_KEY = (process.env.ODDS_API_KEY || '').trim();

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

const SQUAD_CACHE_TTL_DAYS = 7;
const REQUEST_SPACING_MS = 7200;
const RATE_LIMIT_WAIT_MS = 65000;

const squadCache = new Map();
let supabaseSquadCacheReady = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpRequestJson(method, urlString, headers = {}, jsonBody = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const payload = jsonBody != null ? JSON.stringify(jsonBody) : null;

    const options = {
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: {
        ...headers,
        ...(payload != null ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {})
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (!data || !data.trim()) {
          return resolve({ status: res.statusCode, body: null });
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          reject(new Error(`Risposta non JSON (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function fetchFootballData(path, retryCount = 0) {
  const res = await httpRequestJson('GET', `https://api.football-data.org${path}`, {
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

/**
 * Carica cache rose recenti da Supabase (se esiste la tabella team_squads)
 */
async function loadSupabaseSquadCache() {
  try {
    const cutoff = new Date(Date.now() - SQUAD_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/team_squads?select=team_id,squad,updated_at&updated_at=gte.${encodeURIComponent(cutoff)}`;
    const res = await httpRequestJson('GET', url, {
      'apikey': SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`
    });

    if (res.status >= 200 && res.status < 300 && Array.isArray(res.body)) {
      supabaseSquadCacheReady = true;
      for (const row of res.body) {
        if (row?.team_id != null && Array.isArray(row?.squad)) {
          squadCache.set(Number(row.team_id), row.squad);
        }
      }
      console.log(`[Cache Rose] Caricate ${squadCache.size} rose valide da Supabase.`);
    }
  } catch {
    // Tabella opzionale: continua senza bloccare l'esecuzione
  }
}

async function saveSupabaseSquadCache(teamId, squad) {
  if (!supabaseSquadCacheReady || !teamId || !Array.isArray(squad)) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/team_squads`;
    await httpRequestJson(
      'POST',
      url,
      {
        'apikey': SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      [{
        team_id: Number(teamId),
        squad,
        updated_at: new Date().toISOString()
      }]
    );
  } catch {
    // Ignora errori secondari di cache
  }
}

/**
 * Carica classifica (TOTAL, HOME, AWAY) e forma recente (ultime 5 FINISHED)
 */
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
          list.push
