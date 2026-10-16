import { getStore } from '@netlify/blobs';
import { randomUUID, randomInt } from 'node:crypto';

// Strong reads prevent a freshly created game from temporarily appearing missing.
// Each game is one blob, avoiding the previous list + many reads on every refresh.
const store = () => getStore({ name: 'hunch-club-v5', consistency: 'strong' });
const respond = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});
const cleanCode = value => String(value || '').toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,6);
const cleanName = value => String(value || '').trim().slice(0,32);
const newCode = () => Array.from({length:6}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
const key = code => `game-${code}`;
const load = code => store().get(key(code), {type:'json'});
const save = game => store().setJSON(key(game.code), game);
const question = {title:'Will there be a goal in the first half?', note:'Test question — not linked to a live match.'};
const isShieldRound = round => round > 0 && round % 4 === 0; // Round 4, 8, ...
const mistakes = p => Number.isInteger(p.mistakes) ? p.mistakes : (p.alive ? 0 : 2);
const hasShield = p => !!p.shield;


// V7: all football requests happen server-side. Never expose the API key to browsers.
const leagues=[39,40,140,135,78,61,2,3,45,48,179];
const questions=[
  {id:'homewin',label:'Will {home} win this match?'},
  {id:'awaywin',label:'Will {away} win this match?'},
  {id:'draw',label:'Will the match finish as a draw?'},
  {id:'btts',label:'Will both teams score?'},
  {id:'over25',label:'Will there be 3 or more goals?'},
  {id:'homegoal',label:'Will {home} score at least one goal?'},
  {id:'awaygoal',label:'Will {away} score at least one goal?'},
  {id:'htdraw',label:'Will the teams be level at half-time?'}
];
async function football(path) {
  const apiKey=process.env.API_FOOTBALL_KEY;
  if(!apiKey) throw Error('API_FOOTBALL_KEY is missing in Netlify environment variables.');
  const response=await fetch('https://v3.football.api-sports.io/'+path,{
    headers:{'x-apisports-key':apiKey},signal:AbortSignal.timeout(12000)
  });
  if(!response.ok) throw Error('Football provider unavailable (HTTP '+response.status+').');
  const json=await response.json();
  if(json.errors && Object.keys(json.errors).length) throw Error('Football API: '+JSON.stringify(json.errors).slice(0,200));
  return json.response||[];
}
const dateISO=ms=>new Date(ms).toISOString().slice(0,10);
async function chooseFixture(used=[]) {
  const now=Date.now();
  // One league per attempt; at most three calls per new round to conserve free quota.
  const offset=randomInt(leagues.length);
  for(let i=0;i<3;i++){
    const league=leagues[(offset+i)%leagues.length];
    const season=new Date().getUTCMonth()<6?new Date().getUTCFullYear()-1:new Date().getUTCFullYear();
    const data=await football('fixtures?league='+league+'&season='+season+'&next=20');
    const candidates=data.filter(x=>x.fixture?.timestamp*1000>now+15*60000 &&
      x.fixture.timestamp*1000<now+14*86400000 &&
      !used.includes(x.fixture.id) && x.teams?.home && x.teams?.away);
    if(candidates.length){
      const f=candidates[randomInt(candidates.length)];
      const q=questions[randomInt(questions.length)];
      return {fixtureId:f.fixture.id,home:f.teams.home.name,away:f.teams.away.name,
        homeLogo:f.teams.home.logo,awayLogo:f.teams.away.logo,
        league:f.league.name,kickoff:f.fixture.date,questionId:q.id,
        title:q.label.replace('{home}',f.teams.home.name).replace('{away}',f.teams.away.name),
        note:'Real fixture • Answers lock before kickoff'};
    }
  }
  throw Error('No suitable upcoming club fixtures were returned. Try again later.');
}
// Host-selectable fixtures; limit calls to protect API quota.
async function upcomingFixtures(){
 const now=Date.now(),all=[],errors=[];
 for(const league of [39,40]){
  try{
   const season=new Date().getUTCMonth()<6?new Date().getUTCFullYear()-1:new Date().getUTCFullYear();
   const rows=await football('fixtures?league='+league+'&season='+season+'&next=30');
   for(const f of rows){if(f.fixture?.timestamp*1000>now+15*60000 && f.fixture.timestamp*1000<now+14*86400000 && f.teams?.home && f.teams?.away)
    all.push({id:f.fixture.id,home:f.teams.home.name,away:f.teams.away.name,homeLogo:f.teams.home.logo,awayLogo:f.teams.away.logo,league:f.league.name,kickoff:f.fixture.date});}
  }catch(e){errors.push((league===39?'Premier League':'Championship')+': '+e.message);}
 }
 if(!all.length&&errors.length)throw Error('Football API request failed. '+errors.join(' | '));
 return {fixtures:all.sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff)).slice(0,35),warning:errors.length?'Some leagues could not load: '+errors.join(' | '):''};
}
function makeQuestion(f,id){const q=questions.find(x=>x.id===id);if(!q)throw Error('Invalid prediction.');return {fixtureId:f.id,home:f.home,away:f.away,homeLogo:f.homeLogo,awayLogo:f.awayLogo,league:f.league,kickoff:f.kickoff,questionId:q.id,title:q.label.replace('{home}',f.home).replace('{away}',f.away),note:'Real match • Predictions lock at kickoff'};}
const dailyKey=()=>`daily-${dateISO(Date.now())}`;
// Offline demonstration fixtures: invented pairings, not real scheduled matches.
const demoClubs=['West Ham','Arsenal','Chelsea','Liverpool','Everton','Newcastle','Tottenham','Aston Villa','Manchester City','Brighton','Fulham','Crystal Palace'];
function demoFixture(round){
  const home=demoClubs[randomInt(demoClubs.length)];
  const away=demoClubs.filter(x=>x!==home)[randomInt(demoClubs.length-1)];
  const q=questions[randomInt(questions.length)];
  const goalsHome=randomInt(5),goalsAway=randomInt(5);
  const htHome=randomInt(goalsHome+1),htAway=randomInt(goalsAway+1);
  const fixture={goals:{home:goalsHome,away:goalsAway},score:{halftime:{home:htHome,away:htAway}}};
  const descriptor={questionId:q.id};
  return {demo:true,home,away,league:'SIMULATED TEST MATCH',questionId:q.id,
    title:q.label.replace('{home}',home).replace('{away}',away),
    note:'TEST MODE — fictional fixture and simulated score',
    demoScore:goalsHome+'–'+goalsAway, demoHalfTime:htHome+'–'+htAway,
    demoResult:answerFor(descriptor,fixture),round};
}
async function autoDemoCheck(game){
  if(game.status!=='Started'||!game.fixtureQuestion?.demo)return;
  const alive=game.players.filter(p=>p.alive);
  if(!alive.length||alive.some(p=>!game.picks[p.id]))return;
  if(!game.allPicksAt){game.allPicksAt=Date.now();await save(game);return;}
  if(Date.now()-game.allPicksAt<5000)return;
  applyResult(game,game.fixtureQuestion.demoResult);
  await save(game);
}
function answerFor(q,fixture){
  const h=fixture.goals?.home,a=fixture.goals?.away;
  if(!Number.isInteger(h)||!Number.isInteger(a)) return null;
  const half=fixture.score?.halftime;
  const outcomes={
    homewin:h>a,awaywin:a>h,draw:h===a,btts:h>0&&a>0,
    over25:h+a>=3,homegoal:h>0,awaygoal:a>0,
    htdraw:Number.isInteger(half?.home)&&Number.isInteger(half?.away)?half.home===half.away:null
  };
  const value=outcomes[q.questionId];
  return value===null||value===undefined?null:value?'YES':'NO';
}
function applyResult(game,result) {
  const alive=game.players.filter(p=>p.alive);
  for(const p of alive){
    const correct=game.picks[p.id]?.choice===result;
    if(correct){if(isShieldRound(game.round))p.shield=true;}
    else if(p.shield)p.shield=false;
    else {p.mistakes=mistakes(p)+1;if(p.mistakes>=2)p.alive=false;}
  }
  const survivors=alive.filter(p=>p.alive).length;
  game.status=(game.fixtureQuestion?.demo && game.players.length===1)?'Settled':(survivors<=1?'Finished':'Settled');
  game.result=result;game.settledAt=Date.now();
  return survivors;
}
async function autoCheck(game){
  if(game.status!=='Started'||!game.fixtureQuestion)return;
  if(Date.now()<new Date(game.fixtureQuestion.kickoff).getTime()+90*60000)return;
  // Avoid repeated provider calls while awaiting final score.
  if(game.lastFootballCheck && Date.now()-game.lastFootballCheck<60*60000)return;
  game.lastFootballCheck=Date.now();
  const [f]=await football('fixtures?id='+game.fixtureQuestion.fixtureId);
  if(!f){await save(game);return;}
  const status=f.fixture?.status?.short;
  if(['PST','CANC','ABD','AWD','WO'].includes(status)){
    game.fixtureStatus='Match postponed/cancelled. No player will lose a life. Contact host to restart.';
    await save(game);return;
  }
  if(!['FT','AET','PEN'].includes(status)){await save(game);return;}
  const result=answerFor(game.fixtureQuestion,f);
  if(!result){game.fixtureStatus='Final statistics not yet available.';await save(game);return;}
  // Unlocked predictions at kickoff count as incorrect; do not block the round.
  applyResult(game,result);
  await save(game);
}

