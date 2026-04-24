const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// =============================================
// IN-MEMORY ONLY — No database, no file storage
// All data lives in RAM. Server restart = wipe.
// =============================================
const users = new Map();       // phoneNumber -> socketId
const socketToPhone = new Map(); // socketId -> phoneNumber

// Serve client files
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
      if (!phoneNumber || phoneNumber.length < 6 || phoneNumber.length > 15) {
        socket.emit('registered', { success: false, error: 'Invalid phone number' });
        return;
      }
      // If phone already registered, remove old socket
      if (users.has(phoneNumber)) {
        const oldSocketId = users.get(phoneNumber);
        socketToPhone.delete(oldSocketId);
      }
      users.set(phoneNumber, socket.id);
      socketToPhone.set(socket.id, phoneNumber);
      socket.emit('registered', { success: true, phoneNumber });
      console.log(`[✓] Registered: ${phoneNumber}`);
    } catch (e) { console.error('register error:', e); }
  });

  // ---- CHECK USER ONLINE ----
  socket.on('check-user', (data) => {
    try {
      const phoneNumber = typeof data?.phoneNumber === 'string' ? data.phoneNumber.trim() : null;
      if (!phoneNumber) return;
      const isOnline = users.has(phoneNumber);
      socket.emit('user-status', { phoneNumber, isOnline });
    } catch (e) { console.error('check-user error:', e); }
  });

  // ---- TEXT MESSAGING ----
  socket.on('send-message', (data) => {
    try {
      const to        = typeof data?.to === 'string' ? data.to.trim() : null;
      const message   = typeof data?.message === 'string' ? data.message.trim() : null;
      const messageId = data?.messageId;
      if (!to || !message || message.length > 2000) return;

      // FIX 6: Never trust client-supplied 'from' — derive from authenticated socket
      const from = socketToPhone.get(socket.id);
      if (!from) return;

      const targetSocketId = users.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('receive-message', {
          from,
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

  // Caller sends offer
  socket.on('call-offer', (data) => {
    try {
      const to       = typeof data?.to === 'string' ? data.to.trim() : null;
      const offer    = data?.offer;
      const callType = data?.callType === 'video' ? 'video' : 'audio';
      if (!to || !offer) return;

      // FIX 6: Derive caller identity from authenticated socket — not from client payload
      const from = socketToPhone.get(socket.id);
      if (!from) return;

      const targetSocketId = users.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('incoming-call', { from, offer, callType });
      } else {
        socket.emit('user-offline', { phoneNumber: to });
      }
    } catch (e) { console.error('call-offer error:', e); }
  });

  // Callee sends answer
  socket.on('call-answer', (data) => {
    try {
      const to     = typeof data?.to === 'string' ? data.to.trim() : null;
      const answer = data?.answer;
      if (!to || !answer) return;

      const from = socketToPhone.get(socket.id);
      if (!from) return;

      const targetSocketId = users.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('call-answered', { answer, from });
      }
    } catch (e) { console.error('call-answer error:', e); }
  });

  // ICE candidate exchange
  socket.on('ice-candidate', (data) => {
    try {
      const to        = typeof data?.to === 'string' ? data.to.trim() : null;
      const candidate = data?.candidate;
      if (!to || !candidate) return;
      const targetSocketId = users.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('ice-candidate', { candidate });
      }
    } catch (e) { console.error('ice-candidate error:', e); }
  });

  // Call declined
  socket.on('call-decline', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to) return;
      const targetSocketId = users.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('call-declined');
      }
    } catch (e) { console.error('call-decline error:', e); }
  });

  // Call ended
  socket.on('call-end', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to) return;
      const targetSocketId = users.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('call-ended');
      }
    } catch (e) { console.error('call-end error:', e); }
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const phoneNumber = socketToPhone.get(socket.id);
    if (phoneNumber) {
      users.delete(phoneNumber);
      socketToPhone.delete(socket.id);
      console.log(`[-] Disconnected: ${phoneNumber}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Phantom Server running on port ${PORT}`);
  console.log(`📱 Open: http://localhost:${PORT}`);
});
