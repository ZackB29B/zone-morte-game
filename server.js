const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// Sert les fichiers du jeu placés dans le dossier "public".
app.use(express.static("public"));

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
