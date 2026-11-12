import fs from "node:fs/promises";

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) throw new Error("Missing API_FOOTBALL_KEY secret");
const BASE = "https://v3.football.api-sports.io";
const LEAGUES = [
  {id:135,name:"Serie A"},{id:39,name:"Premier League"},{id:140,name:"La Liga"},
  {id:78,name:"Bundesliga"},{id:61,name:"Ligue 1"},{id:2,name:"Champions League"},{id:3,name:"Europa League"}
];
const season = new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear()-1;
const date = d => d.toISOString().slice(0,10);
const now = new Date();
const from = new Date(now); from.setUTCDate(from.getUTCDate()-75);
const to = new Date(now); to.setUTCDate(to.getUTCDate()+10);
const cache = new Map();

async function api(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(BASE+path,{headers:{"x-apisports-key":KEY}});
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) throw new Error(JSON.stringify(json.errors));
  const data=json.response||[];
  cache.set(path,data);
  return data;
}
const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
function poisson(l,k){let p=Math.exp(-l),v=p;for(let i=1;i<=k;i++){p*=l/i;v+=p;}return v;}
function probs(h,a){
  let home=0,draw=0,away=0,over=0,btts=0;
  for(let i=0;i<=8;i++)for(let j=0;j<=8;j++){
    const p=Math.exp(-h)*h**i/factorial(i)*Math.exp(-a)*a**j/factorial(j);
    if(i>j)home+=p;else if(i===j)draw+=p;else away+=p;
    if(i+j>=3)over+=p;if(i>0&&j>0)btts+=p;
  }
  return {home,draw,away,over,btts};
}
function factorial(n){let x=1;for(let i=2;i<=n;i++)x*=i;return x;}
const pct=x=>Math.round(x*100);
const output={generatedAt:now.toISOString(),season,provider:"API-Football",leagues:[],matches:[],warnings:[]};

for(const league of LEAGUES){
  try{
    const [recent,upcoming]=await Promise.all([
      api(`/fixtures?league=${league.id}&season=${season}&from=${date(from)}&to=${date(now)}`),
      api(`/fixtures?league=${league.id}&season=${season}&from=${date(now)}&to=${date(to)}`)
    ]);
    const finished=recent.filter(f=>["FT","AET","PEN"].includes(f.fixture.status.short)&&Number.isFinite(f.goals.home)&&Number.isFinite(f.goals.away));
    const form=new Map();
    for(const f of finished){
      for(const [id,venue,gf,ga] of [[f.teams.home.id,"home",f.goals.home,f.goals.away],[f.teams.away.id,"away",f.goals.away,f.goals.home]]){
        if(!form.has(id))form.set(id,{homeFor:[],homeAgainst:[],awayFor:[],awayAgainst:[]});
        const t=form.get(id);t[venue+"For"].push(gf);t[venue+"Against"].push(ga);
      }
    }
    output.leagues.push({id:league.id,name:league.name,finished:finished.length,upcoming:upcoming.length});
    for(const f of upcoming){
      const h=form.get(f.teams.home.id),a=form.get(f.teams.away.id);
      const enough=h&&a&&h.homeFor.length>=3&&a.awayFor.length>=3;
      let prediction=null;
      if(enough){
        const homeRate=(avg(h.homeFor)+avg(a.awayAgainst))/2;
        const awayRate=(avg(a.awayFor)+avg(h.homeAgainst))/2;
        if(homeRate>0&&awayRate>0){
          const p=probs(homeRate,awayRate);
          const outcomes=[["1",p.home],["X",p.draw],["2",p.away]].sort((x,y)=>y[1]-x[1]);
          prediction={expectedGoals:{home:+homeRate.toFixed(2),away:+awayRate.toFixed(2)},oneXTwo:{home:pct(p.home),draw:pct(p.draw),away:pct(p.away)},doubleChance:{ "1X":pct(p.home+p.draw),"X2":pct(p.draw+p.away),"12":pct(p.home+p.away)},over25:pct(p.over),under25:pct(1-p.over),bothTeamsToScore:pct(p.btts),goalNoGoal:{goal:pct(p.btts),noGoal:pct(1-p.btts)},mostLikelyOutcome:outcomes[0][0]};
        }
      }
      output.matches.push({id:f.fixture.id,league:league.name,kickoff:f.fixture.date,home:f.teams.home.name,away:f.teams.away.name,status:f.fixture.status.short,prediction,reason:prediction?"Stima Poisson su medie casa/trasferta delle ultime partite disponibili.":"Campione recente insufficiente per una stima affidabile.",playerMarketsAvailable:false});
    }
  }catch(e){output.warnings.push(`${league.name}: ${e.message}`);}
}
output.matches.sort((a,b)=>a.kickoff.localeCompare(b.kickoff));
await fs.mkdir("data",{recursive:true});
await fs.writeFile("data/fixtures.json",JSON.stringify(output,null,2)+"\n");
console.log(`Saved ${output.matches.length} fixtures; ${output.warnings.length} league warnings`);
