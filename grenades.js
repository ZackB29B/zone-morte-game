
(() => {
  'use strict';

  const api = window.__zm;
  if (!api) {
    console.error('[Zone Morte] API du jeu introuvable.');
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

  const CFG = {
    gravity: 920,
    throwSpeed: 390,
    throwLift: 390,
    bounce: 0.48,
    groundFriction: 0.78,
    wallFriction: 0.82,
    radius: 7,
    fuse: 2.1,
    flashRadius: 360,
    flashDuration: 3,
    smokeDuration: 9,
    smokeRadius: 190,
    fragRadius: 155,
    fragDamage: 155,
    fireRadius: 105,
    fireDamage: 8,
    fireDuration: 6
  };

  let selected = 0;
  let grenades = [];
  let fires = [];
  let clouds = [];
  let blind = 0;
  let last = performance.now();

  const style = document.createElement('style');
  style.textContent = `
    #grenadeHud {
      position:absolute;
      z-index:4;
      left:50%;
      bottom:16px;
      transform:translateX(-50%);
      display:flex;
      gap:6px;
      align-items:center;
      pointer-events:auto;
    }
    #grenadeHud button {
      font:600 16px "IBM Plex Mono",monospace;
      letter-spacing:.02em;
      text-transform:uppercase;
      color:#e7e1d3;
      background:rgba(12,14,15,.88);
      border:1px solid #3b454b;
      padding:7px 10px;
      cursor:pointer;
    }
    #grenadeHud button:hover {
      border-color:#d4a537;
      background:#1a1f22;
    }
    #grenadeLabel {
      min-width:128px;
      text-align:center;
      font-size:11px;
      color:#e7e1d3;
      background:rgba(12,14,15,.82);
      border:1px solid #3b454b;
      padding:7px 8px;
    }
    #grenadeLabel strong { color:#d4a537; }
    @media(max-width:640px) {
      #grenadeHud { bottom:16px; gap:4px; }
      #grenadeHud button { font-size:13px; padding:8px 7px; }
      #grenadeLabel { min-width:90px; font-size:9px; padding:7px 4px; }
    }
  `;
  document.head.appendChild(style);

  const stage = document.getElementById('stage');
  const gameCanvas = document.getElementById('c');

  if (!stage || !gameCanvas) {
    console.error('[Zone Morte] Canvas ou stage introuvable.');
    return;
  }

  const hud = document.createElement('div');
  hud.id = 'grenadeHud';
  hud.innerHTML = `
    <button type="button" id="grenadeCycle">G · TYPE</button>
    <div id="grenadeLabel"></div>
    <button type="button" id="grenadeThrow">LANCER</button>
  `;
  stage.appendChild(hud);

  const overlay = document.createElement('canvas');
  overlay.id = 'grenadeFx';

  Object.assign(overlay.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    zIndex: '2',
    pointerEvents: 'none'
  });

  stage.appendChild(overlay);

  const gx = overlay.getContext('2d');

  function setHud() {
    const key = keys[selected];
    const type = types[key];
    const total = keys.reduce((s, k) => s + inventory[k], 0);

    document.getElementById('grenadeLabel').innerHTML =
      `<strong>${type.label}</strong> · ${inventory[key]} restante${inventory[key] === 1 ? '' : 's'}<br><span style="opacity:.6">${total} au total</span>`;

    document.getElementById('grenadeCycle').style.borderColor = type.color;
  }

  function cycle() {
    for (let i = 1; i <= keys.length; i++) {
      const k = (selected + i) % keys.length;

      if (inventory[keys[k]] > 0) {
        selected = k;
        break;
      }
    }

    setHud();
  }

  function throwGrenade(screenX, screenY) {
    if (api.G.state !== 'play' || api.G.over) return;

    const player = api.ents[0];
    if (!player || !player.alive) return;

    const key = keys[selected];

    if (inventory[key] <= 0) {
      api.grenadeToast('Plus de ' + types[key].label.toLowerCase());
      return;
    }

    inventory[key]--;
    setHud();

    const rect = gameCanvas.getBoundingClientRect();

    const sx = screenX == null ? rect.width * .72 : screenX;
    const sy = screenY == null ? rect.height * .5 : screenY;

    const angle = Math.atan2(
      sy - rect.height / 2,
      sx - rect.width / 2
    );

    const speed = CFG.throwSpeed;

    grenades.push({
      type: key,
      x: player.x,
      y: player.y,
      z: 8,
      vz: -CFG.throwLift,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      t: 0,
      fuse: CFG.fuse,
      owner: player,
      lv: player.lv || 0,
      bi: player.bi,
      grounded: false,
      dead: false
    });
  }

  document.getElementById('grenadeCycle').addEventListener('click', cycle);
  document.getElementById('grenadeThrow').addEventListener('click', () => throwGrenade());

  window.addEventListener('zone-morte-grenade', e => {
    if (e.detail) throwGrenade(e.detail.x, e.detail.y);
  });

  window.addEventListener('keydown', e => {
    if (e.code === 'KeyG' && api.G.state === 'play' && !e.repeat) {
      cycle();
    }
  });

  setHud();

  function getObstacles() {
    return Array.isArray(api.obs) ? api.obs : [];
  }

  function obstacleAt(x, y, g) {
    const obs = getObstacles();

    return obs.find(o => {
      if (!o || o.dead || o.open) return false;
      if ((o.lv || 0) !== (g.lv || 0)) return false;

      const w = o.w || o.width || 0;
      const h = o.h || o.height || 0;

      return (
        x + CFG.radius > o.x &&
        x - CFG.radius < o.x + w &&
        y + CFG.radius > o.y &&
        y - CFG.radius < o.y + h
      );
    });
  }

  function clearPath(a, b) {
    const obs = getObstacles();

    if (!obs.length) return true;

    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 12);

    for (let i = 1; i < steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps;
      const y = a.y + (b.y - a.y) * i / steps;

      if (obs.some(o =>
        o &&
        !o.dead &&
        !o.open &&
        (o.lv || 0) === (a.lv || 0) &&
        x >= o.x &&
        x <= o.x + (o.w || o.width || 0) &&
        y >= o.y &&
        y <= o.y + (o.h || o.height || 0)
      )) {
        return false;
      }
    }

    return true;
  }

  // Une cible dans la fumée est invisible ; une ligne de vue qui traverse
  // le nuage est également bloquée, même si son milieu n'est pas dans la fumée.
  window.grenadeSmokeContains = entity => {
    if (!entity) return false;
    return clouds.some(c =>
      c.type === 'smoke' && c.life > 0 &&
      (c.lv || 0) === (entity.lv || 0) &&
      Math.hypot(entity.x - c.x, entity.y - c.y) < c.r * .9
    );
  };

  window.grenadeSmokeBlocks = (a, b) => {
    if (!a || !b) return false;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    return clouds.some(c => {
      if (c.type !== 'smoke' || c.life <= 0) return false;
      if ((c.lv || 0) !== (a.lv || 0) || (c.lv || 0) !== (b.lv || 0)) return false;
      const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
      const px = a.x + t * dx, py = a.y + t * dy;
      return Math.hypot(c.x - px, c.y - py) < c.r * .88;
    });
  };

  // Indique à l'IA une direction d'évitement quand elle se trouve près du feu.
  window.grenadeDangerAt = entity => {
    if (!entity) return null;
    let vx = 0, vy = 0, danger = false;
    for (const f of fires) {
      if ((f.lv || 0) !== (entity.lv || 0)) continue;
      if ((entity.lv || 0) && f.bi !== entity.bi) continue;
      const dx = entity.x - f.x, dy = entity.y - f.y;
      const d = Math.hypot(dx, dy) || 1;
      const range = f.r + 95;
      if (d < range) {
        const strength = (range - d) / range;
        vx += dx / d * strength;
        vy += dy / d * strength;
        danger = true;
      }
    }
    if (!danger) return null;
    const m = Math.hypot(vx, vy) || 1;
    return { x: vx / m, y: vy / m };
  };

  function addParticles(g, color, count = 18) {
    if (!api.grenadeGetParts) return;

    const parts = api.grenadeGetParts();

    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 35 + Math.random() * 180;

      parts.push({
        x: g.x,
        y: g.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: .35 + Math.random() * .5,
        col: color
      });
    }
  }

  function damageNearby(g, radius, damage) {
    for (const e of api.ents) {
      if (!e || !e.alive) continue;
      if ((e.lv || 0) !== (g.lv || 0)) continue;

      if (e.lv && e.bi !== g.bi) continue;

      const d = Math.hypot(e.x - g.x, e.y - g.y);

      if (d >= radius || !clearPath(g, e)) continue;

      const amount = damage * (1 - d / radius);

      if (amount > 0) {
        api.grenadeHurt(e, amount, g.owner);
      }
    }
  }

  function detonate(g) {
    if (g.dead) return;
    g.dead = true;

    const type = types[g.type];

    addParticles(g, type.color, 24);

    if (g.type === 'incend') {
      fires.push({
        x: g.x,
        y: g.y,
        r: CFG.fireRadius,
        life: CFG.fireDuration,
        max: CFG.fireDuration,
        tick: 0,
        lv: g.lv,
        bi: g.bi,
        owner: g.owner
      });

      api.grenadeToast('Incendiaire !');
      return;
    }

    if (g.type === 'smoke') {
      clouds.push({
        type: 'smoke',
        x: g.x,
        y: g.y,
        r: 15,
        maxR: CFG.smokeRadius,
        life: CFG.smokeDuration,
        max: CFG.smokeDuration,
        lv: g.lv
      });

      api.grenadeToast('Fumigène !');
      return;
    }

    if (g.type === 'flash') {
      for (const e of api.ents) {
        if (!e || !e.alive) continue;
        if ((e.lv || 0) !== g.lv) continue;

        const d = Math.hypot(e.x - g.x, e.y - g.y);

        if (d > CFG.flashRadius || !clearPath(g, e)) continue;

        const duration = CFG.flashDuration * (1 - d / (CFG.flashRadius * 1.25));

        if (e.bot) {
          e.blind = Math.max(e.blind || 0, duration);
          e.tgt = null;
        }

        if (e === api.ents[0]) {
          blind = Math.max(blind, duration);
        }
      }

      api.grenadeToast('Flash !');
      return;
    }

    if (g.type === 'lethal') {
      damageNearby(g, CFG.fragRadius, CFG.fragDamage);
      api.grenadeToast('Grenade mortelle !');
    }
  }

  function impact(g) {
    if (g.type === 'lethal' || g.type === 'incend') {
      detonate(g);
      return;
    }

    g.vz = Math.abs(g.vz) * CFG.bounce;

    if (g.vz < 75) {
      g.vz = 0;
      g.grounded = true;
    }

    g.vx *= CFG.groundFriction;
    g.vy *= CFG.groundFriction;
  }

  function updateGrenade(g, dt) {
    g.t += dt;

    const oldX = g.x;
    const oldY = g.y;

    g.vz += CFG.gravity * dt;
    g.z -= g.vz * dt;

    g.x += g.vx * dt;
    g.y += g.vy * dt;

    const hit = obstacleAt(g.x, g.y, g);

    if (hit) {
      if (g.type === 'lethal' || g.type === 'incend') {
        detonate(g);
        return;
      }

      const dx = g.x - oldX;
      const dy = g.y - oldY;

      if (Math.abs(dx) > Math.abs(dy)) {
        g.vx = -g.vx * CFG.bounce;
      } else {
        g.vy = -g.vy * CFG.bounce;
      }

      g.x = oldX;
      g.y = oldY;

      g.vx *= CFG.wallFriction;
      g.vy *= CFG.wallFriction;
    }

    if (g.z <= 0) {
      g.z = 0;

      if (!g.grounded || Math.abs(g.vz) > 40) {
        impact(g);
      } else {
        g.vz = 0;
        g.vx *= Math.pow(CFG.groundFriction, dt * 60);
        g.vy *= Math.pow(CFG.groundFriction, dt * 60);
      }
    }

    if (g.t >= g.fuse) {
      detonate(g);
    }
  }

  function updateEffects(dt) {
    blind = Math.max(0, blind - dt);

    for (const c of clouds) {
      c.life -= dt;

      const progress = 1 - c.life / c.max;
      c.r = Math.min(c.maxR, 15 + progress * c.maxR * 1.5);
    }

    clouds = clouds.filter(c => c.life > 0);

    for (const f of fires) {
      f.life -= dt;
      f.tick -= dt;

      if (f.tick <= 0) {
        f.tick = .5;

        for (const e of api.ents) {
          if (!e || !e.alive) continue;
          if ((e.lv || 0) !== f.lv) continue;
          if (e.lv && e.bi !== f.bi) continue;

          if (Math.hypot(e.x - f.x, e.y - f.y) < f.r) {
            api.grenadeHurt(e, CFG.fireDamage, f.owner);
          }
        }
      }
    }

    fires = fires.filter(f => f.life > 0);

    for (const e of api.ents) {
      if (!e) continue;
      if (e.blind > 0) {
        e.blind = Math.max(0, e.blind - dt);
        e.tgt = null;
        if (e.bot) e.lastSeen = null;
      }
      e.grenadeEvade = e.bot ? (window.grenadeDangerAt(e) || null) : null;
    }

    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];

      updateGrenade(g, dt);

      if (g.dead) grenades.splice(i, 1);
    }
  }

  function draw(now) {
    const rect = gameCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (
      overlay.width !== Math.round(rect.width * dpr) ||
      overlay.height !== Math.round(rect.height * dpr)
    ) {
      overlay.width = Math.round(rect.width * dpr);
      overlay.height = Math.round(rect.height * dpr);
    }

    gx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gx.clearRect(0, 0, rect.width, rect.height);

    const player = api.ents[0];
    if (!player) return;

    const camX = player.x - rect.width / 2;
    const camY = player.y - rect.height / 2;

    for (const c of clouds) {
      const fade = Math.min(1, c.life, (c.max - c.life + 1) / 1.2);

      gx.globalAlpha = .26 * fade;
      gx.fillStyle = '#b7c3c4';
      gx.beginPath();
      gx.arc(c.x - camX, c.y - camY, c.r, 0, Math.PI * 2);
      gx.fill();

      gx.globalAlpha = .18 * fade;
      gx.beginPath();
      gx.arc(c.x - camX - 35, c.y - camY + 12, c.r * .66, 0, Math.PI * 2);
      gx.fill();
    }

    for (const f of fires) {
      const fade = Math.min(1, f.life, (f.max - f.life + .6) / .6);
      const flicker = .9 + Math.sin(now / 90 + f.x) * .1;

      gx.globalAlpha = .30 * fade;
      gx.fillStyle = '#ff6b35';
      gx.beginPath();
      gx.arc(f.x - camX, f.y - camY, f.r * flicker, 0, Math.PI * 2);
      gx.fill();

      gx.globalAlpha = .35 * fade;
      gx.fillStyle = '#ffb36b';
      gx.beginPath();
      gx.arc(f.x - camX, f.y - camY, f.r * .55 * flicker, 0, Math.PI * 2);
      gx.fill();
    }

    for (const g of grenades) {
      const sx = g.x - camX;
      const sy = g.y - camY;
      const height = Math.max(0, g.z);

      gx.fillStyle = 'rgba(0,0,0,.4)';
      gx.beginPath();
      gx.ellipse(sx, sy + 4, 7, 4, 0, 0, Math.PI * 2);
      gx.fill();

      gx.fillStyle = types[g.type].color;
      gx.beginPath();
      gx.arc(sx, sy - height, 5, 0, Math.PI * 2);
      gx.fill();

      gx.strokeStyle = '#0c0e0f';
      gx.lineWidth = 1.5;
      gx.stroke();
    }

    // Effet de flash côté joueur : écran presque entièrement blanc au départ,
    // puis disparition progressive et douce pendant toute la durée de l'aveuglement.
    if (blind > 0 && api.G.state === 'play') {
      const progress = Math.max(0, Math.min(1, blind / CFG.flashDuration));
      const opacity = 0.98 * Math.pow(progress, 0.62);
      gx.globalAlpha = opacity;
      gx.fillStyle = '#fff';
      gx.fillRect(0, 0, rect.width, rect.height);
    }

    // Quand le joueur entre dans un nuage, une couche de fumée passe aussi
    // devant la caméra : voile gris, volutes lentes et bords légèrement voilés.
    if (api.G.state === 'play' && player.alive) {
      let smokeStrength = 0;
      for (const c of clouds) {
        if (c.type !== 'smoke' || c.life <= 0) continue;
        if ((c.lv || 0) !== (player.lv || 0)) continue;
        const distance = Math.hypot(player.x - c.x, player.y - c.y);
        const inside = Math.max(0, 1 - distance / (c.r * 1.08));
        const lifeFade = Math.min(1, c.life / 1.1);
        smokeStrength = Math.max(smokeStrength, inside * lifeFade);
      }

      if (smokeStrength > 0.02) {
        const strength = Math.min(1, smokeStrength);
        gx.save();
        gx.globalAlpha = 0.18 + strength * 0.30;
        gx.fillStyle = '#aeb9ba';
        gx.fillRect(0, 0, rect.width, rect.height);

        // Volutes semi-transparentes animées, dessinées en coordonnées écran.
        for (let i = 0; i < 7; i++) {
          const drift = now * (0.012 + i * 0.0015);
          const x = ((i * 173 + drift * (i % 2 ? 1 : -1)) % (rect.width + 240)) - 120;
          const y = rect.height * (0.12 + ((i * 37) % 76) / 100) + Math.sin(now / 850 + i * 1.7) * 22;
          const radius = Math.max(70, Math.min(rect.width, rect.height) * (0.20 + (i % 3) * 0.055));
          const grad = gx.createRadialGradient(x, y, 4, x, y, radius);
          grad.addColorStop(0, 'rgba(226,233,232,0.34)');
          grad.addColorStop(0.58, 'rgba(190,202,202,0.17)');
          grad.addColorStop(1, 'rgba(170,184,185,0)');
          gx.globalAlpha = strength * (0.38 + (i % 3) * 0.08);
          gx.fillStyle = grad;
          gx.beginPath();
          gx.ellipse(x, y, radius * 1.25, radius * 0.58, Math.sin(now / 1700 + i) * 0.22, 0, Math.PI * 2);
          gx.fill();
        }

        const vignette = gx.createRadialGradient(
          rect.width / 2, rect.height / 2, Math.min(rect.width, rect.height) * 0.12,
          rect.width / 2, rect.height / 2, Math.max(rect.width, rect.height) * 0.72
        );
        vignette.addColorStop(0, 'rgba(210,220,220,0)');
        vignette.addColorStop(1, 'rgba(105,119,121,0.32)');
        gx.globalAlpha = strength * 0.8;
        gx.fillStyle = vignette;
        gx.fillRect(0, 0, rect.width, rect.height);
        gx.restore();
      }
    }

    gx.globalAlpha = 1;
  }

  function loop(now) {
    const dt = Math.min(.05, (now - last) / 1000);
    last = now;

    if (api.G.state === 'play' && !api.G.over) {
      updateEffects(dt);
    }

    hud.style.display = api.G.state === 'play' ? 'flex' : 'none';

    draw(now);
    requestAnimationFrame(loop);
  }

  window.zmGrenades = {
    add(type, n) {
      if (inventory[type] === undefined) return;

      inventory[type] += n || 1;

      const i = keys.indexOf(type);
      if (inventory[keys[selected]] <= 0 && i >= 0) selected = i;

      setHud();
    }
  };

  window.ZoneMorteGrenades = {
    grenades,
    fires,
    clouds,
    config: CFG
  };

  requestAnimationFrame(loop);
})();
