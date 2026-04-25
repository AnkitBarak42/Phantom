const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());

// ============================================================
//  PERSISTENT STORAGE — users.json (registration only)
//  Stores: { phoneNumber, name, deviceToken }
//  Messages/calls: RAM only, never stored
// ============================================================
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch(e) { console.error('loadUsers error:', e); return {}; }
}

function saveUsers(data) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('saveUsers error:', e); }
}

// registeredUsers: { phoneNumber -> { name, deviceToken } }
let registeredUsers = loadUsers();

// ============================================================
//  IN-MEMORY (RAM only — resets on restart)
// ============================================================
// activeUsers: phoneNumber -> { socketId, name }
const activeUsers   = new Map();
// socketToPhone: socketId -> phoneNumber
const socketToPhone = new Map();
// Group rooms: roomId -> Map<phoneNumber, { socketId, name }>
const rooms         = new Map();
// Pending messages for offline users (RAM only)
// phoneNumber -> [{from, fromName, message, messageId, timestamp}]
const pendingMessages = new Map();

// ============================================================
//  HELPERS
// ============================================================
function generateDeviceToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// ============================================================
//  SERVE CLIENT
// ============================================================
app.use(express.static(path.join(__dirname, 'client')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

// ============================================================
//  REST API — lookup user by phone
// ============================================================
app.get('/api/user/:phone', (req, res) => {
  try {
    const phone = req.params.phone?.trim();
    if (!phone) return res.json({ found: false });
    const user = registeredUsers[phone];
    if (user) {
      res.json({ found: true, name: user.name });
    } else {
      res.json({ found: false });
    }
  } catch(e) { res.json({ found: false }); }
});

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  console.log('[+] Connected:', socket.id);

  // ---- REGISTER ----
  socket.on('register', (data) => {
    try {
      const phoneNumber   = typeof data?.phoneNumber === 'string' ? data.phoneNumber.trim() : null;
      const name          = typeof data?.name === 'string' ? data.name.trim() : null;
      const deviceToken   = typeof data?.deviceToken === 'string' ? data.deviceToken.trim() : null;

      if (!phoneNumber || phoneNumber.length < 6 || phoneNumber.length > 15) {
        socket.emit('registered', { success: false, error: 'Invalid phone number' });
        return;
      }

      const existing = registeredUsers[phoneNumber];

      // First time registration
      if (!existing) {
        if (!name) {
          socket.emit('registered', { success: false, error: 'Name required for first registration' });
          return;
        }
        const newToken = generateDeviceToken();
        registeredUsers[phoneNumber] = { name, deviceToken: newToken };
        saveUsers(registeredUsers);
        connectUser(socket, phoneNumber, name);
        socket.emit('registered', { success: true, phoneNumber, name, deviceToken: newToken });
        console.log(`[NEW] Registered: ${phoneNumber} as "${name}"`);
        return;
      }

      // Existing user — verify device token
      if (deviceToken && existing.deviceToken === deviceToken) {
        // Same device → allow login, update name if changed
        if (name && name !== existing.name) {
          registeredUsers[phoneNumber].name = name;
          saveUsers(registeredUsers);
        }
        connectUser(socket, phoneNumber, existing.name);
        socket.emit('registered', { success: true, phoneNumber, name: existing.name, deviceToken });
        console.log(`[LOGIN] ${phoneNumber} as "${existing.name}"`);
        return;
      }

      // Different device — reject
      socket.emit('registered', {
        success: false,
        error: 'This number is already registered on another device. Please logout from the other device first.'
      });
      console.log(`[REJECTED] ${phoneNumber} — device mismatch`);

    } catch(e) { console.error('register error:', e); }
  });

  // ---- FORCE LOGOUT (clears device token so new device can login) ----
  socket.on('force-logout', (data) => {
    try {
      const phoneNumber = typeof data?.phoneNumber === 'string' ? data.phoneNumber.trim() : null;
      const deviceToken = typeof data?.deviceToken === 'string' ? data.deviceToken.trim() : null;
      if (!phoneNumber || !deviceToken) return;
      const existing = registeredUsers[phoneNumber];
      if (existing && existing.deviceToken === deviceToken) {
        registeredUsers[phoneNumber].deviceToken = null;
        saveUsers(registeredUsers);
        socket.emit('force-logout-done');
      }
    } catch(e) { console.error('force-logout error:', e); }
  });

  // ---- LOOKUP USER ----
  socket.on('lookup-user', (data) => {
    try {
      const phoneNumber = typeof data?.phoneNumber === 'string' ? data.phoneNumber.trim() : null;
      if (!phoneNumber) return;
      // Check both persistent file AND active RAM (handles Render free tier reset)
      const fromFile   = registeredUsers[phoneNumber];
      const fromActive = activeUsers.get(phoneNumber);
      const name       = fromFile?.name || fromActive?.name || null;
      if (name) {
        socket.emit('lookup-result', { found: true, phoneNumber, name });
      } else {
        socket.emit('lookup-result', { found: false, phoneNumber });
      }
    } catch(e) { console.error('lookup-user error:', e); }
  });

  // ---- CHECK USER ONLINE ----
  socket.on('check-user', (data) => {
    try {
      const phoneNumber = typeof data?.phoneNumber === 'string' ? data.phoneNumber.trim() : null;
      if (!phoneNumber) return;
      const isOnline = activeUsers.has(phoneNumber);
      const name     = registeredUsers[phoneNumber]?.name || null;
      socket.emit('user-status', { phoneNumber, isOnline, name });
    } catch(e) { console.error('check-user error:', e); }
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
      const fromName  = registeredUsers[fromPhone]?.name || activeUsers.get(fromPhone)?.name || fromPhone;
      const timestamp = Date.now();
      const target    = activeUsers.get(to);

      if (target) {
        // User is online — deliver immediately
        io.to(target.socketId).emit('receive-message', {
          from: fromPhone, fromName, message, messageId, timestamp
        });
        socket.emit('message-delivered', { messageId });
      } else {
        // User is offline — queue message in RAM
        if (!pendingMessages.has(to)) pendingMessages.set(to, []);
        const queue = pendingMessages.get(to);
        // Max 200 pending messages per user to avoid memory issues
        if (queue.length < 200) {
          queue.push({ from: fromPhone, fromName, message, messageId, timestamp });
        }
        // Notify sender — message queued, will deliver when recipient comes online
        socket.emit('message-queued', { messageId });
        console.log('[QUEUED] Message from ' + fromPhone + ' to ' + to + ' (' + queue.length + ' pending)');
      }
    } catch(e) { console.error('send-message error:', e); }
  });

  // ---- 1-to-1 CALL SIGNALING ----
  socket.on('call-offer', (data) => {
    try {
      const to       = typeof data?.to === 'string' ? data.to.trim() : null;
      const offer    = data?.offer;
      const callType = data?.callType === 'video' ? 'video' : 'audio';
      if (!to || !offer) return;
      const fromPhone = socketToPhone.get(socket.id);
      if (!fromPhone) return;
      const fromName  = registeredUsers[fromPhone]?.name || fromPhone;
      const target    = activeUsers.get(to);
      if (target) {
        io.to(target.socketId).emit('incoming-call', { from: fromPhone, fromName, offer, callType });
      } else {
        socket.emit('user-offline', { phoneNumber: to });
      }
    } catch(e) { console.error('call-offer error:', e); }
  });

  socket.on('call-answer', (data) => {
    try {
      const to     = typeof data?.to === 'string' ? data.to.trim() : null;
      const answer = data?.answer;
      if (!to || !answer) return;
      const fromPhone = socketToPhone.get(socket.id);
      const target    = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('call-answered', { answer, from: fromPhone });
    } catch(e) { console.error('call-answer error:', e); }
  });

  socket.on('ice-candidate', (data) => {
    try {
      const to        = typeof data?.to === 'string' ? data.to.trim() : null;
      const candidate = data?.candidate;
      if (!to || !candidate) return;
      const fromPhone = socketToPhone.get(socket.id);
      const target    = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('ice-candidate', { from: fromPhone, candidate });
    } catch(e) { console.error('ice-candidate error:', e); }
  });

  socket.on('call-decline', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to) return;
      const target = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('call-declined');
    } catch(e) { console.error('call-decline error:', e); }
  });

  socket.on('call-end', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to) return;
      const target = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('call-ended');
    } catch(e) { console.error('call-end error:', e); }
  });

  // ---- GROUP CALL SIGNALING ----
  socket.on('group-join', (data) => {
    try {
      const roomId   = typeof data?.roomId === 'string' ? data.roomId.trim() : null;
      const callType = data?.callType === 'video' ? 'video' : 'audio';
      if (!roomId) return;
      const fromPhone = socketToPhone.get(socket.id);
      if (!fromPhone) return;
      const fromName  = registeredUsers[fromPhone]?.name || fromPhone;

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const room = rooms.get(roomId);

      // Tell joiner who is already there
      const members = [];
      room.forEach(({ socketId, name }, phone) => {
        members.push({ phoneNumber: phone, name });
      });
      socket.emit('group-existing-members', { roomId, members, callType });

      // Tell existing members about new joiner
      room.forEach(({ socketId }) => {
        io.to(socketId).emit('group-user-joined', { roomId, phoneNumber: fromPhone, name: fromName, callType });
      });

      room.set(fromPhone, { socketId: socket.id, name: fromName });
      console.log(`[GROUP] ${fromName} joined room ${roomId} (${room.size} members)`);
    } catch(e) { console.error('group-join error:', e); }
  });

  socket.on('group-offer', (data) => {
    try {
      const to     = typeof data?.to === 'string' ? data.to.trim() : null;
      const offer  = data?.offer;
      const roomId = data?.roomId;
      if (!to || !offer) return;
      const fromPhone = socketToPhone.get(socket.id);
      const fromName  = registeredUsers[fromPhone]?.name || fromPhone;
      const target    = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('group-offer', { from: fromPhone, fromName, roomId, offer });
    } catch(e) { console.error('group-offer error:', e); }
  });

  socket.on('group-answer', (data) => {
    try {
      const to     = typeof data?.to === 'string' ? data.to.trim() : null;
      const answer = data?.answer;
      const roomId = data?.roomId;
      if (!to || !answer) return;
      const fromPhone = socketToPhone.get(socket.id);
      const target    = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('group-answer', { from: fromPhone, roomId, answer });
    } catch(e) { console.error('group-answer error:', e); }
  });

  socket.on('group-ice', (data) => {
    try {
      const to        = typeof data?.to === 'string' ? data.to.trim() : null;
      const candidate = data?.candidate;
      const roomId    = data?.roomId;
      if (!to || !candidate) return;
      const fromPhone = socketToPhone.get(socket.id);
      const target    = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('group-ice', { from: fromPhone, roomId, candidate });
    } catch(e) { console.error('group-ice error:', e); }
  });

  socket.on('group-leave', (data) => {
    try {
      const roomId    = typeof data?.roomId === 'string' ? data.roomId.trim() : null;
      if (!roomId) return;
      const fromPhone = socketToPhone.get(socket.id);
      removeFromRoom(fromPhone, roomId);
    } catch(e) { console.error('group-leave error:', e); }
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const phoneNumber = socketToPhone.get(socket.id);
    if (phoneNumber) {
      // Leave any group rooms
      rooms.forEach((room, roomId) => {
        if (room.has(phoneNumber)) removeFromRoom(phoneNumber, roomId);
      });
      activeUsers.delete(phoneNumber);
      socketToPhone.delete(socket.id);
      console.log(`[-] Disconnected: ${phoneNumber}`);
    }
  });
});

