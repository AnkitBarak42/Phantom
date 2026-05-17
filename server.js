require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());

// ============================================================
//  SERVE APPS
// ============================================================
// Admin app → /admin
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

// User app → /
app.use(express.static(path.join(__dirname, 'client')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'client', 'index.html')));

// ============================================================
//  IN-MEMORY STATE (RAM only — resets on server restart)
// ============================================================
// pendingRequests: requestId -> { requestId, name, mobile, gender, age, address, socketId, timestamp }
const pendingRequests = new Map();
// activeUsers:    uniqueId  -> { socketId, name }
const activeUsers     = new Map();
// socketToUser:   socketId  -> uniqueId
const socketToUser    = new Map();
// pendingMessages: uniqueId -> [{ from, fromName, message, messageId, timestamp }]
const pendingMessages = new Map();
// rooms: roomId -> Map<uniqueId, { socketId, name }>
const rooms           = new Map();
// adminSessions: Set of valid session tokens
const adminSessions   = new Set();
// adminSockets: Set of socketIds with active admin session
const adminSockets    = new Set();

// ============================================================
//  HELPERS
// ============================================================
function generateUniqueId(name, mobile, gender, age, address) {
  const n    = name.trim()[0].toUpperCase();
  const m    = mobile.trim().replace(/\D/g, '')[0];
  const g    = gender.trim()[0].toUpperCase();
  const a    = String(age).trim();
  const addr = address.trim()[0].toUpperCase();
  const rand = crypto.randomInt(100, 999);
  return `${n}${m}${g}${a}${addr}${rand}`;
}

function generateRequestId()   { return crypto.randomBytes(8).toString('hex'); }
function generateSessionToken(){ return crypto.randomBytes(32).toString('hex'); }

function isValidMobile(m) { return /^\d{10,15}$/.test(String(m || '').trim()); }
function isValidAge(a)    { const n = Number(a); return Number.isInteger(n) && n >= 5 && n <= 120; }

function notifyAdmins(event, data) {
  adminSockets.forEach(sid => io.to(sid).emit(event, data));
}

function deliverPendingMessages(socket, uniqueId) {
  const queue = pendingMessages.get(uniqueId);
  if (!queue || queue.length === 0) return;
  console.log(`[DELIVER] ${queue.length} messages → ${uniqueId}`);
  queue.forEach(msg => socket.emit('receive-message', { ...msg, wasOffline: true }));
  pendingMessages.delete(uniqueId);
}

function removeFromRoom(uniqueId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.delete(uniqueId);
  room.forEach(({ socketId }) => io.to(socketId).emit('group-user-left', { uniqueId, roomId }));
  if (room.size === 0) rooms.delete(roomId);
}

