"use strict";
// Zone Morte — matchmaking, salons entre amis et relais de partie (Socket.IO).
// Le serveur ne simule pas le jeu : il regroupe les joueurs, donne la même graine
// de carte à tout le monde, relaie les positions/tirs/portes/coffres et vérifie
// les dégâts (portée, cadence, plafond) avant de les transmettre à la victime.
const crypto = require("crypto");

const MAXP = 16;           // joueurs max par partie
const MINP = 2;            // joueurs min pour lancer
const START_IN = 5;        // compte à rebours client (secondes)
const WEAPONS = new Set(["pistol", "pistol_mk2", "pistol_heavy", "pistol_silenced", "smg_vector", "smg_mp5", "rifle", "rifle_burst", "rifle_scar", "rifle_aug", "rifle_lmg", "shotgun", "shotgun_auto", "shotgun_slug", "shotgun_tactical", "sniper", "sniper_heavy", "dmr_scout", "sniper_dragunov"]);
const LOOT = new Set(["ammo", "med", "armor", "grenade", "incend", "flash", "smoke", "pistol", "pistol_mk2", "pistol_heavy", "pistol_silenced", "smg_vector", "smg_mp5", "rifle", "rifle_burst", "rifle_scar", "rifle_aug", "rifle_lmg", "shotgun", "shotgun_auto", "shotgun_slug", "shotgun_tactical", "sniper", "sniper_heavy", "dmr_scout", "sniper_dragunov"]);
// Valeurs de référence serveur : elles empêchent un client de choisir librement ses dégâts.
const WEAPON_RULES = {
  // [dégâts par projectile, délai minimum entre tirs, portée maximale]
  pistol:[24,.30,560], pistol_mk2:[31,.36,590], pistol_heavy:[48,.55,620], pistol_silenced:[27,.25,640],
  smg_vector:[9,.055,460], smg_mp5:[12,.075,540], rifle:[13,.095,700], rifle_burst:[19,.16,760],
  rifle_scar:[17,.11,820], rifle_aug:[18,.105,860], rifle_lmg:[11,.065,760], shotgun:[10,.85,300],
  shotgun_auto:[7,.48,320], shotgun_slug:[62,.95,520], shotgun_tactical:[8,.62,340], sniper:[85,1.25,1250],
  sniper_heavy:[90,1.8,1500], dmr_scout:[68,.72,1080], sniper_dragunov:[82,.82,1180]
};
const WEAPON_AMMO = {
  pistol:[12,72,1], pistol_mk2:[15,90,1], pistol_heavy:[8,48,1], pistol_silenced:[17,102,1],
  smg_vector:[35,210,1], smg_mp5:[30,180,1], rifle:[30,180,1], rifle_burst:[24,144,1],
  rifle_scar:[36,216,1], rifle_aug:[30,180,1], rifle_lmg:[60,360,1],
  shotgun:[6,36,8], shotgun_auto:[10,60,7], shotgun_slug:[5,30,1], shotgun_tactical:[8,48,9],
  sniper:[5,30,1], sniper_heavy:[3,18,1], dmr_scout:[10,60,1], sniper_dragunov:[10,60,1]
};
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MODES = new Set(["br", "squad", "duel", "train", "ranked"]);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function num(v, lo, hi) { v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; }
function int(v, lo, hi) { v = num(v, lo, hi); return v === null ? null : Math.round(v); }
function cleanName(v, fallback) {
  if (typeof v !== "string") return fallback;
  const s = v.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 16);
  return s.length >= 2 ? s : fallback;
}

