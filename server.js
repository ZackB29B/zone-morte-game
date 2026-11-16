const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "jeu-multijoueur" });
});

const rooms = new Map();
const onlinePlayers = new Map();

function cleanRoomId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) return null;
  return id;
}

function sanitizeName(value) {
  if (typeof value !== "string") return "Joueur";
  const name = value.trim().replace(/\s+/g, " ");
  return name.slice(0, 18) || "Joueur";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getOnlinePlayers() {
  return Array.from(onlinePlayers.values()).map((player) => ({
    id: player.id,
    name: player.name,
    roomId: player.roomId || null,
    status: player.status || "online"
  }));
}

function makeBotPlayer(difficulty = "recrue", index = 0) {
  const names = ["Valk", "Dren", "Orsk", "Maren", "Thane", "Kael", "Brix", "Ysolde", "Garr", "Neth", "Ruk", "Sable", "Voss", "Iven", "Torv", "Hale", "Zorn", "Lyra", "Cade", "Mord", "Pike", "Rhen", "Skol", "Tarn"];
  const diffs = {
    recrue: { power: 0.35, stayInBuildings: 0.95 },
    novice: { power: 0.5, stayInBuildings: 0.8 },
    commando: { power: 0.7, stayInBuildings: 0.6 },
    veteran: { power: 0.85, stayInBuildings: 0.45 },
    elite: { power: 1, stayInBuildings: 0.28 },
    ghost: { power: 1.2, stayInBuildings: 0.18 }
  };
  const level = diffs[difficulty] || diffs.recrue;
  return {
    id: `bot-${Date.now()}-${index}`,
    name: names[index % names.length] || `Bot ${index + 1}`,
    isBot: true,
    difficulty,
    power: level.power,
    stayInBuildings: level.stayInBuildings,
    x: 0,
    y: 0,
    hp: 100,
    alive: true
  };
}

function getRoomPlayers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];

  return Array.from(room.players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    isBot: false,
    ready: !!player.ready,
    host: player.id === room.hostId,
    roomId,
    x: player.x,
    y: player.y
  })).concat(room.bots.map((bot, index) => ({
    id: bot.id,
    name: bot.name,
    isBot: true,
    ready: true,
    host: false,
    roomId,
    difficulty: bot.difficulty,
    power: bot.power,
    stayInBuildings: bot.stayInBuildings,
    x: bot.x,
    y: bot.y
  })));
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      hostId: null,
      state: "lobby",
      mode: "br",
      difficulty: "recrue",
      players: new Map(),
      bots: [],
      createdAt: Date.now()
    });
  }
  return rooms.get(roomId);
}

function roomSummary(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    roomId,
    state: room.state,
    hostId: room.hostId,
    mode: room.mode,
    difficulty: room.difficulty,
    players: getRoomPlayers(roomId),
    currentCount: room.players.size + room.bots.length,
    requiredCount: room.mode === "duel" ? 2 : room.mode === "squad" ? 12 : 25
  };
}

function fillBots(room, targetCount) {
  const currentCount = room.players.size + room.bots.length;
  if (currentCount >= targetCount) return room.bots;
  const normalizedDifficulty = room.difficulty || "recrue";
  while (room.bots.length + room.players.size < targetCount) {
    const bot = makeBotPlayer(normalizedDifficulty, room.bots.length + room.players.size + 1);
    room.bots.push(bot);
  }
  return room.bots;
}

function announceRoomList() {
  const payload = Array.from(rooms.entries()).filter(([, room]) => room.state === "lobby").map(([roomId, room]) => roomSummary(roomId));
  io.emit("rooms-list", payload);
}

function syncOnlinePlayers() {
  io.emit("online-players", getOnlinePlayers());
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.currentRoom;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    const player = room.players.get(socket.id);
    if (player) room.players.delete(socket.id);

    if (room.hostId === socket.id) {
      const [nextHost] = room.players.keys();
      room.hostId = nextHost || null;
    }

    socket.to(roomId).emit("player-left", { id: socket.id });

    if (room.players.size === 0 && room.bots.length === 0) {
      rooms.delete(roomId);
    }
  }

  socket.leave(roomId);
  socket.data.currentRoom = null;
  socket.data.roomName = null;
  announceRoomList();
}

