const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// =============================================
// IN-MEMORY ONLY — RAM only, no storage
// =============================================
const users       = new Map(); // phoneNumber -> { socketId, name }
const socketToPhone = new Map(); // socketId -> phoneNumber
const rooms       = new Map(); // roomId -> Map<phoneNumber, { socketId, name }>

function broadcastUserList() {
  const userList = [];
  users.forEach(({ socketId, name }, phoneNumber) => {
    userList.push({ phoneNumber, name, isOnline: true });
  });
  io.emit('phantom-users', userList);
}

app.use(express.static(path.join(__dirname, 'client')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

io.on('connection', (socket) => {
  console.log('[+] Connected:', socket.id);

  // ---- REGISTRATION ----
  socket.on('register', (data) => {
    try {
      const phoneNumber = typeof data?.phoneNumber === 'string' ? data.phoneNumber.trim() : null;
      const name        = typeof data?.name === 'string' ? data.name.trim() : phoneNumber;
      if (!phoneNumber || phoneNumber.length < 6 || phoneNumber.length > 15) {
        socket.emit('registered', { success: false, error: 'Invalid phone number' });
        return;
      }
      if (users.has(phoneNumber)) {
        const old = users.get(phoneNumber);
        socketToPhone.delete(old.socketId);
      }
      users.set(phoneNumber, { socketId: socket.id, name: name || phoneNumber });
      socketToPhone.set(socket.id, phoneNumber);
      socket.emit('registered', { success: true, phoneNumber, name });
      console.log(`[✓] Registered: ${phoneNumber} as "${name}"`);
      broadcastUserList();
    } catch (e) { console.error('register error:', e); }
  });

  // ---- GET ALL PHANTOM USERS ----
  socket.on('get-users', () => {
    try {
      const userList = [];
      users.forEach(({ name }, phoneNumber) => {
        userList.push({ phoneNumber, name, isOnline: true });
      });
      socket.emit('phantom-users', userList);
    } catch (e) { console.error('get-users error:', e); }
  });

  // ---- CHECK USER ONLINE ----
  socket.on('check-user', (data) => {
    try {
      const phoneNumber = typeof data?.phoneNumber === 'string' ? data.phoneNumber.trim() : null;
      if (!phoneNumber) return;
      const isOnline = users.has(phoneNumber);
      const name = isOnline ? users.get(phoneNumber).name : null;
      socket.emit('user-status', { phoneNumber, isOnline, name });
    } catch (e) { console.error('check-user error:', e); }
  });

  // ---- TEXT MESSAGING ----
  socket.on('send-message', (data) => {
    try {
      const to        = typeof data?.to === 'string' ? data.to.trim() : null;
      const message   = typeof data?.message === 'string' ? data.message.trim() : null;
      const messageId = data?.messageId;
      if (!to || !message || message.length > 2000) return;
      const fromPhone = socketToPhone.get(socket.id);
      if (!fromPhone) return;
      const fromName  = users.get(fromPhone)?.name || fromPhone;
      const targetUser = users.get(to);
      if (targetUser) {
        io.to(targetUser.socketId).emit('receive-message', {
          from: fromPhone, fromName, message, messageId, timestamp: Date.now()
        });
        socket.emit('message-delivered', { messageId });
      } else {
        socket.emit('user-offline', { phoneNumber: to });
      }
    } catch (e) { console.error('send-message error:', e); }
  });

  // ============================================================
  //  1-to-1 WEBRTC SIGNALING
  // ============================================================
  socket.on('call-offer', (data) => {
    try {
      const to       = typeof data?.to === 'string' ? data.to.trim() : null;
      const offer    = data?.offer;
      const callType = data?.callType === 'video' ? 'video' : 'audio';
      if (!to || !offer) return;
      const fromPhone = socketToPhone.get(socket.id);
      if (!fromPhone) return;
      const fromName  = users.get(fromPhone)?.name || fromPhone;
      const targetUser = users.get(to);
      if (targetUser) {
        io.to(targetUser.socketId).emit('incoming-call', { from: fromPhone, fromName, offer, callType });
      } else {
        socket.emit('user-offline', { phoneNumber: to });
      }
    } catch (e) { console.error('call-offer error:', e); }
  });

  socket.on('call-answer', (data) => {
    try {
      const to     = typeof data?.to === 'string' ? data.to.trim() : null;
      const answer = data?.answer;
      if (!to || !answer) return;
      const fromPhone = socketToPhone.get(socket.id);
      if (!fromPhone) return;
      const targetUser = users.get(to);
      if (targetUser) {
        io.to(targetUser.socketId).emit('call-answered', { answer, from: fromPhone });
      }
    } catch (e) { console.error('call-answer error:', e); }
  });

  socket.on('ice-candidate', (data) => {
    try {
      const to        = typeof data?.to === 'string' ? data.to.trim() : null;
      const candidate = data?.candidate;
      if (!to || !candidate) return;
      const targetUser = users.get(to);
      if (targetUser) {
        io.to(targetUser.socketId).emit('ice-candidate', { from: socketToPhone.get(socket.id), candidate });
      }
    } catch (e) { console.error('ice-candidate error:', e); }
  });

  socket.on('call-decline', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to) return;
      const targetUser = users.get(to);
      if (targetUser) io.to(targetUser.socketId).emit('call-declined');
    } catch (e) { console.error('call-decline error:', e); }
  });

  socket.on('call-end', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to) return;
      const targetUser = users.get(to);
      if (targetUser) io.to(targetUser.socketId).emit('call-ended');
    } catch (e) { console.error('call-end error:', e); }
  });

  // ============================================================
  //  GROUP CALL SIGNALING
  // ============================================================

  // Create or join a room
  socket.on('group-join', (data) => {
    try {
      const roomId    = typeof data?.roomId === 'string' ? data.roomId.trim() : null;
      const callType  = data?.callType === 'video' ? 'video' : 'audio';
      if (!roomId) return;
      const fromPhone = socketToPhone.get(socket.id);
      if (!fromPhone) return;
      const fromName  = users.get(fromPhone)?.name || fromPhone;

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const room = rooms.get(roomId);

      // Tell new joiner who is already in the room
      const existingMembers = [];
      room.forEach(({ socketId, name }, phone) => {
        existingMembers.push({ phoneNumber: phone, name });
      });
      socket.emit('group-existing-members', { roomId, members: existingMembers, callType });

      // Tell everyone in room that new person joined
      room.forEach(({ socketId }, phone) => {
        io.to(socketId).emit('group-user-joined', {
          roomId, phoneNumber: fromPhone, name: fromName, callType
        });
      });

      // Add self to room
      room.set(fromPhone, { socketId: socket.id, name: fromName });
      console.log(`[GROUP] ${fromPhone} joined room ${roomId} (${room.size} members)`);
    } catch (e) { console.error('group-join error:', e); }
  });

  // Group offer (to specific peer in room)
  socket.on('group-offer', (data) => {
    try {
      const to     = typeof data?.to === 'string' ? data.to.trim() : null;
      const roomId = data?.roomId;
      const offer  = data?.offer;
      if (!to || !offer) return;
      const fromPhone = socketToPhone.get(socket.id);
      const fromName  = users.get(fromPhone)?.name || fromPhone;
      const targetUser = users.get(to);
      if (targetUser) {
        io.to(targetUser.socketId).emit('group-offer', {
          from: fromPhone, fromName, roomId, offer
        });
      }
    } catch (e) { console.error('group-offer error:', e); }
  });

  // Group answer
  socket.on('group-answer', (data) => {
    try {
      const to     = typeof data?.to === 'string' ? data.to.trim() : null;
      const answer = data?.answer;
      const roomId = data?.roomId;
      if (!to || !answer) return;
      const fromPhone = socketToPhone.get(socket.id);
      const targetUser = users.get(to);
      if (targetUser) {
        io.to(targetUser.socketId).emit('group-answer', {
          from: fromPhone, roomId, answer
        });
      }
    } catch (e) { console.error('group-answer error:', e); }
  });

  // Group ICE
  socket.on('group-ice', (data) => {
    try {
      const to        = typeof data?.to === 'string' ? data.to.trim() : null;
      const candidate = data?.candidate;
      const roomId    = data?.roomId;
      if (!to || !candidate) return;
      const fromPhone = socketToPhone.get(socket.id);
      const targetUser = users.get(to);
      if (targetUser) {
        io.to(targetUser.socketId).emit('group-ice', {
          from: fromPhone, roomId, candidate
        });
      }
    } catch (e) { console.error('group-ice error:', e); }
  });

  // Leave group
  socket.on('group-leave', (data) => {
    try {
      const roomId    = typeof data?.roomId === 'string' ? data.roomId.trim() : null;
      if (!roomId) return;
      const fromPhone = socketToPhone.get(socket.id);
      const room      = rooms.get(roomId);
      if (!room) return;
      room.delete(fromPhone);
      if (room.size === 0) {
        rooms.delete(roomId);
      } else {
        room.forEach(({ socketId }) => {
          io.to(socketId).emit('group-user-left', { phoneNumber: fromPhone, roomId });
        });
      }
      console.log(`[GROUP] ${fromPhone} left room ${roomId}`);
    } catch (e) { console.error('group-leave error:', e); }
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const phoneNumber = socketToPhone.get(socket.id);
    if (phoneNumber) {
      // Leave any group rooms
      rooms.forEach((room, roomId) => {
        if (room.has(phoneNumber)) {
          room.delete(phoneNumber);
          room.forEach(({ socketId }) => {
            io.to(socketId).emit('group-user-left', { phoneNumber, roomId });
          });
          if (room.size === 0) rooms.delete(roomId);
        }
      });
      users.delete(phoneNumber);
      socketToPhone.delete(socket.id);
      console.log(`[-] Disconnected: ${phoneNumber}`);
      broadcastUserList();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Phantom Server running on port ${PORT}`);
});
