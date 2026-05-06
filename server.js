require('dotenv').config();
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');

// ============================================================
//  EMAIL TRANSPORTER (Gmail via App Password)
// ============================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

async function sendOTPEmail(toEmail, otp) {
  await transporter.sendMail({
    from: `"Phantom App" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Your Phantom OTP Code',
    html: `
      <div style="font-family:sans-serif;max-width:400px;margin:auto;padding:32px;border:1px solid #eee;border-radius:12px;">
        <h2 style="color:#C62828;">👻 Phantom</h2>
        <p style="color:#333;">Your one-time password is:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#C62828;margin:24px 0;">${otp}</div>
        <p style="color:#888;font-size:13px;">This OTP is valid for <strong>5 minutes</strong>. Do not share it with anyone.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
        <p style="color:#bbb;font-size:11px;">If you didn't request this, please ignore this email.</p>
      </div>
    `,
  });
}

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

// OTP store (RAM only, never persisted)
// phoneNumber -> { otp, expiry, attempts, verified, resendCount, resendWindowStart }
const otpStore = new Map();

const OTP_EXPIRY_MS     = 5 * 60 * 1000;   // 5 minutes
const OTP_MAX_ATTEMPTS  = 5;                // wrong guesses before lockout
const OTP_MAX_RESENDS   = 3;                // resend requests per window
const OTP_RESEND_WINDOW = 10 * 60 * 1000;  // 10-minute resend window

// ============================================================
//  HELPERS
// ============================================================
function generateDeviceToken() {
  return crypto.randomBytes(24).toString('hex');
}

function generateOTP() {
  return String(crypto.randomInt(100000, 999999));
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase());
}

function isValidName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  return n.length >= 2 && n.length <= 30 && /^[a-zA-Z\s'\-.]+$/.test(n);
}

// ============================================================
//  SERVE CLIENT
// ============================================================
app.use(express.static(path.join(__dirname, 'client')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

// ============================================================
//  REST API — lookup user by email
// ============================================================
app.get('/api/user/:email', (req, res) => {
  try {
    const email = req.params.email?.trim().toLowerCase();
    if (!email) return res.json({ found: false });
    const user = registeredUsers[email];
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

  // ---- REQUEST OTP ----
  socket.on('request-otp', async (data) => {
    try {
      const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : null;
      if (!isValidEmail(email)) {
        socket.emit('otp-error', { error: 'Enter a valid email address.' });
        return;
      }

      const now    = Date.now();
      const stored = otpStore.get(email) || { resendCount: 0, resendWindowStart: now };

      if (now - stored.resendWindowStart > OTP_RESEND_WINDOW) {
        stored.resendCount       = 0;
        stored.resendWindowStart = now;
      }

      if (stored.resendCount >= OTP_MAX_RESENDS) {
        const retryIn = Math.ceil((OTP_RESEND_WINDOW - (now - stored.resendWindowStart)) / 60000);
        socket.emit('otp-error', { error: `Too many OTP requests. Try again in ${retryIn} minute(s).` });
        return;
      }

      const otp = generateOTP();
      otpStore.set(email, {
        otp,
        expiry:            now + OTP_EXPIRY_MS,
        attempts:          0,
        verified:          false,
        resendCount:       stored.resendCount + 1,
        resendWindowStart: stored.resendWindowStart,
      });

      await sendOTPEmail(email, otp);
      console.log(`[OTP] Sent to ${email}`);
      socket.emit('otp-sent', { expiresIn: OTP_EXPIRY_MS });
    } catch(e) {
      console.error('request-otp error:', e);
      socket.emit('otp-error', { error: 'Failed to send OTP email. Please try again.' });
    }
  });

    // ---- VERIFY OTP ----
  socket.on('verify-otp', (data) => {
    try {
      const email   = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : null;
      const entered = typeof data?.otp === 'string' ? data.otp.trim() : null;

      if (!isValidEmail(email) || !entered) {
        socket.emit('otp-result', { success: false, error: 'Invalid request.' });
        return;
      }

      const stored = otpStore.get(email);
      if (!stored) {
        socket.emit('otp-result', { success: false, error: 'No OTP found. Please request a new one.' });
        return;
      }

      if (Date.now() > stored.expiry) {
        otpStore.delete(email);
        socket.emit('otp-result', { success: false, error: 'OTP expired. Please request a new one.' });
        return;
      }

      if (stored.attempts >= OTP_MAX_ATTEMPTS) {
        otpStore.delete(email);
        socket.emit('otp-result', { success: false, error: 'Too many wrong attempts. Please request a new OTP.' });
        return;
      }

      if (entered !== stored.otp) {
        stored.attempts += 1;
        const left = OTP_MAX_ATTEMPTS - stored.attempts;
        socket.emit('otp-result', {
          success: false,
          error: left > 0 ? `Wrong OTP. ${left} attempt(s) remaining.` : 'Too many wrong attempts. Request a new OTP.',
          attemptsLeft: left,
        });
        return;
      }

      stored.verified = true;
      socket.emit('otp-result', { success: true });
      console.log(`[OTP] ${email} verified`);
    } catch(e) { console.error('verify-otp error:', e); }
  });

    // ---- REGISTER ----
  socket.on('register', (data) => {
    try {
      const email       = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : null;
      const name        = typeof data?.name === 'string' ? data.name.trim() : null;
      const deviceToken = typeof data?.deviceToken === 'string' ? data.deviceToken.trim() : null;

      if (!isValidEmail(email)) {
        socket.emit('registered', { success: false, error: 'Invalid email address.' });
        return;
      }

      const existing = registeredUsers[email];

      // First time registration — require OTP verification + valid name
      if (!existing) {
        const otpEntry = otpStore.get(email);
        if (!otpEntry || !otpEntry.verified) {
          socket.emit('registered', { success: false, error: 'OTP not verified. Please complete verification first.' });
          return;
        }
        if (!isValidName(name)) {
          socket.emit('registered', { success: false, error: 'Name must be 2–30 characters (letters, spaces, hyphens only).' });
          return;
        }
        otpStore.delete(email);
        const newToken = generateDeviceToken();
        registeredUsers[email] = { name, deviceToken: newToken };
        saveUsers(registeredUsers);
        connectUser(socket, email, name);
        socket.emit('registered', { success: true, email, name, deviceToken: newToken });
        console.log(`[NEW] Registered: ${email} as "${name}"`);
        return;
      }

      // Existing user — same device token → allow login
      if (deviceToken && existing.deviceToken === deviceToken) {
        connectUser(socket, email, existing.name);
        socket.emit('registered', { success: true, email, name: existing.name, deviceToken });
        console.log(`[LOGIN] ${email} as "${existing.name}"`);
        return;
      }

      // Different device — kick out old device, log in new device
      const oldActiveUser = activeUsers.get(email);
      if (oldActiveUser) {
        io.to(oldActiveUser.socketId).emit('force-logged-out', {
          reason: 'You have been logged in on another device.'
        });
        socketToPhone.delete(oldActiveUser.socketId);
        activeUsers.delete(email);
      }

      const newToken = generateDeviceToken();
      registeredUsers[email].deviceToken = newToken;
      saveUsers(registeredUsers);
      connectUser(socket, email, existing.name);
      socket.emit('registered', { success: true, email, name: existing.name, deviceToken: newToken });
      console.log(`[DEVICE SWITCH] ${email} logged in on new device`);

    } catch(e) { console.error('register error:', e); }
  });


  // ---- FORCE LOGOUT (clears device token so new device can login) ----
  socket.on('force-logout', (data) => {
    try {
      const email       = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : null;
      const deviceToken = typeof data?.deviceToken === 'string' ? data.deviceToken.trim() : null;
      if (!email || !deviceToken) return;
      const existing = registeredUsers[email];
      if (existing && existing.deviceToken === deviceToken) {
        registeredUsers[email].deviceToken = null;
        saveUsers(registeredUsers);
        socket.emit('force-logout-done');
      }
    } catch(e) { console.error('force-logout error:', e); }
  });

  // ---- LOOKUP USER ----
  socket.on('lookup-user', (data) => {
    try {
      const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : null;
      if (!email) return;
      const fromFile   = registeredUsers[email];
      const fromActive = activeUsers.get(email);
      const name       = fromFile?.name || fromActive?.name || null;
      if (name) {
        socket.emit('lookup-result', { found: true, email, name });
      } else {
        socket.emit('lookup-result', { found: false, email });
      }
    } catch(e) { console.error('lookup-user error:', e); }
  });

  // ---- CHECK USER ONLINE ----
  socket.on('check-user', (data) => {
    try {
      const email    = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : null;
      if (!email) return;
      const isOnline = activeUsers.has(email);
      const name     = registeredUsers[email]?.name || null;
      socket.emit('user-status', { email, isOnline, name });
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
        socket.emit('user-offline', { email: to });
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
        members.push({ email: phone, name });
      });
      socket.emit('group-existing-members', { roomId, members, callType });

      // Tell existing members about new joiner
      room.forEach(({ socketId }) => {
        io.to(socketId).emit('group-user-joined', { roomId, email: fromPhone, name: fromName, callType });
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
    io.to(socketId).emit('group-user-left', { email: phoneNumber, roomId });
  });
  if (room.size === 0) rooms.delete(roomId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Phantom Server running on port ${PORT}`);
  console.log(`📁 Users file: ${USERS_FILE}`);
  console.log(`👥 Registered users: ${Object.keys(registeredUsers).length}`);
});
