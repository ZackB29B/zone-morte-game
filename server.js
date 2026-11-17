
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.AUTH_DATA_DIR || path.join(__dirname, "data");
const usersFile = path.join(dataDir, "users.json");
const scrypt = promisify(crypto.scrypt);

app.use(express.json({ limit: "10kb" }));

// Comptes persistés sur disque.
let users = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(usersFile, "utf8"));
  if (Array.isArray(saved)) users = new Map(saved.map(user => [user.usernameKey, user]));
} catch (error) {
  if (error.code !== "ENOENT") console.error("Impossible de lire la base de comptes:", error.message);
}
let usersWriteQueue = Promise.resolve();
function persistUsers() {
  usersWriteQueue = usersWriteQueue.then(async () => {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const temp = usersFile + ".tmp";
    await fs.promises.writeFile(temp, JSON.stringify([...users.values()]), { mode: 0o600 });
    await fs.promises.rename(temp, usersFile);
  });
  return usersWriteQueue;
}

const sessions = new Map();
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const authAttempts = new Map();

function getCookie(req, name) {
  const entry = (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : "";
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `zm_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
}

function currentUser(req) {
  const token = getCookie(req, "zm_session");
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.username;
}

function authRateLimited(req) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  let item = authAttempts.get(ip);
  if (!item || item.until <= now) item = { count: 0, until: now + 15 * 60 * 1000 };
  item.count++;
  authAttempts.set(ip, item);
  return item.count > 20;
}

function issueSession(res, username) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_MS });
  setSessionCookie(res, token);
}

app.post("/api/auth/register", async (req, res) => {
  try {
    if (authRateLimited(req)) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";

    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Le pseudo doit contenir 3 à 20 caractères (lettres, chiffres ou _)." });
    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 128) return res.status(400).json({ error: "Le mot de passe doit contenir entre 8 et 128 caractères." });
    if (password !== confirmPassword) return res.status(400).json({ error: "Les mots de passe ne correspondent pas." });

    const usernameKey = username.toLowerCase();
    if (users.has(usernameKey)) return res.status(409).json({ error: "Ce pseudo est déjà utilisé." });

    const salt = crypto.randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);

    if (users.has(usernameKey)) return res.status(409).json({ error: "Ce pseudo est déjà utilisé." });

    users.set(usernameKey, {
      username,
      usernameKey,
      salt: salt.toString("hex"),
      passwordHash: passwordHash.toString("hex")
    });

    await persistUsers();
    issueSession(res, username);
    res.status(201).json({ username });
  } catch (error) {
    console.error("Erreur inscription:", error);
    res.status(500).json({ error: "Impossible de créer le compte pour le moment." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    if (authRateLimited(req)) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });

    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = users.get(username.toLowerCase());

    if (!user || Buffer.byteLength(password, "utf8") > 128) {
      return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
    }

    const candidate = await scrypt(password, Buffer.from(user.salt, "hex"), 64);
    const expected = Buffer.from(user.passwordHash, "hex");

    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
    }

    issueSession(res, user.username);
    res.json({ username: user.username });
  } catch (error) {
    console.error("Erreur connexion:", error);
    res.status(500).json({ error: "Impossible de se connecter pour le moment." });
  }
});

app.get("/api/auth/me", (req, res) => {
  const username = currentUser(req);
  if (!username) return res.status(401).json({ error: "Non connecté." });
  res.json({ username });
});

app.post("/api/auth/logout", (req, res) => {
  sessions.delete(getCookie(req, "zm_session"));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `zm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  res.json({ ok: true });
});

