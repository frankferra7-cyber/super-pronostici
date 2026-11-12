import fs from "node:fs/promises";

const KEY = process.env.API_NINJAS_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!KEY) throw new Error("Missing API_NINJAS_KEY secret");
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("Missing Supabase server secrets");
const BASE = "https://api.api-ninjas.com/v1/soccermatches";
const LEAGUES = [
  {id:"seriea",name:"Serie A"},{id:"epl",name:"Premier League"},{id:"laliga",name:"La Liga"},
  {id:"bundesliga",name:"Bundesliga"},{id:"ligue1",name:"Ligue 1"},{id:"ucl",name:"Champions League"},{id:"uel",name:"Europa League"}
];
const now = new Date();
const season = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear()-1;
const cutoff = new Date(now); cutoff.setUTCDate(cutoff.getUTCDate()-75);
const cache = new Map();

async function api(league, offset) {
  const url = `${BASE}?league=${encodeURIComponent(league)}&season=${season}&offset=${offset}`;
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url,{headers:{"X-Api-Key":KEY}});
  const body = await res.text();
  if (!res.ok) throw new Error(`API Ninjas ${res.status}: ${body.slice(0,300)}`);
  let data;
  try { data=JSON.parse(body); } catch { throw new Error("Risposta API non valida"); }
  if (!Array.isArray(data)) throw new Error(JSON.stringify(data).slice(0,300));
  cache.set(url,data);
  return data;
}
const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
function factorial(n){let x=1;for(let i=2;i<=n;i++)x*=i;return x;}
function probs(h,a){
  let home=0,draw=0,away=0,over=0,btts=0,best=0,score="0-0";
  for(let i=0;i<=8;i++)for(let j=0;j<=8;j++){
    const p=Math.exp(-h)*h**i/factorial(i)*Math.exp(-a)*a**j/factorial(j);
    if(i>j)home+=p;else if(i===j)draw+=p;else away+=p;
    if(i+j>=3)over+=p;if(i>0&&j>0)btts+=p;
    if(p>best){best=p;score=i+"-"+j;}
  }
  return {home,draw,away,over,btts,score};
}
const pct=x=>Math.round(x*100);
const kickoffOf = f => f.start_time || (f.date ? new Date(f.date+"T12:00:00Z").toISOString() : null);
const teamName = t => typeof t === "string" ? t : (t?.name || t?.abbreviation || "");
const output={generatedAt:now.toISOString(),season,provider:"API Ninjas",leagues:[],matches:[],warnings:[]};

for (const league of LEAGUES) {
  try {
    const all=[];
    // API Ninjas returns 50 matches per page on the free tier; walk the season.
    for (let offset=0, page=0; page<12; offset+=50,page++) {
      const batch=await api(league.id,offset);
      all.push(...batch);
      if (batch.length<50) break;
    }
    const normalized=all.map(f=>({...f,_kickoff:kickoffOf(f)})).filter(f=>f._kickoff);
    const finished=normalized.filter(f=>f.status==="final" && Number.isFinite(Number(f.home_score)) && Number.isFinite(Number(f.away_score)) && new Date(f._kickoff)>=cutoff && new Date(f._kickoff)<now);
    const form=new Map();
    for (const f of finished) {
      const home=teamName(f.home_team), away=teamName(f.away_team);
      if(!form.has(home))form.set(home,{homeFor:[],homeAgainst:[],awayFor:[],awayAgainst:[]});
      if(!form.has(away))form.set(away,{homeFor:[],homeAgainst:[],awayFor:[],awayAgainst:[]});
      const h=form.get(home),a=form.get(away),hg=Number(f.home_score),ag=Number(f.away_score);
      h.homeFor.push(hg);h.homeAgainst.push(ag);a.awayFor.push(ag);a.awayAgainst.push(hg);
    }
    const upcoming=normalized.filter(f=>f.status==="scheduled" && new Date(f._kickoff)>now);
    output.leagues.push({id:league.id,name:league.name,seasonMatches:normalized.length,finished:finished.length,upcoming:upcoming.length});
    for (const f of upcoming) {
      const home=teamName(f.home_team),away=teamName(f.away_team),h=form.get(home),a=form.get(away);
      let prediction=null;
      const enough=h&&a&&h.homeFor.length>=3&&a.awayFor.length>=3;
      if(enough){
        const homeRate=(avg(h.homeFor)+avg(a.awayAgainst))/2;
        const awayRate=(avg(a.awayFor)+avg(h.homeAgainst))/2;
        if(homeRate>0&&awayRate>0){
          const p=probs(homeRate,awayRate);
          const outcomes=[["1",p.home],["X",p.draw],["2",p.away]].sort((x,y)=>y[1]-x[1]);
          prediction={expectedGoals:{home:+homeRate.toFixed(2),away:+awayRate.toFixed(2)},oneXTwo:{home:pct(p.home),draw:pct(p.draw),away:pct(p.away)},doubleChance:{"1X":pct(p.home+p.draw),"X2":pct(p.draw+p.away),"12":pct(p.home+p.away)},over25:pct(p.over),under25:pct(1-p.over),bothTeamsToScore:pct(p.btts),goalNoGoal:{goal:pct(p.btts),noGoal:pct(1-p.btts)},mostLikelyOutcome:outcomes[0][0],likelyScore:p.score};
        }
      }
      output.matches.push({id:f.game_id||`${league.id}-${f._kickoff}-${home}-${away}`,league:league.name,kickoff:f._kickoff,home,away,status:f.status,prediction,reason:prediction?"Stima Poisson su medie casa/trasferta delle ultime partite disponibili.":"Campione recente insufficiente per una stima affidabile.",playerMarketsAvailable:false});
    }
    if(!normalized.length) output.warnings.push(`${league.name}: nessuna partita restituita per la stagione ${season}`);
  } catch(e) { output.warnings.push(`${league.name}: ${e.message}`); }
}
output.matches.sort((a,b)=>a.kickoff.localeCompare(b.kickoff));
if (!output.leagues.length) throw new Error("No competition data could be loaded; refusing to publish an empty refresh");
await fs.mkdir("data",{recursive:true});
await fs.writeFile("data/fixtures.json",JSON.stringify(output,null,2)+"\n");
console.log(`Saved ${output.matches.length} future fixtures across ${output.leagues.length} leagues; ${output.warnings.length} warnings to data/fixtures.json`);