module.exports = function attachOnline(io, opts = {}) {
  const getAccount = opts.getAccount || (() => null);
  const getRank = opts.getRank || (async () => ({ rating: 1000, games: 0, wins: 0 }));
  const saveRank = opts.saveRank || (async () => false);
  const getLeaderboard = opts.getLeaderboard || (async () => []);
  const seasonId = () => { const d = new Date(); return d.getUTCFullYear() + "-S" + (Math.floor(d.getUTCMonth() / 3) + 1); };
  const divisionFor = score => score >= 2200 ? "Élite" : score >= 1800 ? "Diamant" : score >= 1500 ? "Or" : score >= 1200 ? "Argent" : "Bronze";
  const seasonPrize = division => ({
    "Bronze": { title: "Survivant Bronze", cosmeticToken: "season_bronze" },
    "Argent": { title: "Combattant Argent", cosmeticToken: "season_silver" },
    "Or": { title: "Vétéran Or", cosmeticToken: "season_gold" },
    "Diamant": { title: "Élite Diamant", cosmeticToken: "season_diamond" },
    "Élite": { title: "Légende de Zone Morte", cosmeticToken: "season_elite" }
  })[division];
  const rankInfo = async socket => {
    const name = getAccount(socket), season = seasonId();
    if (!name) return { eligible: false, rating: 1000, seasonRating: 0, season, games: 0, wins: 0, division: "Non classé", seasonRewards: [], seasonHistory: [] };
    let r = await getRank(name) || {};
    // À la première connexion d'une nouvelle saison, clôture la précédente et crédite sa récompense une seule fois.
    if (r.seasonId && r.seasonId !== season && Number(r.seasonGames) > 0) {
      const completedSeason = r.seasonId;
      const finalDivision = divisionFor(Math.max(0, Number(r.seasonRating) || 0));
      const rewards = Array.isArray(r.seasonRewards) ? r.seasonRewards.slice(-19) : [];
      if (!rewards.some(x => x && x.season === completedSeason)) {
        const prize = seasonPrize(finalDivision);
        rewards.push({ season: completedSeason, division: finalDivision, ...prize, awardedAt: Date.now() });
      }
      const history = Array.isArray(r.seasonHistory) ? r.seasonHistory.slice(-19) : [];
      if (!history.some(x => x && x.season === completedSeason)) history.push({ season: completedSeason, rating: Math.max(0, Number(r.seasonRating) || 0), games: Math.max(0, Number(r.seasonGames) || 0), wins: Math.max(0, Number(r.seasonWins) || 0), division: finalDivision });
      r = { ...r, seasonRewards: rewards, seasonHistory: history, previousSeasonId: completedSeason, previousSeasonDivision: finalDivision, seasonId: season, seasonRating: 0, seasonGames: 0, seasonWins: 0 };
      await saveRank(name, r);
    }
    const rating = Math.max(0, Math.min(5000, Math.round(Number(r.rating) || 1000)));
    return { eligible: true, rating, seasonRating: r.seasonId === season ? Math.max(0, Number(r.seasonRating) || 0) : 0, season, games: Math.max(0, Number(r.games) || 0), wins: Math.max(0, Number(r.wins) || 0), division: divisionFor(rating), seasonDivision: divisionFor(r.seasonRating || 0), seasonRewards: Array.isArray(r.seasonRewards) ? r.seasonRewards.slice(-5).reverse() : [], seasonHistory: Array.isArray(r.seasonHistory) ? r.seasonHistory.slice(-5).reverse() : [] };
  };
  const MM_WAIT = opts.mmWait || 15000;
  const queue = [];                 // sockets en recherche
  const parties = new Map();        // code -> { code, members:[socket] }
  const matches = new Map();        // id -> match
  let mmTimer = null, mmDeadline = 0, online = 0;

  const eta = () => (mmDeadline ? Math.max(0, Math.ceil((mmDeadline - Date.now()) / 1000)) : null);
  function eligibleGroup(mode) {
    const waiting = queue.filter(s => (s.data.mmMode || "br") === mode && s.connected);
    if (waiting.length < MINP) return [];
    if (mode !== "ranked") return waiting.slice(0, MAXP);
    const first = waiting[0], waited = Math.max(0, Date.now() - (first.data.mmJoinedAt || Date.now()));
    const tolerance = Math.min(1200, 250 + Math.floor(waited / 10000) * 150);
    const base = Number(first.data.mmRating) || 1000;
    return waiting.filter(s => Math.abs((Number(s.data.mmRating) || 1000) - base) <= tolerance).slice(0, MAXP);
  }
  function qBroadcast() {
    for (const s of queue) {
      const mode = s.data.mmMode || "br";
      const group = eligibleGroup(mode);
      s.emit("mm", { n: group.length, min: MINP, eta: eta(), mode, rating: s.data.mmRating ?? null, tolerance: mode === "ranked" ? Math.min(1200, 250 + Math.floor(Math.max(0, Date.now() - (s.data.mmJoinedAt || Date.now())) / 10000) * 150) : null });
    }
  }
  function qClear() { if (mmTimer) clearTimeout(mmTimer); mmTimer = null; mmDeadline = 0; }
  function qUpdate() {
    for (const mode of ["ranked", "br"]) {
      const group = eligibleGroup(mode);
      if (group.length >= MAXP) { qClear(); launch(group.slice(0, MAXP), mode); return qUpdate(); }
    }
    const canStart = ["ranked", "br"].some(mode => eligibleGroup(mode).length >= MINP);
    if (canStart && !mmTimer) {
      mmDeadline = Date.now() + MM_WAIT;
      mmTimer = setTimeout(() => {
        mmTimer = null; mmDeadline = 0;
        for (const mode of ["ranked", "br"]) {
          const group = eligibleGroup(mode);
          if (group.length >= MINP) { launch(group.slice(0, MAXP), mode); break; }
        }
        qUpdate();
      }, MM_WAIT);
      if (mmTimer.unref) mmTimer.unref();
    } else if (!canStart) qClear();
    qBroadcast();
  }
  function qRemove(s) { const i = queue.indexOf(s); if (i >= 0) { queue.splice(i, 1); s.data.mmMode = null; s.data.mmJoinedAt = 0; s.emit("mm", null); qUpdate(); } }
  const tick = setInterval(() => { if (queue.length) qBroadcast(); }, 1000);
  if (tick.unref) tick.unref();

  // ---- salons entre amis
  const hostOf = p => p.members.find(s => s.data.cid === p.hostCid) || p.members[0] || null;
  const pubParty = p => { const h = hostOf(p); return { code: p.code, mode: p.mode || "br", host: h ? h.id : null, members: p.members.map(s => ({ id: s.id, name: s.data.name })) }; };
  function dropParty(code) { const p = parties.get(code); if (p && p.expire) clearTimeout(p.expire); parties.delete(code); }
  function pBroadcast(p) { const d = pubParty(p); for (const s of p.members) s.emit("party", d); }
  // soft = déconnexion réseau (téléphone en veille, changement d'appli) : le salon de l'hôte est gardé 4 min
  // pour qu'il puisse revenir (party-resume) avec le même code.
  function leaveParty(s, soft) {
    const code = s.data.party; if (!code) return;
    s.data.party = null; if (!soft) s.emit("party", null);
    const p = parties.get(code); if (!p) return;
    const wasHost = s.data.cid === p.hostCid;
    p.members = p.members.filter(x => x !== s);
    if (soft && wasHost) {
      if (p.expire) clearTimeout(p.expire);
      p.expire = setTimeout(() => {
        p.expire = null;
        if (!parties.has(code) || p.members.some(x => x.data.cid === p.hostCid)) return;
        if (!p.members.length) return dropParty(code);
        p.hostCid = p.members[0].data.cid; pBroadcast(p);
      }, 240000);
      if (p.expire.unref) p.expire.unref();
      if (p.members.length) pBroadcast(p);
      return;
    }
    if (!p.members.length) return dropParty(code);
    if (wasHost) p.hostCid = p.members[0].data.cid;
    pBroadcast(p);
  }
  function newCode() { for (;;) { let c = ""; for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!parties.has(c)) return c; } }

  // ---- parties
  function launch(list, mode) {
    const dropped = new Set();
    for (const s of list) {
      const i = queue.indexOf(s); if (i >= 0) queue.splice(i, 1);
      if (s.data.party && !dropped.has(s.data.party)) { dropped.add(s.data.party); dropParty(s.data.party); }
    }
    for (const s of list) { s.data.party = null; s.data.mmMode = null; s.data.mmJoinedAt = 0; s.emit("mm", null); s.emit("party", null); }
    const id = crypto.randomBytes(5).toString("hex");
    const m = { id, room: "m:" + id, mode: mode || "br", over: false, seed: crypto.randomInt(1, 2147483646), players: new Map(), lootClaims: new Set() };
    for (const s of list) {
      s.data.match = id; s.join(m.room);
      m.players.set(s.id, { id: s.id, name: s.data.name, account: getAccount(s) || null, alive: true, downed: false, bleedTimer: null, left: false, x: null, y: null, moveAt: 0, weapon: "pistol", hb: { t: Date.now(), n: 40 }, lastWeaponHit: Object.create(null),
      ammo: { pistol: { mag: 12, reserve: 72 } }, reloadUntil: Object.create(null),
      lastShotAt: Object.create(null), shotCredits: Object.create(null), claimedLoot: new Set() });
    }
    matches.set(id, m);
    const players = [...m.players.values()].map(p => ({ id: p.id, name: p.name }));
    for (const s of list) s.emit("match-start", { seed: m.seed, players, startIn: START_IN, mode: mode || "br" });
  }
  function checkEnd(m) {
    if (m.over) return;
    const alive = [...m.players.values()].filter(p => p.alive);
    if (alive.length > 1) return;
    m.over = true;
    const winner = alive.length ? alive[0].id : null;
    if (m.mode === "ranked" && !m.rankedSettled) {
      m.rankedSettled = true;
      const rows = [...m.players.values()].filter(p => !p.left);
      Promise.all(rows.map(async p => {
        const account = p.account;
        if (!account) return { id: p.id, rating: null, delta: 0, division: "Non classé" };
        const before = await getRank(account); const oldRating = Math.max(0, Math.round(Number(before && before.rating) || 1000));
        const season = seasonId(), sameSeason = before && before.seasonId === season;
        const oldSeason = sameSeason ? Math.max(0, Number(before.seasonRating) || 0) : 0;
        const won = p.id === winner; const delta = won ? 25 : -15; const rating = Math.max(0, Math.min(5000, oldRating + delta));
        const seasonRating = Math.max(0, Math.min(5000, oldSeason + delta));
        let seasonRewards = Array.isArray(before && before.seasonRewards) ? before.seasonRewards.slice(-19) : [];
        let seasonHistory = Array.isArray(before && before.seasonHistory) ? before.seasonHistory.slice(-19) : [];
        if (!sameSeason && before && before.seasonId && Number(before.seasonGames) > 0 && !seasonRewards.some(x => x && x.season === before.seasonId)) {
          const oldDivision = divisionFor(Math.max(0, Number(before.seasonRating) || 0));
          seasonRewards.push({ season: before.seasonId, division: oldDivision, ...seasonPrize(oldDivision), awardedAt: Date.now() });
          seasonHistory.push({ season: before.seasonId, rating: Math.max(0, Number(before.seasonRating) || 0), games: Math.max(0, Number(before.seasonGames) || 0), wins: Math.max(0, Number(before.seasonWins) || 0), division: oldDivision });
        }
        await saveRank(account, { ...(before || {}), seasonRewards, seasonHistory, rating, seasonRating, seasonId: season, seasonGames: (sameSeason ? Number(before.seasonGames) || 0 : 0) + 1, seasonWins: (sameSeason ? Number(before.seasonWins) || 0 : 0) + (won ? 1 : 0), games: (Number(before && before.games) || 0) + 1, wins: (Number(before && before.wins) || 0) + (won ? 1 : 0), updatedAt: Date.now() });
        return { id: p.id, rating, seasonRating, delta, division: rating >= 2200 ? "Élite" : rating >= 1800 ? "Diamant" : rating >= 1500 ? "Or" : rating >= 1200 ? "Argent" : "Bronze" };
      })).then(results => io.to(m.room).emit("ranked-result", { results })).catch(err => console.error("Classement non sauvegardé:", err));
    }
    io.to(m.room).emit("match-end", { w: winner });
    const t = setTimeout(() => matches.delete(m.id), 60000); if (t.unref) t.unref();
  }
  function leaveMatch(s) {
    const m = matches.get(s.data.match); s.data.match = null;
    if (!m) return;
    const me = m.players.get(s.id); if (!me || me.left) return;
    me.left = true;
    if (me.bleedTimer) clearTimeout(me.bleedTimer); me.bleedTimer = null;
    const wasAlive = me.alive; me.alive = false;
    s.leave(m.room);
    if (wasAlive) s.to(m.room).emit("gone", { i: s.id });
    if ([...m.players.values()].every(p => p.left)) { matches.delete(m.id); return; }
    checkEnd(m);
  }

  io.on("connection", socket => {
    socket.data = socket.data || {};
    const acc = getAccount(socket) || null;
    socket.data.name = acc || "Invité-" + String(socket.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 4);
    socket.data.party = null; socket.data.match = null;
    { const c = socket.handshake && socket.handshake.auth && socket.handshake.auth.cid; socket.data.cid = ID_RE.test(String(c)) ? String(c) : socket.id; }
    const bucket = { t: Date.now(), n: 120 };
    const allow = () => { const t = Date.now(); bucket.n = Math.min(120, bucket.n + (t - bucket.t) * .12); bucket.t = t; if (bucket.n < 1) return false; bucket.n--; return true; };
    const setName = p => { if (!acc && p && typeof p === "object") socket.data.name = cleanName(p.name, socket.data.name); };
    online++; io.emit("pop", { n: online });

    socket.on("hello", (p, cb) => { setName(p); if (typeof cb === "function") cb({ id: socket.id, name: socket.data.name, account: !!acc, pop: online }); rankInfo(socket).then(r => socket.emit("ranked-info", r)).catch(() => {}); });
    socket.on("ranked-leaderboard", async () => {
      try { const season = seasonId(); const rows = await getLeaderboard(season); socket.emit("ranked-leaderboard", { season, rows: Array.isArray(rows) ? rows : [] }); }
      catch (err) { socket.emit("ranked-leaderboard", { season: seasonId(), rows: [], error: "Classement momentanément indisponible." }); }
    });

    socket.on("mm-join", async p => {
      if (!allow() || socket.data.match) return;
      setName(p); leaveParty(socket);
      const mode = p && p.mode === "ranked" ? "ranked" : "br";
      if (mode === "ranked" && !getAccount(socket)) { socket.emit("ranked-error", { message: "Le matchmaking classé exige un compte connecté." }); return; }
      qRemove(socket);
      socket.data.mmMode = mode;
      socket.data.mmJoinedAt = Date.now();
      if (mode === "ranked") {
        try { const r = await getRank(getAccount(socket)); socket.data.mmRating = Math.max(0, Math.min(5000, Math.round(Number(r && r.rating) || 1000))); }
        catch { socket.data.mmRating = 1000; }
      } else socket.data.mmRating = null;
      if (!queue.includes(socket)) queue.push(socket);
      qUpdate();
    });
    socket.on("mm-leave", () => qRemove(socket));

    socket.on("party-create", (p, cb) => {
      const reply = typeof cb === "function" ? cb : () => {};
      if (!allow() || socket.data.match) return reply({ ok: false, error: "Action impossible." });
      setName(p); qRemove(socket); leaveParty(socket);
      const party = { code: newCode(), mode: "br", members: [socket], hostCid: socket.data.cid, expire: null };
      parties.set(party.code, party); socket.data.party = party.code;
      console.log("[salon] créé " + party.code + " pid=" + process.pid);
      reply({ ok: true, party: pubParty(party) }); pBroadcast(party);
    });
    socket.on("party-join", (p, cb) => {
      const reply = typeof cb === "function" ? cb : () => {};
      if (!allow() || socket.data.match) return reply({ ok: false, error: "Action impossible." });
      setName(p);
      const code = String((p && p.code) || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      const party = parties.get(code);
      if (!party) { console.log("[salon] introuvable: reçu=" + JSON.stringify(p && p.code) + " nettoyé=" + code + " salons=" + [...parties.keys()].join(",") + " pid=" + process.pid); return reply({ ok: false, error: "Salon introuvable." }); }
      if (party.members.length >= MAXP) return reply({ ok: false, error: "Salon complet." });
      qRemove(socket); if (socket.data.party !== code) leaveParty(socket);
      if (!party.members.includes(socket)) party.members.push(socket);
      socket.data.party = code;
      reply({ ok: true, party: pubParty(party) }); pBroadcast(party);
    });
    socket.on("party-resume", (p, cb) => {
      const reply = typeof cb === "function" ? cb : () => {};
      if (!allow() || socket.data.match) return reply({ ok: false, error: "Action impossible." });
      setName(p);
      const code = String((p && p.code) || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      const party = parties.get(code);
      if (!party) return reply({ ok: false, error: "Salon expiré." });
      qRemove(socket); if (socket.data.party && socket.data.party !== code) leaveParty(socket);
      if (!party.members.includes(socket)) { if (socket.data.cid === party.hostCid) party.members.unshift(socket); else party.members.push(socket); }
      if (socket.data.cid === party.hostCid && party.expire) { clearTimeout(party.expire); party.expire = null; }
      socket.data.party = code;
      reply({ ok: true, party: pubParty(party) }); pBroadcast(party);
    });
    socket.on("party-leave", () => leaveParty(socket));
    socket.on("party-start", () => {
      if (!allow()) return;
      const party = parties.get(socket.data.party);
      if (!party || hostOf(party) !== socket || party.members.length < MINP) return;
      if (party.mode === "ranked" && party.members.some(s => !getAccount(s))) { socket.emit("ranked-error", { message: "Le mode classé exige un compte connecté pour chaque joueur." }); return; }
      launch(party.members.slice(), party.mode);
    });
    socket.on("party-set-mode", p => {
      if (!allow() || !p) return;
      const party = parties.get(socket.data.party);
      if (!party || hostOf(party) !== socket || !MODES.has(p.mode)) return;
      if (p.mode === "ranked" && party.members.some(s => !getAccount(s))) { socket.emit("ranked-error", { message: "Le mode classé exige un compte connecté pour chaque joueur." }); return; }
      party.mode = p.mode;
      for (const s of party.members) s.emit("party-mode", { mode: party.mode });
      pBroadcast(party);
    });

    // ---- en partie
    const cur = () => { const m = matches.get(socket.data.match); return m && !m.over ? m : null; };
    socket.on("st", p => {
      if (!allow() || !p) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id); if (!me || !me.alive) return;
      const x = num(p.x, -1e4, 1e5), y = num(p.y, -1e4, 1e5); if (x === null || y === null) return;
      const now = Date.now();
      if (me.x !== null && me.y !== null && me.moveAt) {
        const elapsed = Math.min(1.25, Math.max(.016, (now - me.moveAt) / 1000));
        // Le jeu autorise 215 unités/s en marche et 300 en sprint. Une marge
        // absorbe les à-coups réseau sans accepter les téléportations répétées.
        const maxStep = (me.downed ? 105 : 300) * elapsed * 1.4 + 22;
        if (Math.hypot(x - me.x, y - me.y) > maxStep) return;
      }
      me.x = x; me.y = y; me.moveAt = now;
      me.weapon = WEAPONS.has(p.c) ? p.c : me.weapon;
      if (!me.ammo[me.weapon]) {
        const spec = WEAPON_AMMO[me.weapon];
        if (spec) me.ammo[me.weapon] = { mag: spec[0], reserve: spec[1] };
      }
      socket.to(m.room).volatile.emit("st", { i: socket.id, x, y, d: me.downed ? 1 : 0, a: num(p.a, -10, 10) || 0, l: p.l ? 1 : 0, b: int(p.b, -1, 500) ?? -1, c: me.weapon, r: p.r ? 1 : 0, ar: num(p.ar, 0, 100) || 0 });
    });
    socket.on("shot", p => {
      if (!allow() || !p) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id);
      if (!me || !me.alive || !WEAPONS.has(p.w) || me.weapon !== p.w) return;
      const spec = WEAPON_AMMO[p.w], rule = WEAPON_RULES[p.w];
      if (!spec || !rule) return;
      const x = num(p.x, -1e4, 1e5), y = num(p.y, -1e4, 1e5), a = num(p.a, -10, 10);
      if (x === null || y === null || a === null || me.x === null) return;
      if (Math.hypot(x - me.x, y - me.y) > 85) return;
      const now = Date.now(), last = me.lastShotAt[p.w] || 0;
      if (now - last < rule[1] * 800) return;
      const ammo = me.ammo[p.w] || (me.ammo[p.w] = { mag: spec[0], reserve: spec[1] });
      if (me.reloadUntil[p.w] && now < me.reloadUntil[p.w]) return;
      if (ammo.mag <= 0) return;
      ammo.mag--; me.lastShotAt[p.w] = now;
      me.shotCredits[p.w] = { count: spec[2], expires: now + 420 };
      socket.to(m.room).emit("shot", { i: socket.id, x, y, a, w: p.w });
    });
    socket.on("reload", p => {
      if (!allow() || !p || !WEAPONS.has(p.w)) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id);
      if (!me || !me.alive || me.weapon !== p.w) return;
      const spec = WEAPON_AMMO[p.w]; if (!spec) return;
      const ammo = me.ammo[p.w] || (me.ammo[p.w] = { mag: spec[0], reserve: spec[1] });
      const rule = WEAPON_RULES[p.w];
      if (ammo.mag >= spec[0] || ammo.reserve <= 0 || (me.reloadUntil[p.w] || 0) > Date.now()) return;
      const reloadMs = Math.max(850, Math.min(3200, spec[0] * 35 + rule[1] * 300));
      me.reloadUntil[p.w] = Date.now() + reloadMs;
      setTimeout(() => {
        if (!matches.has(m.id) || me.left || !me.alive) return;
        const state = me.ammo[p.w]; if (!state) return;
        const loaded = Math.min(spec[0] - state.mag, state.reserve);
        state.mag += loaded; state.reserve -= loaded; me.reloadUntil[p.w] = 0;
        io.to(me.id).emit("reload-ok", { w: p.w, loaded, mag: state.mag, reserve: state.reserve });
      }, reloadMs);
    });
    socket.on("door", p => {
      if (!allow() || !p) return;
      const m = cur(); if (!m) return;
      const i = int(p.i, 0, 20000); if (i === null || (p.t !== "o" && p.t !== "b")) return;
      socket.to(m.room).emit("door", { i, t: p.t });
    });
    socket.on("pk", p => {
      if (!allow() || !p || !ID_RE.test(String(p.id))) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id);
      const x = num(p.x, -1e4, 1e5), y = num(p.y, -1e4, 1e5);
      if (!me || !me.alive || me.x === null || x === null || y === null) return;
      if (Math.hypot(x - me.x, y - me.y) > 90) return;
      const id = String(p.id);
      if (m.lootClaims.has(id)) return;
      m.lootClaims.add(id);
      socket.to(m.room).emit("pk", { id });
    });
    socket.on("wd", p => {
      if (!allow() || !p || !WEAPONS.has(p.k) || !ID_RE.test(String(p.id))) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id); if (!me || !me.alive) return;
      const x = num(p.x, -1e4, 1e5), y = num(p.y, -1e4, 1e5);
      if (x === null || y === null) return;
      socket.to(m.room).emit("wd", { x, y, k: p.k, lv: p.lv ? 1 : 0, bi: int(p.bi, -1, 500) ?? -1, id: String(p.id) });
    });
    socket.on("ch", p => {
      if (!allow() || !p) return;
      const m = cur(); if (!m) return;
      const i = int(p.i, 0, 5000), s = int(p.s, 1, 2147483647); if (i === null || s === null) return;
      socket.to(m.room).emit("ch", { i, s });
    });
    socket.on("hit", p => {
      if (!allow() || !p) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id), tg = m.players.get(String(p.t));
      if (!me || !tg || !me.alive || !tg.alive || tg === me) return;
      const t = Date.now(); me.hb.n = Math.min(40, me.hb.n + (t - me.hb.t) * .04); me.hb.t = t; if (me.hb.n < 1) return; me.hb.n--;
      const knife = p.k === 1;
      if (me.x === null || tg.x === null) return;
      const dist = Math.hypot(me.x - tg.x, me.y - tg.y);
      let d;
      if (knife) {
        if (dist > 140) return;
        d = 999;
      } else {
        const rule = WEAPON_RULES[p.w];
        if (!rule || me.weapon !== p.w || dist > rule[2]) return;
        // Les dégâts sont déterminés par le serveur, jamais par le client.
        d = rule[0];
        const credit = me.shotCredits[p.w], now = Date.now();
        if (!credit || credit.expires < now || credit.count <= 0) return;
        credit.count--;
        if (!credit.count) delete me.shotCredits[p.w];
      }
      io.to(tg.id).emit("hit", { f: me.id, d, k: knife ? 1 : 0 });
    });
    socket.on("down", () => {
      if (!allow()) return;
      const m = cur(); if (!m || m.mode !== "squad") return;
      const me = m.players.get(socket.id); if (!me || !me.alive || me.downed) return;
      me.downed = true;
      if (me.bleedTimer) clearTimeout(me.bleedTimer);
      me.bleedTimer = setTimeout(() => {
        if (!matches.has(m.id) || !me.alive || !me.downed) return;
        me.alive = false; me.downed = false; me.bleedTimer = null;
        io.to(m.room).emit("dead", { i: me.id, b: null, dr: [] });
        checkEnd(m);
      }, 25000);
      if (me.bleedTimer.unref) me.bleedTimer.unref();
      io.to(m.room).emit("downed", { i: me.id, seconds: 25 });
    });
    socket.on("revive", p => {
      if (!allow() || !p) return;
      const m = cur(); if (!m || m.mode !== "squad") return;
      const reviver = m.players.get(socket.id), target = m.players.get(String(p.t));
      if (!reviver || !target || !reviver.alive || reviver.downed || !target.alive || !target.downed || target === reviver) return;
      if (reviver.x === null || target.x === null || Math.hypot(reviver.x-target.x, reviver.y-target.y) > 105) return;
      if (target.bleedTimer) clearTimeout(target.bleedTimer);
      target.bleedTimer = null; target.downed = false;
      io.to(m.room).emit("revived", { i: target.id, by: reviver.id });
    });
    socket.on("dead", p => {
      if (!allow()) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id); if (!me || !me.alive) return;
      me.alive = false; me.downed = false;
      if (me.bleedTimer) clearTimeout(me.bleedTimer); me.bleedTimer = null;
      const by = p && typeof p.b === "string" && p.b !== socket.id && m.players.has(p.b) ? p.b : null;
      const dr = [];
      if (p && Array.isArray(p.dr)) for (const d of p.dr.slice(0, 4)) {
        if (!d || !LOOT.has(d.k) || !ID_RE.test(String(d.id))) continue;
        const x = num(d.x, -1e4, 1e5), y = num(d.y, -1e4, 1e5); if (x === null || y === null) continue;
        dr.push({ x, y, k: d.k, lv: d.lv ? 1 : 0, bi: int(d.bi, -1, 500) ?? -1, id: String(d.id) });
      }
      socket.to(m.room).emit("dead", { i: socket.id, b: by, dr });
      checkEnd(m);
    });
    socket.on("leave-match", () => leaveMatch(socket));
    socket.on("disconnect", () => {
      online = Math.max(0, online - 1); io.emit("pop", { n: online });
      const i = queue.indexOf(socket); if (i >= 0) { queue.splice(i, 1); qUpdate(); }
      leaveParty(socket, true); leaveMatch(socket);
    });
  });

  return { stats: () => ({ online, queue: queue.length, parties: parties.size, matches: matches.size }) };
};
