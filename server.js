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
// IN-MEMORY ONLY — No database, no file storage
// All data lives in RAM. Server restart = wipe.
// =============================================
// phoneNumber -> { socketId, name }
const users = new Map();
// socketId -> phoneNumber
const socketToPhone = new Map();

// Serve client files
app.use(express.static(path.join(__dirname, 'client')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

// Broadcast updated user list to ALL connected clients
function broadcastUserList() {
  const userList = [];
  users.forEach(({ socketId, name }, phoneNumber) => {
    userList.push({ phoneNumber, name, isOnline: true });
  });
  io.emit('phantom-users', userList);
}

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
      // Remove old socket if phone already registered
      if (users.has(phoneNumber)) {
        const old = users.get(phoneNumber);
        socketToPhone.delete(old.socketId);
      }
      users.set(phoneNumber, { socketId: socket.id, name: name || phoneNumber });
      socketToPhone.set(socket.id, phoneNumber);
      socket.emit('registered', { success: true, phoneNumber, name });
      console.log(`[✓] Registered: ${phoneNumber} as "${name}"`);
      // Broadcast updated user list to everyone
      broadcastUserList();
    } catch (e) { console.error('register error:', e); }
  });

  // ---- GET ALL PHANTOM USERS ----
  socket.on('get-users', () => {
    try {
      const userList = [];
      users.forEach(({ socketId, name }, phoneNumber) => {
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
      const fromName = users.get(fromPhone)?.name || fromPhone;
      const targetUser = users.get(to);
      if (targetUser) {
        io.to(targetUser.socketId).emit('receive-message', {
          from: fromPhone,
          fromName,
          message,
          messageId,
          timestamp: Date.now()
        });
        socket.emit('message-delivered', { messageId });
      } else {
        socket.emit('user-offline', { phoneNumber: to });
      }
    } catch (e) { console.error('send-message error:', e); }
  });

  // ---- WEBRTC SIGNALING ----

  socket.on('call-offer', (data) => {
    try {
      const to       = typeof data?.to === 'string' ? data.to.trim() : null;
      const offer    = data?.offer;
      const callType = data?.callType === 'video' ? 'video' : 'audio';
      if (!to || !offer) return;
      const fromPhone = socketToPhone.get(socket.id);
      if (!fromPhone) return;
      const fromName = users.get(fromPhone)?.name || fromPhone;
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
        io.to(targetUser.socketId).emit('ice-candidate', { candidate });
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

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const phoneNumber = socketToPhone.get(socket.id);
    if (phoneNumber) {
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