// Page de jeu et intégration de la fonctionnalité grenade.
app.get("/", (_req, res) => {
  const publicIndex = path.join(publicDir, "index.html");
  const rootIndex = path.join(__dirname, "index.html");
  const indexPath = fs.existsSync(publicIndex) ? publicIndex : rootIndex;

  let html = fs.readFileSync(indexPath, "utf8");

  const apiMarker = "start, update, get zone()";
  const apiBridge = "start, update, grenadeHurt: hurt, grenadeToast: toast, grenadeGetParts: () => parts, grenadeHitObs: hitObs, get zone()";

  if (html.includes(apiMarker)) html = html.replace(apiMarker, apiBridge);

  const mouseMarker = "} else { M.down = true; M.x = x; M.y = y; }";
  const mouseBridge = "} else if (e.button === 2) { e.preventDefault(); M.down = false; window.dispatchEvent(new CustomEvent('zone-morte-grenade', { detail: { x, y } })); } else { M.down = true; M.x = x; M.y = y; }";

  if (html.includes(mouseMarker)) html = html.replace(mouseMarker, mouseBridge);

  if (!html.includes("cv.addEventListener('contextmenu', e => e.preventDefault());")) {
    html = html.replace("</script>", "cv.addEventListener('contextmenu', e => e.preventDefault());\n</script>");
  }

  html += '\n<script src="/grenades.js?v=4"></script>\n';
  res.type("html").send(html);
});

app.use(express.static(publicDir));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "jeu-multijoueur" }));

// Salons multijoueurs : équipes, chat et présence.
const rooms = new Map();
const ROOM_LIMIT = 25;
const TEAM_NAMES = ["A", "B"];
const CHAT_LIMIT = 180;

const cleanRoomId = value =>
  typeof value === "string" && /^[A-Z0-9]{6}$/.test(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : null;

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    team: p.team,
    ready: !!p.ready
  }));
}

function publishRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  io.to(roomId).emit("lobby-state", {
    code: roomId,
    hostId: room.hostId,
    players: publicPlayers(room),
    count: room.players.size,
    max: ROOM_LIMIT,
    started: room.started
  });
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join("");
  } while (rooms.has(code));

  return code;
}

function safeName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name.replace(/[<>\u0000-\u001f]/g, "").slice(0, 20) || "Combattant";
}

