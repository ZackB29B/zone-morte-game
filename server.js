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

// Injecte le pont de gameplay et le module des grenades dans la page du jeu.
// Cette route doit précéder express.static pour remplacer index.html.
app.get("/", (_req, res) => {
  const indexPath = path.join(publicDir, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");

  const apiMarker = "start, update, get zone()";
  const apiBridge = "start, update, grenadeHurt: hurt, grenadeToast: toast, grenadeGetParts() { return parts; }, get zone()";
  if (html.includes(apiMarker)) html = html.replace(apiMarker, apiBridge);

  // Le bouton droit ne doit pas activer le tir : il déclenche le lancer de grenade.
  const mouseMarker = "} else { M.down = true; M.x = x; M.y = y; }";
  const mouseBridge = "} else if (e.button === 2) { M.down = false; window.dispatchEvent(new CustomEvent('zone-morte-grenade', { detail: { x, y } })); } else { M.down = true; M.x = x; M.y = y; }";
  if (html.includes(mouseMarker)) html = html.replace(mouseMarker, mouseBridge);

  // Les fumigènes masquent les bots dans leur ligne de vue.
  html = html.replace(
    "if (d < bd && los(b, o)) {",
    "if (d < bd && los(b, o) && !(window.grenadeSmokeBlocks && window.grenadeSmokeBlocks(b, o))) {"
  );

  html = html.replace("</body>", '<script src="/grenades.js"></script>\n</body>');
  res.type("html").send(html);
});

// Sert les fichiers statiques après la route de la page principale.
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

  // Un joueur rejoint un salon.
  socket.on("join-room", (rawRoomId, callback) => {
    const roomId = cleanRoomId(rawRoomId);

    if (!roomId) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Identifiant de salon invalide." });
      }
      return;
    }

    // Évite qu'un même socket reste dans deux salons.
    if (currentRoom) {
      leaveCurrentRoom();
    }

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());

    const player = {
      id: socket.id,
      x: 100,
      y: 100
    };

    rooms.get(roomId).set(socket.id, player);
    currentRoom = roomId;
    socket.join(roomId);

    // Envoie au nouveau joueur les personnes déjà présentes.
    if (typeof callback === "function") {
      callback({
        ok: true,
        playerId: socket.id,
        players: getRoomPlayers(roomId)
      });
    }

    // Informe les autres joueurs de l'arrivée.
    socket.to(roomId).emit("player-joined", player);
  });

  // Le client transmet sa position ; le serveur vérifie les valeurs.
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

    // Diffuse la position aux autres joueurs du salon.
    socket.to(currentRoom).emit("player-moved", {
      id: socket.id,
      x,
      y
    });
  });

  socket.on("leave-room", () => {
    leaveCurrentRoom();
  });

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

  socket.on("disconnect", () => {
    leaveCurrentRoom();
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Serveur multijoueur prêt sur le port ${PORT}`);
});
