(() => {
  'use strict';
  const api = window.__zm;
  if (!api) {
    console.error('[Zone Morte] API du jeu introuvable : le script des grenades est chargé trop tôt ou le pont serveur manque.');
    return;
  }

  const types = {
    smoke: { label: 'Fumigène', color: '#b7c3c4' },
    flash: { label: 'Flash', color: '#fff2a8' },
    lethal: { label: 'Mortelle', color: '#e65a45' },
    incend: { label: 'Incendiaire', color: '#ff6b35' }
  };
  const keys = Object.keys(types);
  const inventory = { smoke: 2, flash: 1, lethal: 1, incend: 0 };
  let fires = [];
  // appelé par le jeu quand on ramasse une grenade (coffres, sol)
  window.zmGrenades = { add(type, n) { if (inventory[type] === undefined) return; inventory[type] += (n || 1); const i = keys.indexOf(type); if (inventory[keys[selected]] <= 0 && i >= 0) selected = i; setHud(); } };
  let selected = 0;
  let grenades = [];
  let clouds = [];
  let blind = 0;
  let last = performance.now();

  const style = document.createElement('style');
  style.textContent = `
    #grenadeHud { position:absolute; z-index:4; left:50%; bottom:16px; transform:translateX(-50%); display:flex; gap:6px; align-items:center; pointer-events:auto; }
    #grenadeHud button { font:600 16px "IBM Plex Mono",monospace; letter-spacing:.02em; text-transform:uppercase; color:#e7e1d3; background:rgba(12,14,15,.88); border:1px solid #3b454b; padding:7px 10px; cursor:pointer; }
    #grenadeHud button:hover { border-color:#d4a537; background:#1a1f22; }
    #grenadeLabel { min-width:128px; text-align:center; font-size:11px; color:#e7e1d3; background:rgba(12,14,15,.82); border:1px solid #3b454b; padding:7px 8px; }
    #grenadeLabel strong { color:#d4a537; }
    @media(max-width:640px) { #grenadeHud { left:5px; right:auto; bottom:16px; transform:none; gap:4px; max-width:48vw; } #grenadeHud button { font-size:13px; padding:8px 7px; } #grenadeLabel { min-width:70px; font-size:9px; padding:7px 4px; } }
  `;
  document.head.appendChild(style);

  const hud = document.createElement('div');
  hud.id = 'grenadeHud';
  hud.innerHTML = '<button type="button" id="grenadeCycle">G · TYPE</button><div id="grenadeLabel"></div><button type="button" id="grenadeThrow">LANCER</button>';
  document.getElementById('stage').appendChild(hud);

  const overlay = document.createElement('canvas');
  overlay.id = 'grenadeFx';
  Object.assign(overlay.style, { position:'absolute', inset:'0', width:'100%', height:'100%', zIndex:'2', pointerEvents:'none' });
  document.getElementById('stage').appendChild(overlay);
  const gx = overlay.getContext('2d');
  const gameCanvas = document.getElementById('c');

  function setHud() {
    const key = keys[selected], type = types[key];
    const total = keys.reduce((s, k) => s + inventory[k], 0);
    document.getElementById('grenadeLabel').innerHTML = `<strong>${type.label}</strong> · ${inventory[key]} restante${inventory[key] === 1 ? '' : 's'}<br><span style="opacity:.6">${total} au total</span>`;
    document.getElementById('grenadeCycle').style.borderColor = type.color;
  }
  function cycle() {
    for (let i = 1; i <= keys.length; i++) { const k = (selected + i) % keys.length; if (inventory[keys[k]] > 0) { selected = k; break; } }
    setHud();
  }
  function throwGrenade(screenX, screenY) {
    if (api.G.state !== 'play' || api.G.over) return;
    const player = api.ents[0];
    if (!player || !player.alive) return;
    const key = keys[selected];
    if (inventory[key] <= 0) { api.grenadeToast('Plus de ' + types[key].label.toLowerCase()); return; }
    inventory[key]--;
    setHud();
    const rect = gameCanvas.getBoundingClientRect();
    const sx = screenX == null ? rect.width * .72 : screenX;
    const sy = screenY == null ? rect.height * .5 : screenY;
    const angle = Math.atan2(sy - rect.height / 2, sx - rect.width / 2);
    const range = Math.min(570, Math.max(100, Math.hypot(sx - rect.width / 2, sy - rect.height / 2) * 1.15));
    grenades.push({ type:key, x:player.x, y:player.y, sx:player.x, sy:player.y,
      tx:player.x + Math.cos(angle)*range, ty:player.y + Math.sin(angle)*range, t:0, fuse:.82, owner:player });
  }

  document.getElementById('grenadeCycle').addEventListener('click', cycle);
  document.getElementById('grenadeThrow').addEventListener('click', () => throwGrenade());
  // server.js émet cet événement depuis le vrai gestionnaire pointerdown du canvas.
  // Cela évite de dépendre de l'ordre des gestionnaires du clic droit.
  window.addEventListener('zone-morte-grenade', e => {
    if (e.detail) throwGrenade(e.detail.x, e.detail.y);
  });
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyG' && api.G.state === 'play' && !e.repeat) cycle();
  });
  setHud();

  function clearPath(a, b) {
    const obs = api.obs;
    if (!obs) return true;
    const steps = Math.ceil(Math.hypot(b.x-a.x, b.y-a.y)/12);
    for (let i=1;i<steps;i++) {
      const x=a.x+(b.x-a.x)*i/steps, y=a.y+(b.y-a.y)*i/steps;
      if (obs.some(o => !o.dead && !o.open && (o.lv||0)===(a.lv||0) && x>=o.x && x<=o.x+o.w && y>=o.y && y<=o.y+o.h)) return false;
    }
    return true;
  }
  window.grenadeSmokeBlocks = (a,b) => clouds.some(c => c.type==='smoke' && c.life>0 && (c.lv||0)===(a.lv||0) &&
    Math.hypot(c.x-(a.x+(b.x-a.x)*.5), c.y-(a.y+(b.y-a.y)*.5))<c.r*.85);

  function detonate(g) {
    const player=api.ents[0], type=types[g.type];
    for(let i=0;i<12;i++) {
      const a=Math.random()*Math.PI*2, speed=35+Math.random()*150;
      api.grenadeGetParts().push({x:g.x,y:g.y,vx:Math.cos(a)*speed,vy:Math.sin(a)*speed,life:.35+Math.random()*.4,col:type.color});
    }
    if(g.type==='incend') {
      fires.push({x:g.x,y:g.y,r:105,life:6,max:6,tick:0,lv:g.owner.lv||0,bi:g.owner.bi,owner:g.owner});
      api.grenadeToast('Incendiaire !');
    } else if(g.type==='smoke') {
      clouds.push({type:'smoke',x:g.x,y:g.y,r:145,life:8,max:8,lv:g.owner.lv||0});
      api.grenadeToast('Fumigène !');
    } else if(g.type==='flash') {
      for(const e of api.ents) {
        if(!e.alive || (e.lv||0)!==(g.owner.lv||0)) continue;
        const d=Math.hypot(e.x-g.x,e.y-g.y);
        if(d<360 && clearPath(g,e)) {
          if(e.bot) { e.blind=Math.max(e.blind||0,3.2*(1-d/440)); e.tgt=null; }
          if(e===player) blind=Math.max(blind,1.4*(1-d/440));
        }
      }
      api.grenadeToast('Flash !');
    } else {
      for(const e of api.ents) {
        if(!e.alive || (e.lv||0)!==(g.owner.lv||0) || (e.lv && e.bi!==g.owner.bi)) continue;
        const d=Math.hypot(e.x-g.x,e.y-g.y);
        if(d<155 && clearPath(g,e)) api.grenadeHurt(e,Math.max(0,155*(1-d/170)),g.owner);
      }
      api.grenadeToast('Grenade mortelle !');
    }
  }

  function draw(now) {
    const rect=gameCanvas.getBoundingClientRect(), dpr=Math.min(window.devicePixelRatio||1,2);
    if(overlay.width!==Math.round(rect.width*dpr)||overlay.height!==Math.round(rect.height*dpr)) { overlay.width=Math.round(rect.width*dpr); overlay.height=Math.round(rect.height*dpr); }
    gx.setTransform(dpr,0,0,dpr,0,0); gx.clearRect(0,0,rect.width,rect.height);
    const player=api.ents[0]; if(!player) return;
    const camX=player.x-rect.width/2, camY=player.y-rect.height/2;
    for(const c of clouds) {
      const fade=Math.min(1,c.life,(c.max-c.life+1)/1.2);
      gx.globalAlpha=.26*fade; gx.fillStyle='#b7c3c4'; gx.beginPath(); gx.arc(c.x-camX,c.y-camY,c.r*(.82+Math.sin(now/330)*.04),0,Math.PI*2); gx.fill();
      gx.globalAlpha=.18*fade; gx.beginPath(); gx.arc(c.x-camX-35,c.y-camY+12,c.r*.66,0,Math.PI*2); gx.fill();
    }
    for(const f of fires) {
      const fade=Math.min(1,f.life,(f.max-f.life+.6)/.6), fl=.9+Math.sin(now/90+f.x)*.1;
      gx.globalAlpha=.30*fade; gx.fillStyle='#ff6b35'; gx.beginPath(); gx.arc(f.x-camX,f.y-camY,f.r*fl,0,Math.PI*2); gx.fill();
      gx.globalAlpha=.35*fade; gx.fillStyle='#ffb36b'; gx.beginPath(); gx.arc(f.x-camX,f.y-camY,f.r*.55*fl,0,Math.PI*2); gx.fill();
    }
    for(const g of grenades) {
      const lift=Math.sin(Math.min(1,g.t/.45)*Math.PI)*20;
      gx.fillStyle='rgba(0,0,0,.4)'; gx.beginPath(); gx.arc(g.x-camX,g.y-camY+4,7,0,Math.PI*2); gx.fill();
      gx.fillStyle=types[g.type].color; gx.beginPath(); gx.arc(g.x-camX,g.y-camY-lift,5,0,Math.PI*2); gx.fill();
      gx.strokeStyle='#0c0e0f'; gx.lineWidth=1.5; gx.stroke();
    }
    gx.globalAlpha=1;
    if(blind>0 && api.G.state==='play') { gx.globalAlpha=Math.min(.95,blind); gx.fillStyle='#fff'; gx.fillRect(0,0,rect.width,rect.height); }
    gx.globalAlpha=1;
  }

  function loop(now) {
    const dt=Math.min(.05,(now-last)/1000); last=now;
    if(api.G.state==='play' && !api.G.over) {
      blind=Math.max(0,blind-dt);
      for(const c of clouds) c.life-=dt;
      for(const f of fires) {
        f.life-=dt; f.tick-=dt;
        if(f.tick<=0) { f.tick=.5; for(const e of api.ents) { if(!e.alive||(e.lv||0)!==f.lv||(e.lv&&e.bi!==f.bi)) continue; if(Math.hypot(e.x-f.x,e.y-f.y)<f.r) api.grenadeHurt(e,8,f.owner); } }
      }
      fires=fires.filter(f=>f.life>0);
      clouds=clouds.filter(c=>c.life>0);
      for(const e of api.ents) if(e.blind>0) { e.blind=Math.max(0,e.blind-dt); e.tgt=null; }
      for(let i=grenades.length-1;i>=0;i--) {
        const g=grenades[i]; g.t+=dt;
        const k=Math.min(1,g.t/.42); g.x=g.sx+(g.tx-g.sx)*k; g.y=g.sy+(g.ty-g.sy)*k;
        if(g.t>=g.fuse) { detonate(g); grenades.splice(i,1); }
      }
    }
    hud.style.display=api.G.state==='play'?'flex':'none';
    draw(now);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