io.on("connection", socket => {
  let currentRoom = null;
  let chatAt = 0;

  const cookieReq = {
    headers: { cookie: socket.handshake.headers.cookie || "" }
  };

  const accountName = currentUser(cookieReq);
  const displayName = safeName(accountName || (socket.handshake.auth && socket.handshake.auth.name));

  function leaveCurrentRoom() {
    if (!currentRoom) return;

    const code = currentRoom;
    const room = rooms.get(code);

    socket.leave(code);

    if (room) {
      room.players.delete(socket.id);

      if (!room.players.size) {
        rooms.delete(code);
      } else {
        if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
        publishRoom(code);
        io.to(code).emit("system-message", {
          text: displayName + " a quitté le salon."
        });
      }
    }

    currentRoom = null;
  }

  function joinRoom(code, callback) {
    const roomId = cleanRoomId(code);
    const room = roomId && rooms.get(roomId);

    if (!room) return callback?.({ ok: false, error: "Salon introuvable. Vérifie le code d'invitation." });
    if (room.started) return callback?.({ ok: false, error: "La partie a déjà commencé. Rejoins un nouveau salon." });
    if (room.players.size >= ROOM_LIMIT) return callback?.({ ok: false, error: "Ce salon est complet (25 joueurs maximum)." });

    leaveCurrentRoom();

    const teamA = [...room.players.values()].filter(p => p.team === "A").length;
    const teamB = [...room.players.values()].filter(p => p.team === "B").length;

    const player = {
      id: socket.id,
      name: displayName,
      team: teamA <= teamB ? "A" : "B",
      ready: false,
      x: 0,
      y: 0
    };

    room.players.set(socket.id, player);
    currentRoom = roomId;
    socket.join(roomId);

    callback?.({ ok: true, code: roomId, playerId: socket.id });
    publishRoom(roomId);

    socket.to(roomId).emit("system-message", {
      text: displayName + " a rejoint le salon."
    });
  }

  socket.on("create-room", callback => {
    leaveCurrentRoom();

    const code = makeRoomCode();
    const room = {
      hostId: socket.id,
      players: new Map(),
      started: false,
      seed: crypto.randomInt(1, 0x7fffffff),
      createdAt: Date.now()
    };

    rooms.set(code, room);
    joinRoom(code, callback);
  });

  socket.on("join-room", (code, callback) => joinRoom(code, callback));

  socket.on("choose-team", (team, callback) => {
    const room = currentRoom && rooms.get(currentRoom);
    const player = room && room.players.get(socket.id);

    if (!player || !TEAM_NAMES.includes(team)) return callback?.({ ok: false });

    const count = [...room.players.values()].filter(p => p.team === team).length;

    if (player.team !== team && count >= Math.ceil(ROOM_LIMIT / 2)) {
      return callback?.({ ok: false, error: "Cette équipe est complète." });
    }

    player.team = team;
    publishRoom(currentRoom);
    callback?.({ ok: true });
  });

  socket.on("chat-message", raw => {
    const room = currentRoom && rooms.get(currentRoom);
    if (!room || typeof raw !== "string") return;

    const now = Date.now();
    if (now - chatAt < 650) return;
    chatAt = now;

    const message = raw.trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, CHAT_LIMIT);
    if (!message) return;

    io.to(currentRoom).emit("chat-message", {
      id: socket.id,
      name: displayName,
      text: message,
      at: now
    });
  });

  socket.on("start-room-game", callback => {
    const room = currentRoom && rooms.get(currentRoom);

    if (!room || room.hostId !== socket.id) {
      return callback?.({ ok: false, error: "Seul le chef du salon peut lancer la partie." });
    }

    room.started = true;
    publishRoom(currentRoom);

    const roster = [...room.players.values()].map((p, i) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      x: 2500 + Math.cos(i * Math.PI * 2 / Math.max(1, room.players.size)) * 900,
      y: 2500 + Math.sin(i * Math.PI * 2 / Math.max(1, room.players.size)) * 900
    }));

    io.to(currentRoom).emit("room-game-start", {
      seed: room.seed,
      players: roster
    });

    callback?.({ ok: true });
  });

  socket.on("player-state", state => {
    const room = currentRoom && rooms.get(currentRoom);
    const player = room && room.players.get(socket.id);

    if (!player || !room.started || !state || !Number.isFinite(state.x) || !Number.isFinite(state.y)) return;

    player.x = Math.max(14, Math.min(4986, state.x));
    player.y = Math.max(14, Math.min(4986, state.y));
    player.a = Number.isFinite(state.a) ? state.a : 0;
    player.hp = Number.isFinite(state.hp) ? Math.max(0, Math.min(100, state.hp)) : 100;
    player.alive = state.alive !== false;
    player.lv = state.lv ? 1 : 0;
    player.bi = Number.isInteger(state.bi) ? state.bi : -1;

    socket.to(currentRoom).volatile.emit("player-state", {
      id: socket.id,
      name: player.name,
      team: player.team,
      x: player.x,
      y: player.y,
      a: player.a,
      hp: player.hp,
      alive: player.alive,
      lv: player.lv,
      bi: player.bi
    });
  });

  socket.on("player-shot", shot => {
    const room = currentRoom && rooms.get(currentRoom);

    if (!room || !room.started || !shot ||
        !Number.isFinite(shot.x) ||
        !Number.isFinite(shot.y) ||
        !Number.isFinite(shot.a)) return;

    socket.to(currentRoom).volatile.emit("player-shot", {
      id: socket.id,
      x: shot.x,
      y: shot.y,
      a: shot.a,
      weapon: String(shot.weapon || "pistol").slice(0, 12)
    });
  });

  socket.on("player-damage", hit => {
    const room = currentRoom && rooms.get(currentRoom);

    if (!room || !room.started || !hit ||
        typeof hit.target !== "string" ||
        !Number.isFinite(hit.damage)) return;

    const target = room.players.get(hit.target);
    const attacker = room.players.get(socket.id);

    if (!target || !attacker || target.id === attacker.id || target.alive === false) return;

    target.hp = Math.max(
      0,
      (Number.isFinite(target.hp) ? target.hp : 100) -
      Math.min(100, Math.max(0, hit.damage))
    );

    if (target.hp <= 0) target.alive = false;

    io.to(currentRoom).emit("player-damage", {
      target: target.id,
      attacker: attacker.id,
      hp: target.hp,
      alive: target.alive
    });
  });

  socket.on("leave-room", leaveCurrentRoom);
  socket.on("disconnect", leaveCurrentRoom);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Serveur multijoueur prêt sur le port ${PORT}`);
});
