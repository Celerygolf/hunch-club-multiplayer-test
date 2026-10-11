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

function publicState(game, playerId) {
  const finished = game.status === 'Finished';
  const settled = finished || game.status === 'Settled';
  const players = game.players.map(p => ({
    id:p.id, name:p.name, alive:p.alive,
    picked:!!game.picks?.[p.id],
    choice:settled ? (game.picks?.[p.id]?.choice ?? null) : null
  }));
  const own = game.players.find(p => p.id === playerId);
  return {
    code:game.code, hostName:game.hostName, status:game.status, round:game.round,
    question, result:game.result ?? null, players,
    ownPick:game.picks?.[playerId]?.choice ?? null,
    ownAlive:own?.alive ?? false,
    winner:finished ? game.players.filter(p=>p.alive).map(p=>p.name) : null
  };
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const data = req.method === 'POST' ? await req.json().catch(()=>({})) : {};
    if (action === 'create' && req.method === 'POST') {
      const name = cleanName(data.name);
      if (!name) return respond({error:'Enter your name.'},400);
      let code;
      do {code=newCode()} while (await load(code));
      const playerId=randomUUID(),hostToken=randomUUID();
      const game={code,hostName:name,hostId:playerId,hostToken,status:'Waiting',round:1,
        createdAt:Date.now(),players:[{id:playerId,name,alive:true,joinedAt:Date.now()}],picks:{},result:null};
      await save(game);
      return respond({code,playerId,hostToken});
    }
    const code=cleanCode(data.code ?? url.searchParams.get('code'));
    if (code.length!==6) return respond({error:'Invalid game code.'},400);
    const game=await load(code);
    if (!game) return respond({error:'Game code not found.'},404);
    if (action === 'state' && req.method === 'GET') {
      return respond(publicState(game,url.searchParams.get('playerId')));
    }
    if (action === 'join' && req.method === 'POST') {
      if (game.status!=='Waiting') return respond({error:'This game has already started.'},409);
      const name=cleanName(data.name);
      if (!name) return respond({error:'Enter your name.'},400);
      const playerId=randomUUID();
      game.players.push({id:playerId,name,alive:true,joinedAt:Date.now()});
      await save(game);
      return respond({code,playerId});
    }
    if (action === 'start' && req.method === 'POST') {
      if (data.hostToken!==game.hostToken) return respond({error:'Only the host can start.'},403);
      if (game.status!=='Waiting') return respond({error:'Game already started.'},409);
      game.status='Started';game.startedAt=Date.now();
      await save(game);
      return respond({status:game.status});
    }
    if (action === 'pick' && req.method === 'POST') {
      if (game.status!=='Started') return respond({error:'Predictions are closed.'},409);
      const id=String(data.playerId||''),choice=data.choice;
      if (!['YES','NO'].includes(choice)) return respond({error:'Choose YES or NO.'},400);
      const player=game.players.find(p=>p.id===id);
      if (!player) return respond({error:'Player not found.'},404);
      if (!player.alive) return respond({error:'You have been eliminated.'},409);
      if (game.picks[id]) return respond({choice:game.picks[id].choice,locked:true});
      game.picks[id]={choice,lockedAt:Date.now()};
      await save(game);
      return respond({choice,locked:true});
    }
    if (action === 'settle' && req.method === 'POST') {
      if (data.hostToken!==game.hostToken) return respond({error:'Only the host can settle.'},403);
      if (game.status!=='Started') return respond({error:'Game not ready to settle.'},409);
      if (!['YES','NO'].includes(data.result)) return respond({error:'Choose YES or NO.'},400);
      const alive=game.players.filter(p=>p.alive);
      if (alive.some(p=>!game.picks[p.id])) return respond({error:'Wait for every remaining player to lock a prediction.'},409);
      for (const p of alive) p.alive=game.picks[p.id].choice===data.result;
      const survivors=alive.filter(p=>p.alive).length;
      game.status=survivors<=1?'Finished':'Settled';
      game.result=data.result;game.settledAt=Date.now();
      await save(game);
      return respond({status:game.status,result:data.result,survivors});
    }
    if (action === 'next' && req.method === 'POST') {
      if (data.hostToken!==game.hostToken) return respond({error:'Only the host can continue.'},403);
      if (game.status!=='Settled') return respond({error:'This round is not ready.'},409);
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