function connectUser(socket, uniqueId, name) {
  if (activeUsers.has(uniqueId)) {
    socketToUser.delete(activeUsers.get(uniqueId).socketId);
  }
  activeUsers.set(uniqueId, { socketId: socket.id, name });
  socketToUser.set(socket.id, uniqueId);
  deliverPendingMessages(socket, uniqueId);
}

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  console.log('[+] Connected:', socket.id);

  // ── USER: Submit new login request ──────────────────────
  socket.on('submit-request', (data) => {
    try {
      const name    = typeof data?.name    === 'string' ? data.name.trim()    : '';
      const mobile  = typeof data?.mobile  === 'string' ? data.mobile.trim()  : '';
      const gender  = typeof data?.gender  === 'string' ? data.gender.trim()  : '';
      const age     = data?.age;
      const address = typeof data?.address === 'string' ? data.address.trim() : '';

      if (!name || !mobile || !gender || !age || !address) {
        socket.emit('request-error', { error: 'All fields are required.' }); return;
      }
      if (!isValidMobile(mobile)) {
        socket.emit('request-error', { error: 'Enter a valid 10-digit mobile number.' }); return;
      }
      if (!isValidAge(age)) {
        socket.emit('request-error', { error: 'Enter a valid age (5–120).' }); return;
      }

      // Remove any existing pending request from same mobile number
      for (const [existingId, existingReq] of pendingRequests.entries()) {
        if (existingReq.mobile === mobile) {
          pendingRequests.delete(existingId);
          notifyAdmins('remove-request', { requestId: existingId });
          console.log(`[DEDUP] Removed old pending request ${existingId} for mobile ${mobile}`);
        }
      }

      const requestId = generateRequestId();
      const request   = {
        requestId, name, mobile, gender,
        age: String(age), address,
        socketId:  socket.id,
        timestamp: Date.now(),
      };

      pendingRequests.set(requestId, request);
      socket.emit('request-submitted', { requestId });
      notifyAdmins('new-request', request);
      console.log(`[REQUEST] ${name} (${mobile}) id:${requestId}`);
    } catch(e) { console.error('submit-request error:', e); }
  });

  // ── USER: Rejoin while still pending (app reopened) ─────
  socket.on('rejoin-request', (data) => {
    try {
      const requestId = typeof data?.requestId === 'string' ? data.requestId : null;
      if (!requestId) return;
      const req = pendingRequests.get(requestId);
      if (req) {
        req.socketId = socket.id;
        socket.emit('request-still-pending', { requestId });
        console.log(`[REJOIN] ${requestId} → ${socket.id}`);
      } else {
        socket.emit('request-not-found', { requestId });
      }
    } catch(e) { console.error('rejoin-request error:', e); }
  });

  // ── USER: Reconnect as already-approved user ─────────────
  socket.on('user-reconnect', (data) => {
    try {
      const uniqueId = typeof data?.uniqueId === 'string' ? data.uniqueId.trim() : null;
      const name     = typeof data?.name     === 'string' ? data.name.trim()     : null;
      if (!uniqueId || !name) return;
      connectUser(socket, uniqueId, name);
      socket.emit('reconnected', { success: true, uniqueId, name });
      console.log(`[RECONNECT] ${name} (${uniqueId})`);
    } catch(e) { console.error('user-reconnect error:', e); }
  });

  // ── ADMIN: Login ─────────────────────────────────────────
  socket.on('admin-login', (data) => {
    try {
      const { username, password } = data || {};
      if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = generateSessionToken();
        adminSessions.add(token);
        adminSockets.add(socket.id);
        socket.emit('admin-auth', { success: true, token });
        socket.emit('pending-requests', { requests: Array.from(pendingRequests.values()) });
        console.log(`[ADMIN] Login OK — ${pendingRequests.size} pending requests sent`);
      } else {
        socket.emit('admin-auth', { success: false, error: 'Invalid credentials.' });
        console.log('[ADMIN] Failed login attempt');
      }
    } catch(e) { console.error('admin-login error:', e); }
  });

  // ── ADMIN: Reconnect with stored token ───────────────────
  socket.on('admin-reconnect', (data) => {
    try {
      const token = typeof data?.token === 'string' ? data.token : null;
      if (!token || !adminSessions.has(token)) {
        socket.emit('admin-session-expired'); return;
      }
      adminSockets.add(socket.id);
      socket.emit('admin-auth', { success: true, token });
      socket.emit('pending-requests', { requests: Array.from(pendingRequests.values()) });
      console.log(`[ADMIN] Reconnected: ${socket.id}`);
    } catch(e) { console.error('admin-reconnect error:', e); }
  });

  // ── ADMIN: Approve request ───────────────────────────────
  socket.on('approve-request', (data) => {
    try {
      const requestId = typeof data?.requestId === 'string' ? data.requestId : null;
      const token     = typeof data?.token     === 'string' ? data.token     : null;
      if (!token || !adminSessions.has(token)) { socket.emit('admin-error', { error: 'Unauthorized.' }); return; }

      const req = pendingRequests.get(requestId);
      if (!req) { socket.emit('admin-error', { error: 'Request not found.' }); return; }

      const uniqueId = generateUniqueId(req.name, req.mobile, req.gender, req.age, req.address);

      // Notify the waiting user
      io.to(req.socketId).emit('request-approved', {
        uniqueId,
        name:    req.name,
        mobile:  req.mobile,
        gender:  req.gender,
        age:     req.age,
        address: req.address,
      });

      pendingRequests.delete(requestId);
      socket.emit('request-processed', { requestId, uniqueId, action: 'approved', userDetails: req });
      console.log(`[APPROVED] ${req.name} → ${uniqueId}`);
    } catch(e) { console.error('approve-request error:', e); }
  });

  // ── ADMIN: Reject request ────────────────────────────────
  socket.on('reject-request', (data) => {
    try {
      const requestId = typeof data?.requestId === 'string' ? data.requestId : null;
      const token     = typeof data?.token     === 'string' ? data.token     : null;
      const reason    = typeof data?.reason    === 'string' && data.reason.trim()
                        ? data.reason.trim() : 'Your request was not approved.';
      if (!token || !adminSessions.has(token)) { socket.emit('admin-error', { error: 'Unauthorized.' }); return; }

      const req = pendingRequests.get(requestId);
      if (!req) { socket.emit('admin-error', { error: 'Request not found.' }); return; }

      io.to(req.socketId).emit('request-rejected', { reason });
      pendingRequests.delete(requestId);
      socket.emit('request-processed', { requestId, action: 'rejected' });
      console.log(`[REJECTED] ${req.name} (${requestId})`);
    } catch(e) { console.error('reject-request error:', e); }
  });

  // ── MESSAGING ────────────────────────────────────────────
  socket.on('send-message', (data) => {
    try {
      const to        = typeof data?.to      === 'string' ? data.to.trim()      : null;
      const message   = typeof data?.message === 'string' ? data.message.trim() : null;
      const messageId = data?.messageId;
      if (!to || !message || message.length > 2000) return;

      const fromId   = socketToUser.get(socket.id);
      if (!fromId) return;
      const fromName  = activeUsers.get(fromId)?.name || fromId;
      const timestamp = Date.now();
      const target    = activeUsers.get(to);

      if (target) {
        io.to(target.socketId).emit('receive-message', { from: fromId, fromName, message, messageId, timestamp });
        socket.emit('message-delivered', { messageId });
      } else {
        if (!pendingMessages.has(to)) pendingMessages.set(to, []);
        const queue = pendingMessages.get(to);
        if (queue.length < 200) queue.push({ from: fromId, fromName, message, messageId, timestamp });
        socket.emit('message-queued', { messageId });
      }
    } catch(e) { console.error('send-message error:', e); }
  });

  socket.on('check-user', (data) => {
    try {
      const uniqueId = typeof data?.uniqueId === 'string' ? data.uniqueId.trim() : null;
      if (!uniqueId) return;
      socket.emit('user-status', {
        uniqueId,
        isOnline: activeUsers.has(uniqueId),
        name: activeUsers.get(uniqueId)?.name || null,
      });
    } catch(e) { console.error('check-user error:', e); }
  });

  // ── 1-to-1 CALL SIGNALING ────────────────────────────────
  socket.on('call-offer', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      const offer = data?.offer;
      const callType = data?.callType === 'video' ? 'video' : 'audio';
      if (!to || !offer) return;
      const fromId   = socketToUser.get(socket.id);
      if (!fromId) return;
      const fromName = activeUsers.get(fromId)?.name || fromId;
      const target   = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('incoming-call', { from: fromId, fromName, offer, callType });
      else socket.emit('user-offline', { uniqueId: to });
    } catch(e) { console.error('call-offer error:', e); }
  });

  socket.on('call-answer', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      const answer = data?.answer;
      if (!to || !answer) return;
      const target = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('call-answered', { answer, from: socketToUser.get(socket.id) });
    } catch(e) { console.error('call-answer error:', e); }
  });

  socket.on('ice-candidate', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      const candidate = data?.candidate;
      if (!to || !candidate) return;
      const target = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('ice-candidate', { from: socketToUser.get(socket.id), candidate });
    } catch(e) { console.error('ice-candidate error:', e); }
  });

  socket.on('call-decline', (data) => {
    try {
      const target = activeUsers.get(data?.to?.trim());
      if (target) io.to(target.socketId).emit('call-declined');
    } catch(e) {}
  });

  socket.on('call-end', (data) => {
    try {
      const target = activeUsers.get(data?.to?.trim());
      if (target) io.to(target.socketId).emit('call-ended');
    } catch(e) {}
  });

  // ── GROUP CALL SIGNALING ─────────────────────────────────
  socket.on('group-join', (data) => {
    try {
      const roomId   = typeof data?.roomId === 'string' ? data.roomId.trim() : null;
      const callType = data?.callType === 'video' ? 'video' : 'audio';
      if (!roomId) return;
      const fromId   = socketToUser.get(socket.id);
      if (!fromId) return;
      const fromName = activeUsers.get(fromId)?.name || fromId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const room = rooms.get(roomId);
      const members = [];
      room.forEach(({ socketId, name }, uid) => members.push({ uniqueId: uid, name }));
      socket.emit('group-existing-members', { roomId, members, callType });
      room.forEach(({ socketId }) => io.to(socketId).emit('group-user-joined', { roomId, uniqueId: fromId, name: fromName, callType }));
      room.set(fromId, { socketId: socket.id, name: fromName });
    } catch(e) { console.error('group-join error:', e); }
  });

  socket.on('group-offer', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to || !data?.offer) return;
      const fromId = socketToUser.get(socket.id);
      const target = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('group-offer', { from: fromId, fromName: activeUsers.get(fromId)?.name || fromId, roomId: data.roomId, offer: data.offer });
    } catch(e) {}
  });

  socket.on('group-answer', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to || !data?.answer) return;
      const target = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('group-answer', { from: socketToUser.get(socket.id), roomId: data.roomId, answer: data.answer });
    } catch(e) {}
  });

  socket.on('group-ice', (data) => {
    try {
      const to = typeof data?.to === 'string' ? data.to.trim() : null;
      if (!to || !data?.candidate) return;
      const target = activeUsers.get(to);
      if (target) io.to(target.socketId).emit('group-ice', { from: socketToUser.get(socket.id), roomId: data.roomId, candidate: data.candidate });
    } catch(e) {}
  });

  socket.on('group-leave', (data) => {
    try {
      const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : null;
      if (roomId) removeFromRoom(socketToUser.get(socket.id), roomId);
    } catch(e) {}
  });

  // ── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    adminSockets.delete(socket.id);
    const uniqueId = socketToUser.get(socket.id);
    if (uniqueId) {
      rooms.forEach((_, roomId) => { if (rooms.get(roomId)?.has(uniqueId)) removeFromRoom(uniqueId, roomId); });
      activeUsers.delete(uniqueId);
      socketToUser.delete(socket.id);
      console.log(`[-] Disconnected: ${uniqueId}`);
    } else {
      console.log(`[-] Disconnected: ${socket.id}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Phantom Server running on port ${PORT}`);
  console.log(`🔑 Admin user: ${process.env.ADMIN_USERNAME ? '✅ set' : '❌ NOT SET'}`);
  console.log(`🔑 Admin pass: ${process.env.ADMIN_PASSWORD ? '✅ set' : '❌ NOT SET'}`);
});