function publicState(game, playerId) {
  const finished = game.status === 'Finished';
  const settled = finished || game.status === 'Settled';
  const players = game.players.map(p => ({
    id:p.id, name:p.name, alive:p.alive, mistakes:mistakes(p), shield:hasShield(p),
    picked:!!game.picks?.[p.id],
    choice:settled ? (game.picks?.[p.id]?.choice ?? null) : null
  }));
  const own = game.players.find(p => p.id === playerId);
  return {
    code:game.code, hostName:game.hostName, mode:game.mode||'demo', selectedQuestion:game.status==='Waiting'?game.selectedQuestion:null, status:game.status, round:game.round,
    question:game.fixtureQuestion||question, fixtureStatus:game.fixtureStatus||null, automatic:!!game.fixtureQuestion, shieldRound:isShieldRound(game.round), result:game.result ?? null, players,
    ownPick:game.picks?.[playerId]?.choice ?? null,
    ownAlive:own?.alive ?? false, ownMistakes:own ? mistakes(own) : 0, ownShield:own ? hasShield(own) : false,
    winner:finished ? game.players.filter(p=>p.alive).map(p=>p.name) : null
  };
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const data = req.method === 'POST' ? await req.json().catch(()=>({})) : {};
    if(action==='fixtures' && req.method==='GET'){
      const result=await upcomingFixtures();return respond({...result,questions:questions.map(q=>({id:q.id,label:q.label}))});
    }
    if(action==='daily' && req.method==='POST'){
      const name=cleanName(data.name);if(!name)return respond({error:'Enter your name.'},400);
      const ds=store();let daily=await ds.get(dailyKey(),{type:'json'});
      if(!daily){
        const fixture=await chooseFixture();
        let code;do{code=newCode()}while(await load(code));
        daily={code,hostName:'Hunch Club',hostId:'daily',hostToken:randomUUID(),mode:'daily',status:'Started',round:1,createdAt:Date.now(),startedAt:Date.now(),players:[],picks:{},result:null,fixtureQuestion:fixture};
        await save(daily);await ds.setJSON(dailyKey(),{code});
      }else{daily=await load(daily.code);if(!daily)return respond({error:'Daily game unavailable. Please try again.'},503);}
      const playerId=randomUUID();daily.players.push({id:playerId,name,alive:true,mistakes:0,shield:false,joinedAt:Date.now()});await save(daily);
      return respond({code:daily.code,playerId});
    }
    if (action === 'create' && req.method === 'POST') {
      const name = cleanName(data.name);
      if (!name) return respond({error:'Enter your name.'},400);
      let code;
      do {code=newCode()} while (await load(code));
      const playerId=randomUUID(),hostToken=randomUUID();
      const game={code,hostName:name,hostId:playerId,hostToken,status:'Waiting',round:1,
        mode:data.mode==='real'?'real':'demo',createdAt:Date.now(),players:[{id:playerId,name,alive:true,mistakes:0,shield:false,joinedAt:Date.now()}],picks:{},result:null};
      await save(game);
      return respond({code,playerId,hostToken});
    }
    const code=cleanCode(data.code ?? url.searchParams.get('code'));
    if (code.length!==6) return respond({error:'Invalid game code.'},400);
    const game=await load(code);
    if (!game) return respond({error:'Game code not found.'},404);
    if (action === 'state' && req.method === 'GET') {
      try {if(game.fixtureQuestion?.demo) await autoDemoCheck(game); else await autoCheck(game);}catch(e){console.error('Football status check:',e.message);}
      return respond(publicState(game,url.searchParams.get('playerId')));
    }
    if (action === 'join' && req.method === 'POST') {
      if (game.status!=='Waiting') return respond({error:'This game has already started.'},409);
      const name=cleanName(data.name);
      if (!name) return respond({error:'Enter your name.'},400);
      const playerId=randomUUID();
      game.players.push({id:playerId,name,alive:true,mistakes:0,shield:false,joinedAt:Date.now()});
      await save(game);
      return respond({code,playerId});
    }
    if(action==='configure' && req.method==='POST'){
      if(data.hostToken!==game.hostToken)return respond({error:'Only the host can select fixtures.'},403);
      if(game.status!=='Waiting')return respond({error:'Game already started.'},409);
      if(data.mode==='demo'){game.mode='demo';game.selectedQuestion=null;}
      else{
        const {fixtures}=await upcomingFixtures();const f=fixtures.find(x=>String(x.id)===String(data.fixtureId));
        if(!f)return respond({error:'Fixture no longer available. Refresh the fixture list.'},409);
        game.mode='real';game.selectedQuestion=makeQuestion(f,data.questionId);
      }
      await save(game);return respond({ok:true});
    }
    if (action === 'start' && req.method === 'POST') {
      if (data.hostToken!==game.hostToken) return respond({error:'Only the host can start.'},403);
      if (game.status!=='Waiting') return respond({error:'Game already started.'},409);
      game.fixtureQuestion=game.mode==='real'?game.selectedQuestion:demoFixture(game.round);
      game.usedFixtures=[...(game.usedFixtures||[]),game.fixtureQuestion.fixtureId];
      game.status='Started';game.startedAt=Date.now();
      await save(game);
      return respond({status:game.status});
    }
    if (action === 'pick' && req.method === 'POST') {
      if (game.status!=='Started') return respond({error:'Predictions are closed.'},409);
      if(game.fixtureQuestion?.kickoff && Date.now()>=new Date(game.fixtureQuestion.kickoff).getTime())return respond({error:'Kickoff has passed. Predictions are closed.'},409);
      const id=String(data.playerId||''),choice=data.choice;
      if (!['YES','NO'].includes(choice)) return respond({error:'Choose YES or NO.'},400);
      const player=game.players.find(p=>p.id===id);
      if (!player) return respond({error:'Player not found.'},404);
      if (!player.alive) return respond({error:'You have been eliminated.'},409);
      if (game.picks[id]) return respond({choice:game.picks[id].choice,locked:true});
      game.picks[id]={choice,lockedAt:Date.now()};
      if(game.fixtureQuestion?.demo && game.players.filter(p=>p.alive).every(p=>game.picks[p.id]))game.allPicksAt=Date.now();
      await save(game);
      return respond({choice,locked:true});
    }
    if (action === 'settle' && req.method === 'POST') {
      if (data.hostToken!==game.hostToken) return respond({error:'Only the host can settle.'},403);
      if(game.fixtureQuestion)return respond({error:'Results are settled automatically for real fixtures.'},409);
      if (game.status!=='Started') return respond({error:'Game not ready to settle.'},409);
      if (!['YES','NO'].includes(data.result)) return respond({error:'Choose YES or NO.'},400);
      const alive=game.players.filter(p=>p.alive);
      if (alive.some(p=>!game.picks[p.id])) return respond({error:'Wait for every remaining player to lock a prediction.'},409);
      for (const p of alive) {
        const correct = game.picks[p.id].choice === data.result;
        if (correct) {
          if (isShieldRound(game.round)) p.shield = true;
        } else if (p.shield) {
          p.shield = false; // Shield absorbs one wrong prediction
        } else {
          p.mistakes = mistakes(p) + 1;
          if (p.mistakes >= 2) p.alive = false;
        }
      }
      const survivors=alive.filter(p=>p.alive).length;
      game.status=survivors<=1?'Finished':'Settled';
      game.result=data.result;game.settledAt=Date.now();
      await save(game);
      return respond({status:game.status,result:data.result,survivors});
    }
    if (action === 'next' && req.method === 'POST') {
      if (data.hostToken!==game.hostToken) return respond({error:'Only the host can continue.'},403);
      if (game.status!=='Settled') return respond({error:'This round is not ready.'},409);
      const nextQuestion=game.mode==='real'?await chooseFixture(game.usedFixtures||[]):demoFixture(game.round+1);
      game.usedFixtures=[...(game.usedFixtures||[]),nextQuestion.fixtureId];
      game.fixtureQuestion=nextQuestion;game.fixtureStatus=null;game.lastFootballCheck=null;game.allPicksAt=null;
      game.status='Started';game.round++;game.result=null;game.picks={};
      await save(game);
      return respond({status:game.status,round:game.round});
    }
    return respond({error:'Unknown action.'},404);
  } catch (e) {
    console.error('Hunch Club backend error',e);
    return respond({error:'Server error. Check Netlify function logs.'},500);
  }
}
export const config={path:'/api/game'};