// ============================================================
//  HELPERS
// ============================================================
function connectUser(socket, phoneNumber, name) {
  // Remove old socket if reconnecting
  if (activeUsers.has(phoneNumber)) {
    const old = activeUsers.get(phoneNumber);
    socketToPhone.delete(old.socketId);
  }
  activeUsers.set(phoneNumber, { socketId: socket.id, name });
  socketToPhone.set(socket.id, phoneNumber);

  // Deliver any pending offline messages
  deliverPendingMessages(socket, phoneNumber);
}

function deliverPendingMessages(socket, phoneNumber) {
  const queue = pendingMessages.get(phoneNumber);
  if (!queue || queue.length === 0) return;
  console.log('[DELIVER] Sending ' + queue.length + ' pending messages to ' + phoneNumber);
  // Send all queued messages in order
  queue.forEach(msg => {
    socket.emit('receive-message', {
      from:      msg.from,
      fromName:  msg.fromName,
      message:   msg.message,
      messageId: msg.messageId,
      timestamp: msg.timestamp,
      wasOffline: true  // flag so client knows this is a delayed message
    });
  });
  // Clear queue after delivery
  pendingMessages.delete(phoneNumber);
}

function removeFromRoom(phoneNumber, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.delete(phoneNumber);
  room.forEach(({ socketId }) => {
    io.to(socketId).emit('group-user-left', { phoneNumber, roomId });
  });
  if (room.size === 0) rooms.delete(roomId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Phantom Server running on port ${PORT}`);
  console.log(`📁 Users file: ${USERS_FILE}`);
  console.log(`👥 Registered users: ${Object.keys(registeredUsers).length}`);
});
