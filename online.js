"use strict";
// Zone Morte — matchmaking, salons entre amis et relais de partie (Socket.IO).
// Le serveur ne simule pas le jeu : il regroupe les joueurs, donne la même graine
// de carte à tout le monde, relaie les positions/tirs/portes/coffres et vérifie
// les dégâts (portée, cadence, plafond) avant de les transmettre à la victime.
const crypto = require("crypto");

const MAXP = 16;           // joueurs max par partie
const MINP = 2;            // joueurs min pour lancer
const START_IN = 5;        // compte à rebours client (secondes)
const WEAPONS = new Set(["pistol", "pistol_mk2", "pistol_heavy", "rifle", "rifle_burst", "rifle_scar", "shotgun", "shotgun_auto", "sniper", "sniper_heavy"]);
const LOOT = new Set(["ammo", "med", "armor", "pistol", "rifle", "shotgun"]);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MODES = new Set(["br", "squad", "duel", "train"]);
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
  const MM_WAIT = opts.mmWait || 15000;
  const queue = [];                 // sockets en recherche
  const parties = new Map();        // code -> { code, members:[socket] }
  const matches = new Map();        // id -> match
  let mmTimer = null, mmDeadline = 0, online = 0;

  const eta = () => (mmDeadline ? Math.max(0, Math.ceil((mmDeadline - Date.now()) / 1000)) : null);
  function qBroadcast() { const e = eta(); for (const s of queue) s.emit("mm", { n: queue.length, min: MINP, eta: e }); }
  function qClear() { if (mmTimer) clearTimeout(mmTimer); mmTimer = null; mmDeadline = 0; }
  function qUpdate() {
    if (queue.length >= MAXP) { qClear(); launch(queue.splice(0, MAXP)); return qUpdate(); }
    if (queue.length >= MINP) {
      if (!mmTimer) {
        mmDeadline = Date.now() + MM_WAIT;
        mmTimer = setTimeout(() => { mmTimer = null; mmDeadline = 0; if (queue.length >= MINP) launch(queue.splice(0, MAXP)); qUpdate(); }, MM_WAIT);
        if (mmTimer.unref) mmTimer.unref();
      }
    } else qClear();
    qBroadcast();
  }
  function qRemove(s) { const i = queue.indexOf(s); if (i >= 0) { queue.splice(i, 1); s.emit("mm", null); qUpdate(); } }
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
    for (const s of list) { s.data.party = null; s.emit("mm", null); s.emit("party", null); }
    const id = crypto.randomBytes(5).toString("hex");
    const m = { id, room: "m:" + id, over: false, seed: crypto.randomInt(1, 2147483646), players: new Map() };
    for (const s of list) {
      s.data.match = id; s.join(m.room);
      m.players.set(s.id, { id: s.id, name: s.data.name, alive: true, left: false, x: null, y: null, hb: { t: Date.now(), n: 40 } });
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
    io.to(m.room).emit("match-end", { w: alive.length ? alive[0].id : null });
    const t = setTimeout(() => matches.delete(m.id), 60000); if (t.unref) t.unref();
  }
  function leaveMatch(s) {
    const m = matches.get(s.data.match); s.data.match = null;
    if (!m) return;
    const me = m.players.get(s.id); if (!me || me.left) return;
    me.left = true;
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

    socket.on("hello", (p, cb) => { setName(p); if (typeof cb === "function") cb({ id: socket.id, name: socket.data.name, account: !!acc, pop: online }); });

    socket.on("mm-join", p => {
      if (!allow() || socket.data.match) return;
      setName(p); leaveParty(socket);
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
      launch(party.members.slice(), party.mode);
    });
    socket.on("party-set-mode", p => {
      if (!allow() || !p) return;
      const party = parties.get(socket.data.party);
      if (!party || hostOf(party) !== socket || !MODES.has(p.mode)) return;
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
      me.x = x; me.y = y;
      socket.to(m.room).volatile.emit("st", { i: socket.id, x, y, a: num(p.a, -10, 10) || 0, l: p.l ? 1 : 0, b: int(p.b, -1, 500) ?? -1, c: WEAPONS.has(p.c) ? p.c : "pistol", r: p.r ? 1 : 0, ar: num(p.ar, 0, 100) || 0 });
    });
    socket.on("shot", p => {
      if (!allow() || !p) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id); if (!me || !me.alive || !WEAPONS.has(p.w)) return;
      const x = num(p.x, -1e4, 1e5), y = num(p.y, -1e4, 1e5), a = num(p.a, -10, 10); if (x === null || y === null || a === null) return;
      socket.to(m.room).emit("shot", { i: socket.id, x, y, a, w: p.w });
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
      socket.to(m.room).emit("pk", { id: String(p.id) });
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
      let d = num(p.d, .1, 1000); if (d === null) return;
      const dist = me.x === null || tg.x === null ? 0 : Math.hypot(me.x - tg.x, me.y - tg.y);
      if (knife) { if (dist > 140) return; d = 999; }
      else { d = Math.min(d, 160); if (dist > 950) return; }
      io.to(tg.id).emit("hit", { f: me.id, d, k: knife ? 1 : 0 });
    });
    socket.on("dead", p => {
      if (!allow()) return;
      const m = cur(); if (!m) return;
      const me = m.players.get(socket.id); if (!me || !me.alive) return;
      me.alive = false;
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
