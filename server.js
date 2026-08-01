const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // allow all origins (adjust for production)
  },
});

// Serve static files (if you want to host the HTML from the server)
app.use(express.static('public')); // put your HTML file in a 'public' folder

// ─── Game state ──────────────────────────
const rooms = {}; // roomId -> { players, board, currentTurn, scores, winner, winCombo, isActive }

function createRoom(roomId, playerId, playerName) {
  rooms[roomId] = {
    players: {
      X: { id: playerId, name: playerName },
      O: null,
    },
    board: Array(9).fill(null),
    currentTurn: 'X',
    scores: { X: 0, O: 0 },
    winner: null,       // 'X', 'O', 'draw', or null
    winCombo: [],
    isActive: false,    // becomes true when both players are present
  };
  return rooms[roomId];
}

function getRoom(roomId) {
  return rooms[roomId];
}

function deleteRoom(roomId) {
  delete rooms[roomId];
}

// ─── Win detection ──────────────────────
const WIN_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function checkWinner(board) {
  for (const combo of WIN_COMBOS) {
    const [a, b, c] = combo;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], combo };
    }
  }
  if (board.every(cell => cell !== null)) return { winner: 'draw', combo: [] };
  return { winner: null, combo: [] };
}

// ─── Socket.IO logic ─────────────────────
io.on('connection', (socket) => {
  console.log(`🟢 ${socket.id} connected`);

  // ── Create game ──
  socket.on('createGame', ({ playerName }) => {
    const roomId = generateRoomId();
    const playerId = socket.id;
    const game = createRoom(roomId, playerId, playerName);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    socket.emit('gameCreated', { roomId, playerId, symbol: 'X' });
    // Notify that room is waiting for opponent
    socket.to(roomId).emit('playerJoined', { playerName, symbol: 'X' });
  });

  // ── Join game ──
  socket.on('joinGame', ({ roomId, playerName }) => {
    const room = getRoom(roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }
    if (room.players.O) {
      socket.emit('error', { message: 'Room is full.' });
      return;
    }
    // Assign as 'O'
    const playerId = socket.id;
    room.players.O = { id: playerId, name: playerName };
    room.isActive = true; // both players now present
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;

    // Send full game state to the joining player
    socket.emit('gameJoined', {
      roomId,
      playerId,
      symbol: 'O',
      game: room,
    });

    // Notify the other player (X) that O joined
    socket.to(roomId).emit('playerJoined', { playerName, symbol: 'O' });
    // Send the updated game state to everyone in the room
    io.to(roomId).emit('gameUpdate', { game: room });
  });

  // ── Make a move ──
  socket.on('makeMove', ({ roomId, playerId, index }) => {
    const room = getRoom(roomId);
    if (!room) return;
    if (!room.isActive) return;
    if (room.winner) return;
    const symbol = room.players.X?.id === playerId ? 'X' : room.players.O?.id === playerId ? 'O' : null;
    if (!symbol) return;
    if (room.currentTurn !== symbol) return;
    if (room.board[index] !== null) return;

    // Apply move
    room.board[index] = symbol;

    // Check win/draw
    const result = checkWinner(room.board);
    if (result.winner) {
      room.winner = result.winner;
      room.winCombo = result.combo || [];
      if (result.winner !== 'draw') {
        room.scores[result.winner] = (room.scores[result.winner] || 0) + 1;
      }
      room.isActive = false;
    } else {
      // Switch turn
      room.currentTurn = room.currentTurn === 'X' ? 'O' : 'X';
    }

    // Broadcast updated game
    io.to(roomId).emit('gameUpdate', { game: room });
  });

  // ── Restart game ──
  socket.on('restartGame', ({ roomId, playerId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    // Only allow if both players are present and game is finished
    if (!room.players.X || !room.players.O) return;
    if (!room.winner && room.isActive) return; // can't restart an ongoing game

    // Reset board but keep scores and players
    room.board = Array(9).fill(null);
    room.currentTurn = 'X';
    room.winner = null;
    room.winCombo = [];
    room.isActive = true;
    io.to(roomId).emit('gameRestarted', { game: room });
  });

  // ── Leave game ──
  socket.on('leaveGame', ({ roomId, playerId }) => {
    handleLeave(socket, roomId, playerId);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (roomId && playerId) {
      handleLeave(socket, roomId, playerId);
    }
    console.log(`🔴 ${socket.id} disconnected`);
  });

  function handleLeave(socket, roomId, playerId) {
    const room = getRoom(roomId);
    if (!room) return;
    let symbol = null;
    if (room.players.X?.id === playerId) symbol = 'X';
    else if (room.players.O?.id === playerId) symbol = 'O';
    if (!symbol) return;

    const playerName = room.players[symbol]?.name || 'Someone';
    // Remove player from room
    room.players[symbol] = null;
    // If both players left, delete room
    if (!room.players.X && !room.players.O) {
      deleteRoom(roomId);
      socket.leave(roomId);
      return;
    }
    // Otherwise, set game inactive and reset board
    room.isActive = false;
    room.board = Array(9).fill(null);
    room.winner = null;
    room.winCombo = [];
    room.currentTurn = 'X';
    // Notify remaining player
    socket.to(roomId).emit('playerLeft', { playerName });
    io.to(roomId).emit('gameUpdate', { game: room });
    socket.leave(roomId);
    // Clear socket data
    socket.data.roomId = null;
    socket.data.playerId = null;
  }
});

// ─── Helpers ────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});