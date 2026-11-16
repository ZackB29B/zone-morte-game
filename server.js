const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");

// Le HTML actuel est un fragment (pas de balises <html>/<body>). On le transforme
// côté serveur afin d'exposer les fonctions du jeu depuis sa propre IIFE et de
// connecter le clic droit au module de grenades.
app.get("/", (_req, res) => {
  const indexPath = path.join(publicDir, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");

  // Ces remplacements sont dans le script principal : hurt, toast, parts et les
  // variables de partie sont donc accessibles dans leur portée lexicale.
  const apiMarker = "start, update, get zone()";
  const apiBridge = "start, update, grenadeHurt: hurt, grenadeToast: toast, grenadeGetParts: () => parts, get zone()";
  if (html.includes(apiMarker)) {
    html = html.replace(apiMarker, apiBridge);
  } else {
    console.error("[Zone Morte] Impossible d'ajouter les fonctions grenade dans index.html");
  }

  // Le canvas conserve le clic gauche pour tirer et transmet le clic droit aux grenades.
  const mouseMarker = "} else { M.down = true; M.x = x; M.y = y; }";
  const mouseBridge = "} else if (e.button === 2) { e.preventDefault(); M.down = false; window.dispatchEvent(new CustomEvent('zone-morte-grenade', { detail: { x, y } })); } else { M.down = true; M.x = x; M.y = y; }";
  if (html.includes(mouseMarker)) {
    html = html.replace(mouseMarker, mouseBridge);
  } else {
    console.error("[Zone Morte] Impossible de relier le clic droit aux grenades dans index.html");
  }

  // Empêche le menu contextuel natif sur le canvas et charge le module après l'API.
  const contextMarker = "cv.addEventListener('contextmenu', e => e.preventDefault());";
  if (!html.includes(contextMarker)) {
    html = html.replace("</script>", "cv.addEventListener('contextmenu', e => e.preventDefault());\n</script>");
  }
  html += '\n<script src="/grenades.js?v=3"></script>\n';
  res.type("html").send(html);
});

app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "jeu-multijoueur" });
});

// Structure : roomId -> Map(socketId -> données du joueur)
const rooms = new Map();

function cleanRoomId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) return null;
  return id;
}

function getRoomPlayers(roomId) {
  const room = rooms.get(roomId);
  return room ? Array.from(room.values()) : [];
}

io.on("connection", (socket) => {
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

    if (typeof callback === "function") {
      callback({ ok: true, playerId: socket.id, players: getRoomPlayers(roomId) });
    }
    socket.to(roomId).emit("player-joined", player);
  });

  socket.on("player-move", (position) => {
    if (!currentRoom || !position || typeof position !== "object") return;
    const x = Number(position.x);
    const y = Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return;

    const room = rooms.get(currentRoom);
    const player = room && room.get(socket.id);
    if (!player) return;
    player.x = x;
    player.y = y;
    socket.to(currentRoom).emit("player-moved", { id: socket.id, x, y });
  });

  socket.on("leave-room", () => leaveCurrentRoom());

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const roomId = currentRoom;
    const room = rooms.get(roomId);
    socket.leave(roomId);
    if (room) {
      room.delete(socket.id);
      socket.to(roomId).emit("player-left", { id: socket.id });
      if (room.size === 0) rooms.delete(roomId);
    }
    currentRoom = null;
  }

  socket.on("disconnect", () => leaveCurrentRoom());
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Serveur multijoueur prêt sur le port ${PORT}`);
});