io.on("connection", (socket) => {
  socket.data = socket.data || {};
  socket.data.currentRoom = null;
  socket.data.roomName = null;

  socket.on("register-player", ({ name } = {}, callback) => {
    const safeName = sanitizeName(name);
    onlinePlayers.set(socket.id, {
      id: socket.id,
      name: safeName,
      roomId: socket.data.currentRoom || null,
      status: "online"
    });
    syncOnlinePlayers();

    if (typeof callback === "function") {
      callback({ ok: true, player: { id: socket.id, name: safeName } });
    }
  });

  socket.on("list-online", (callback) => {
    if (typeof callback === "function") {
      callback({ ok: true, players: getOnlinePlayers() });
    }
  });

  socket.on("create-room", ({ roomId, name, mode, difficulty } = {}, callback) => {
    const safeRoomId = cleanRoomId(roomId);
    const safeName = sanitizeName(name);
    if (!safeRoomId) {
      if (typeof callback === "function") callback({ ok: false, error: "Identifiant de salon invalide." });
      return;
    }

    if (socket.data.currentRoom) leaveCurrentRoom(socket);

    const room = ensureRoom(safeRoomId);
    room.state = "lobby";
    room.hostId = socket.id;
    room.mode = ["br", "squad", "duel", "train"].includes(mode) ? mode : "br";
    room.difficulty = ["recrue", "novice", "commando", "veteran", "elite", "ghost"].includes(difficulty) ? difficulty : "recrue";
    room.players.set(socket.id, { id: socket.id, name: safeName, x: 0, y: 0, ready: true, joinedAt: Date.now() });
    room.bots = [];
    socket.join(safeRoomId);
    socket.data.currentRoom = safeRoomId;
    socket.data.roomName = safeRoomId;

    onlinePlayers.set(socket.id, { id: socket.id, name: safeName, roomId: safeRoomId, status: "in-lobby" });
    syncOnlinePlayers();

    const payload = getRoomPlayers(safeRoomId);
    socket.emit("room-joined", { ok: true, roomId: safeRoomId, playerId: socket.id, players: payload, isHost: true });
    io.to(safeRoomId).emit("room-state", roomSummary(safeRoomId));
    announceRoomList();

    if (typeof callback === "function") callback({ ok: true, roomId: safeRoomId, players: payload, isHost: true });
  });

  socket.on("join-room", ({ roomId, name } = {}, callback) => {
    const safeRoomId = cleanRoomId(roomId);
    const safeName = sanitizeName(name);

    if (!safeRoomId) {
      if (typeof callback === "function") callback({ ok: false, error: "Identifiant de salon invalide." });
      return;
    }

    if (socket.data.currentRoom) leaveCurrentRoom(socket);

    const room = ensureRoom(safeRoomId);
    if (room.state !== "lobby") {
      if (typeof callback === "function") callback({ ok: false, error: "La partie a déjà commencé." });
      return;
    }

    room.players.set(socket.id, { id: socket.id, name: safeName, x: 0, y: 0, ready: true, joinedAt: Date.now() });
    if (!room.hostId) room.hostId = socket.id;
    socket.join(safeRoomId);
    socket.data.currentRoom = safeRoomId;
    socket.data.roomName = safeRoomId;

    onlinePlayers.set(socket.id, { id: socket.id, name: safeName, roomId: safeRoomId, status: "in-lobby" });
    syncOnlinePlayers();

    const payload = getRoomPlayers(safeRoomId);
    socket.emit("room-joined", { ok: true, roomId: safeRoomId, playerId: socket.id, players: payload, isHost: false });
    io.to(safeRoomId).emit("room-state", roomSummary(safeRoomId));
    announceRoomList();

    if (typeof callback === "function") callback({ ok: true, roomId: safeRoomId, players: payload, isHost: false });
  });

  socket.on("room-list", (callback) => {
    const payload = Array.from(rooms.entries()).filter(([, room]) => room.state === "lobby").map(([roomId, room]) => roomSummary(roomId));
    if (typeof callback === "function") callback({ ok: true, rooms: payload });
    else socket.emit("rooms-list", payload);
  });

  socket.on("start-match", ({ roomId, mode, difficulty } = {}, callback) => {
    const targetRoomId = cleanRoomId(roomId) || socket.data.currentRoom;
    const room = rooms.get(targetRoomId);
    if (!room) {
      if (typeof callback === "function") callback({ ok: false, error: "Salon introuvable." });
      return;
    }

    if (room.hostId !== socket.id) {
      if (typeof callback === "function") callback({ ok: false, error: "Seul l'hôte peut lancer la partie." });
      return;
    }

    if (room.players.size < 2) {
      if (typeof callback === "function") callback({ ok: false, error: "Il faut au moins 2 joueurs pour démarrer la partie." });
      return;
    }

    room.state = "playing";
    room.mode = ["br", "squad", "duel", "train"].includes(mode) ? mode : room.mode;
    room.difficulty = ["recrue", "novice", "commando", "veteran", "elite", "ghost"].includes(difficulty) ? difficulty : room.difficulty;

    const mapCount = room.mode === "duel" ? 2 : room.mode === "squad" ? 12 : 25;
    const filled = fillBots(room, mapCount);

    room.players.forEach((player) => {
      player.ready = true;
      player.x = 0;
      player.y = 0;
    });

    const participants = getRoomPlayers(targetRoomId);
    io.to(targetRoomId).emit("match-start", {
      ok: true,
      roomId: targetRoomId,
      mode: room.mode,
      difficulty: room.difficulty,
      participants,
      requiredCount: mapCount,
      botsFilled: filled.length
    });

    if (typeof callback === "function") callback({ ok: true, roomId: targetRoomId, participants, botsFilled: filled.length });
  });

  socket.on("player-move", (position) => {
    if (!socket.data.currentRoom || !position || typeof position !== "object") return;
    const room = rooms.get(socket.data.currentRoom);
    if (!room) return;
    const x = Number(position.x);
    const y = Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    player.x = clamp(x, -100000, 100000);
    player.y = clamp(y, -100000, 100000);
    socket.to(socket.data.currentRoom).emit("player-moved", {
      id: socket.id,
      name: player.name,
      x: player.x,
      y: player.y
    });
  });

  socket.on("leave-room", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("disconnect", () => {
    if (socket.data.currentRoom) leaveCurrentRoom(socket);
    if (onlinePlayers.has(socket.id)) onlinePlayers.delete(socket.id);
    syncOnlinePlayers();
    announceRoomList();
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Serveur multijoueur prêt sur le port ${PORT}`);
});
