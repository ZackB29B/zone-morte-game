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

// Comptes persistés sur disque. Sur Render, configure AUTH_DATA_DIR vers le point
// de montage d'un disque persistant pour conserver les comptes entre déploiements.
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

// Sessions opaques conservées en mémoire (une relance du serveur déconnecte les comptes).
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
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
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
    // Recontrôle après scrypt asynchrone pour éviter deux inscriptions simultanées.
    if (users.has(usernameKey)) return res.status(409).json({ error: "Ce pseudo est déjà utilisé." });
    users.set(usernameKey, { username, usernameKey, salt: salt.toString("hex"), passwordHash: passwordHash.toString("hex") });
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
    if (!user || Buffer.byteLength(password, "utf8") > 128) return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
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

// Page de jeu : expose l'API interne du jeu à la fonctionnalité grenade, 
// (l'écran de connexion est intégré à public/index.html).
app.get("/", (_req, res) => {
  const indexPath = path.join(publicDir, "index.html");
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

// Structure : roomId -> Map(socketId -> données du joueur)
const rooms = new Map();
function cleanRoomId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[a-zA-Z0-9_-]{1,32}$/.test(id) ? id : null;
}
function getRoomPlayers(roomId) {
  const room = rooms.get(roomId);
  return room ? Array.from(room.values()) : [];
}

io.on("connection", socket => {
  let currentRoom = null;
  socket.on("join-room", (rawRoomId, callback) => {
    const roomId = cleanRoomId(rawRoomId);
    if (!roomId) {
      if (typeof callback === "function") callback({ ok: false, error: "Identifiant de salon invalide." });
      return;
    }
    if (currentRoom) leaveCurrentRoom();
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const player = { id: socket.id, x: 100, y: 100 };
    rooms.get(roomId).set(socket.id, player);
    currentRoom = roomId;
    socket.join(roomId);
    if (typeof callback === "function") callback({ ok: true, playerId: socket.id, players: getRoomPlayers(roomId) });
    socket.to(roomId).emit("player-joined", player);
  });
  socket.on("player-move", position => {
    if (!currentRoom || !position || typeof position !== "object") return;
    const x = Number(position.x), y = Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) return;
    const room = rooms.get(currentRoom), player = room && room.get(socket.id);
    if (!player) return;
    player.x = x; player.y = y;
    socket.to(currentRoom).emit("player-moved", { id: socket.id, x, y });
  });
  socket.on("leave-room", leaveCurrentRoom);
  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const roomId = currentRoom, room = rooms.get(roomId);
    socket.leave(roomId);
    if (room) {
      room.delete(socket.id);
      socket.to(roomId).emit("player-left", { id: socket.id });
      if (room.size === 0) rooms.delete(roomId);
    }
    currentRoom = null;
  }
  socket.on("disconnect", leaveCurrentRoom);
});

// Mode en ligne : recherche de partie, salons entre amis, relais de partie (voir online.js).
// Si le joueur est connecté (cookie de session), son pseudo de compte est utilisé en ligne.
require("./online")(io, {
  getAccount: socket => {
    const session = sessions.get(getCookie({ headers: socket.request.headers }, "zm_session"));
    return session && session.expiresAt > Date.now() ? session.username : null;
  }
});

httpServer.listen(PORT, "0.0.0.0", () => console.log(`Serveur multijoueur prêt sur le port ${PORT}`));
