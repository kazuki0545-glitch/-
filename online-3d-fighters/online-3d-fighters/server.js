'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: false }, pingTimeout: 15000 });
const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();
const code = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const newPlayer = (idx) => ({x:idx===0?-2.5:2.5,y:0,vy:0,hp:100,face:idx===0?1:-1,action:'idle',anim:0,cool:0,stun:0,guard:false,hit:false,keys:{},prevJump:false});
const cleanKeys = data => ({left:!!data?.left,right:!!data?.right,jump:!!data?.jump,punch:!!data?.punch,kick:!!data?.kick,guard:!!data?.guard});
function snapshot(r){return {code:r.code,phase:r.phase,time:Math.ceil(r.time),players:r.players.map(p=>p&&({x:p.state.x,y:p.state.y,hp:p.state.hp,face:p.state.face,action:p.state.action,anim:p.state.anim,guard:p.state.guard})),winner:r.winner,round:r.round,events:r.events.splice(0)};}
function broadcast(r){io.to(r.code).emit('state',snapshot(r));}
function startRound(r){r.time=60;r.phase='playing';r.winner=null;r.round++;r.players.forEach((p,i)=>{p.state=newPlayer(i);});r.events.push({kind:'start'});broadcast(r);}
function endRound(r){if(r.phase!=='playing')return;r.phase='ended';const a=r.players[0].state.hp,b=r.players[1].state.hp;r.winner=a===b?-1:a>b?0:1;r.events.push({kind:'end',winner:r.winner});broadcast(r);}
function damage(r,att,tgt,type){const p=att.state,t=tgt.state;let dmg=type==='punch'?9:16;if(t.guard)dmg=2;t.hp=Math.max(0,t.hp-dmg);t.stun=t.guard?.09:.28;t.action=t.guard?'block':'hurt';t.anim=t.stun;t.x=Math.max(-5.7,Math.min(5.7,t.x+p.face*(t.guard?.1:.34)));r.events.push({kind:'hit',x:(p.x+t.x)/2,guard:t.guard,damage:dmg});if(!t.hp)endRound(r);}
function step(r,dt){if(r.phase!=='playing')return;r.time=Math.max(0,r.time-dt);if(r.time<=0){endRound(r);return;}
for(let i=0;i<2;i++){
const p=r.players[i].state,t=r.players[1-i].state,k=p.keys;
p.cool=Math.max(0,p.cool-dt);p.stun=Math.max(0,p.stun-dt);p.anim=Math.max(0,p.anim-dt);
p.guard=!!k.guard&&p.stun===0&&!['punch','kick'].includes(p.action);
if(p.stun===0){
if(p.cool===0&&!p.guard&&(k.punch||k.kick)){const type=k.punch?'punch':'kick';p.action=type;p.anim=type==='punch'?.28:.45;p.cool=type==='punch'?.39:.62;p.hit=false;}
if(k.jump&&!p.prevJump&&p.y===0){p.vy=7.7;p.y=.001;}p.prevJump=k.jump;
if(!p.guard&&!['punch','kick'].includes(p.action)){const direction=Number(k.right)-Number(k.left);p.x+=direction*3.7*dt;p.x=Math.max(-5.7,Math.min(5.7,p.x));if(p.y<.01)p.action=direction?'walk':'idle';}
}else p.prevJump=k.jump;
p.vy-=20*dt;p.y=Math.max(0,p.y+p.vy*dt);if(p.y===0)p.vy=0;p.face=p.x<t.x?1:-1;
if(['punch','kick'].includes(p.action)){
const duration=p.action==='punch'?.28:.45;
const progress=1-p.anim/duration;
if(!p.hit&&progress>=.4){p.hit=true;if(Math.abs(p.x-t.x)<(p.action==='kick'?2.25:1.7)&&Math.abs(p.y-t.y)<1.7)damage(r,r.players[i],r.players[1-i],p.action);}
}
if(p.anim===0&&p.stun===0&&['punch','kick','hurt','block'].includes(p.action))p.action='idle';
}
const sep=r.players[1].state.x-r.players[0].state.x;if(Math.abs(sep)<1.05){const d=(1.05-Math.abs(sep))/2;r.players[0].state.x-=d;r.players[1].state.x+=d;}
}
const allowed = /^[A-Z0-9]{8}$/;
io.on('connection',socket=>{
  socket.on('create',()=>{
    if(socket.data.room){socket.emit('notice','先に現在の部屋から退出してください');return;}
    let id;do{id=code();}while(rooms.has(id));
    const r={code:id,players:[{id:socket.id,state:newPlayer(0)},null],phase:'waiting',time:60,winner:null,round:0,events:[],created:Date.now()};rooms.set(id,r);socket.data.room=id;socket.data.slot=0;socket.join(id);socket.emit('joined',{code:id,slot:0});broadcast(r);
  });
  socket.on('join',arg=>{
    if(socket.data.room){socket.emit('notice','先に現在の部屋から退出してください');return;}
    const id=String(arg?.code||'').trim().toUpperCase();if(!allowed.test(id)){socket.emit('notice','部屋コードが正しくありません');return;}
    const r=rooms.get(id);if(!r){socket.emit('notice','部屋が見つかりません。招待URLを確認してください');return;}
    if(r.players[1]){socket.emit('notice','満室です（観戦は未対応）');return;}
    r.players[1]={id:socket.id,state:newPlayer(1)};socket.data.room=id;socket.data.slot=1;socket.join(id);socket.emit('joined',{code:id,slot:1});startRound(r);
  });
  socket.on('input',arg=>{const r=rooms.get(socket.data.room),slot=socket.data.slot;if(!r||!Number.isInteger(slot)||r.players[slot]?.id!==socket.id)return;r.players[slot].state.keys=cleanKeys(arg);});
  socket.on('rematch',()=>{const r=rooms.get(socket.data.room);if(r&&r.players.every(Boolean)&&r.phase==='ended')startRound(r);});
  socket.on('disconnect',()=>{
    const id=socket.data.room,slot=socket.data.slot,r=rooms.get(id);if(!r||r.players[slot]?.id!==socket.id)return;
    r.players[slot]=null;r.phase='waiting';r.winner=null;r.events=[];io.to(id).emit('notice','相手が退出しました。新しい対戦相手を招待してください');
    if(slot===0){if(r.players[1]){const other=io.sockets.sockets.get(r.players[1].id);if(other){other.data.slot=0;other.emit('joined',{code:id,slot:0});}r.players[0]=r.players[1];r.players[0].state=newPlayer(0);r.players[1]=null;}};
    if(!r.players.some(Boolean))rooms.delete(id);else broadcast(r);
  });
});
let last=Date.now(),tick=0;
setInterval(()=>{const now=Date.now(),dt=Math.min(.05,(now-last)/1000);last=now;tick++;for(const r of rooms.values()){if(r.players.every(Boolean))step(r,dt);if(tick%2===0&&r.players.some(Boolean))broadcast(r);}},1000/30);
httpServer.listen(PORT,'0.0.0.0',()=>console.log(`Online 3D Fighters running on port ${PORT}`));
