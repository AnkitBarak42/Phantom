// ============================================================
//  PHANTOM — Frontend Logic v2
//  localStorage: phone + name + phantom contacts only
//  RAM only: messages, calls (never stored)
// ============================================================

const SERVER_URL = 'https://phantom-d603.onrender.com';

// ============================================================
//  STATE
// ============================================================
let socket          = null;
let myPhone         = '';
let myName          = '';
let myOTP           = '';
let currentChat     = '';       // phone of active chat
let currentChatName = '';       // display name of active chat
let peerConnection  = null;
let localStream     = null;
let currentCallType = null;
let pendingOffer    = null;
let pendingCallFrom = null;
let pendingCallName = '';
let isMuted         = false;
let callTimerInterval = null;
let callSeconds     = 0;
let currentTab      = 'chats';

// RAM only
const chatMessages = new Map(); // phone -> [{from,fromName,message,timestamp,mine}]
const chatContacts = new Map(); // phone -> {name, lastMsg, lastTime}

// localStorage keys
const LS_PHONE    = 'phantom_phone';
const LS_NAME     = 'phantom_name';
const LS_CONTACTS = 'phantom_contacts'; // known Phantom users

// ICE queue
let iceCandidateQueue = [];

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

// ============================================================
//  LOCALSTORAGE HELPERS
// ============================================================
function lsGet(key) { try { return localStorage.getItem(key); } catch(e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch(e) {} }
function lsRemove(key) { try { localStorage.removeItem(key); } catch(e) {} }

function loadSavedContacts() {
  try {
    const raw = lsGet(LS_CONTACTS);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function saveContactToLS(phone, name) {
  const contacts = loadSavedContacts();
  const existing = contacts.findIndex(c => c.phone === phone);
  if (existing >= 0) {
    contacts[existing].name = name;
  } else {
    contacts.push({ phone, name });
  }
  lsSet(LS_CONTACTS, JSON.stringify(contacts));
}

function getNameForPhone(phone) {
  // Check saved contacts first
  const saved = loadSavedContacts();
  const found = saved.find(c => c.phone === phone);
  if (found) return found.name;
  // Check chat contacts map
  if (chatContacts.has(phone)) return chatContacts.get(phone).name || phone;
  return phone;
}

// ============================================================
//  INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
  setupSocketEvents();
  setupUIEvents();

  // Check if already logged in
  const savedPhone = lsGet(LS_PHONE);
  const savedName  = lsGet(LS_NAME);

  if (savedPhone && savedName) {
    myPhone = savedPhone;
    myName  = savedName;
    // Auto re-register with server
    socket.on('connect', () => {
      socket.emit('register', { phoneNumber: myPhone, name: myName });
    });
    updateHomeUI();
    showScreen('home');
  } else {
    showScreen('login');
  }
});

// ============================================================
//  SCREEN + TAB NAVIGATION
// ============================================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`tab-content-${tab}`).classList.add('active');

  if (tab === 'contacts') {
    socket.emit('get-users');
  }
}

// ============================================================
//  SOCKET EVENTS
// ============================================================
function setupSocketEvents() {

  socket.on('connect', () => {
    console.log('[Socket] Connected');
    // Re-register if already logged in
    if (myPhone && myName) {
      socket.emit('register', { phoneNumber: myPhone, name: myName });
    }
  });

  socket.on('disconnect', () => console.log('[Socket] Disconnected'));

  // Registration confirmed
  socket.on('registered', ({ success, phoneNumber, name }) => {
    if (!success) return;
    myPhone = phoneNumber;
    myName  = name || phoneNumber;
    // Save to localStorage
    lsSet(LS_PHONE, myPhone);
    lsSet(LS_NAME, myName);
    updateHomeUI();
    if (getCurrentScreen() !== 'home') {
      showScreen('home');
      showToast(`✅ Welcome, ${myName}!`);
    }
  });

  // Phantom users list (for contacts tab)
  socket.on('phantom-users', (userList) => {
    // Save all to localStorage contacts
    userList.forEach(u => {
      if (u.phoneNumber !== myPhone) {
        saveContactToLS(u.phoneNumber, u.name);
      }
    });
    renderPhantomContacts(userList);
  });

  // User status check response
  socket.on('user-status', ({ phoneNumber, isOnline, name }) => {
    if (name) saveContactToLS(phoneNumber, name);
    if (phoneNumber === currentChat) {
      document.getElementById('chat-header-status').textContent =
        isOnline ? '🟢 Online' : '⭕ Offline';
      if (name && name !== phoneNumber) {
        document.getElementById('chat-header-name').textContent = name;
        currentChatName = name;
      }
    }
  });

  // Receive message
  socket.on('receive-message', ({ from, fromName, message, timestamp }) => {
    if (fromName) saveContactToLS(from, fromName);
    const displayName = fromName || getNameForPhone(from);
    storeMessage(from, { from, fromName: displayName, message, timestamp, mine: false });
    updateChatContact(from, displayName, message, timestamp);

    if (currentChat === from) {
      renderMessage({ from, fromName: displayName, message, timestamp, mine: false });
      scrollToBottom();
    } else {
      showToast(`💬 ${displayName}: ${message.substring(0, 35)}`);
      renderChatList();
    }
  });

  socket.on('message-delivered', () => {});

  socket.on('user-offline', ({ phoneNumber }) => {
    const name = getNameForPhone(phoneNumber);
    showToast(`❌ ${name} is not online`);
    if (getCurrentScreen() === 'calling') showScreen('chat');
  });

  // Incoming call
  socket.on('incoming-call', ({ from, fromName, offer, callType }) => {
    pendingOffer    = offer;
    pendingCallFrom = from;
    pendingCallName = fromName || getNameForPhone(from);
    currentCallType = callType;

    if (fromName) saveContactToLS(from, fromName);

    const initials = pendingCallName.substring(0, 2).toUpperCase();
    document.getElementById('incoming-avatar').textContent = initials;
    document.getElementById('incoming-number').textContent = pendingCallName;
    document.getElementById('incoming-type-label').textContent =
      callType === 'video' ? '📹 Video Call' : '📞 Audio Call (Earpiece)';
    document.getElementById('incoming-call-status').textContent = 'Incoming Call…';

    const ringtone = document.getElementById('ringtone');
    ringtone.currentTime = 0;
    ringtone.play().catch(() => {});

    showScreen('incoming');
  });

  // Call answered
  socket.on('call-answered', async ({ answer }) => {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      for (const c of iceCandidateQueue) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
      }
      iceCandidateQueue = [];
    }
  });

  // ICE candidate
  socket.on('ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    if (peerConnection && peerConnection.remoteDescription) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn('ICE error:', e); }
    } else {
      iceCandidateQueue.push(candidate);
    }
  });

  socket.on('call-declined', () => {
    showToast('❌ Call declined');
    cleanupCall();
    showScreen(currentChat ? 'chat' : 'home');
  });

  socket.on('call-ended', () => {
    showToast('📵 Call ended');
    cleanupCall();
    showScreen(currentChat ? 'chat' : 'home');
  });
}

// ============================================================
//  UI EVENTS
// ============================================================
function setupUIEvents() {

  // LOGIN
  document.getElementById('btn-send-otp').addEventListener('click', handleSendOTP);
  document.getElementById('phone-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSendOTP();
  });

  // OTP
  document.getElementById('btn-verify-otp').addEventListener('click', handleVerifyOTP);
  document.getElementById('btn-back-login').addEventListener('click', () => showScreen('login'));

  const otpBoxes = document.querySelectorAll('.otp-box');
  otpBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(-1);
      if (box.value && i < otpBoxes.length - 1) otpBoxes[i + 1].focus();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) otpBoxes[i - 1].focus();
    });
  });

  // NAME
  document.getElementById('btn-save-name').addEventListener('click', handleSaveName);
  document.getElementById('name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSaveName();
  });

  // HOME
  document.getElementById('btn-open-chat').addEventListener('click', handleOpenChat);
  document.getElementById('search-phone').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleOpenChat();
  });
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  document.getElementById('btn-refresh-contacts').addEventListener('click', () => {
    socket.emit('get-users');
    showToast('🔄 Refreshing contacts…');
  });

  // CHAT
  document.getElementById('btn-back-home').addEventListener('click', () => {
    currentChat = '';
    currentChatName = '';
    showScreen('home');
  });
  document.getElementById('btn-send-msg').addEventListener('click', handleSendMessage);
  document.getElementById('message-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });
  document.getElementById('btn-audio-call').addEventListener('click', () => startCall('audio'));
  document.getElementById('btn-video-call').addEventListener('click', () => startCall('video'));

  // OUTGOING CALL
  document.getElementById('btn-cancel-call').addEventListener('click', () => {
    socket.emit('call-end', { to: currentChat });
    cleanupCall();
    showScreen('chat');
  });

  // INCOMING CALL
  document.getElementById('btn-accept-call').addEventListener('click', acceptCall);
  document.getElementById('btn-decline-call').addEventListener('click', () => {
    document.getElementById('ringtone').pause();
    socket.emit('call-decline', { to: pendingCallFrom });
    pendingOffer = null;
    pendingCallFrom = null;
    pendingCallName = '';
    showScreen(currentChat ? 'chat' : 'home');
  });

  // ACTIVE CALL
  document.getElementById('btn-end-call').addEventListener('click', () => {
    socket.emit('call-end', { to: currentChat || pendingCallFrom });
    cleanupCall();
    showScreen(currentChat ? 'chat' : 'home');
  });
  document.getElementById('btn-toggle-mute').addEventListener('click', toggleMute);
  document.getElementById('btn-toggle-video').addEventListener('click', toggleVideo);
}

// ============================================================
//  AUTH FLOW
// ============================================================
function handleSendOTP() {
  const phone = document.getElementById('phone-input').value.trim();
  if (phone.length < 10) {
    showToast('⚠️ Enter a valid 10-digit number');
    return;
  }
  // Hardcoded OTP
  myOTP   = '123456';
  myPhone = phone;

  document.getElementById('otp-subtitle').textContent = `Enter the OTP for +91 ${phone}`;
  document.querySelectorAll('.otp-box').forEach(b => b.value = '');
  showScreen('otp');
  setTimeout(() => document.querySelector('.otp-box').focus(), 200);
}

function handleVerifyOTP() {
  const entered = Array.from(document.querySelectorAll('.otp-box')).map(b => b.value).join('');
  if (entered.length < 6) { showToast('⚠️ Enter all 6 digits'); return; }
  if (entered !== myOTP)   { showToast('❌ Wrong OTP. Try again.'); return; }

  // Check if name already saved
  const savedName = lsGet(LS_NAME);
  if (savedName) {
    myName = savedName;
    socket.emit('register', { phoneNumber: myPhone, name: myName });
  } else {
    // Go to name screen
    showScreen('name');
    setTimeout(() => document.getElementById('name-input').focus(), 200);
  }
}

function handleSaveName() {
  const name = document.getElementById('name-input').value.trim();
  if (name.length < 1) { showToast('⚠️ Please enter your name'); return; }
  myName = name;
  socket.emit('register', { phoneNumber: myPhone, name: myName });
}

// ============================================================
//  LOGOUT
// ============================================================
function handleLogout() {
  if (!confirm('Are you sure you want to logout?')) return;
  lsRemove(LS_PHONE);
  lsRemove(LS_NAME);
  // Keep contacts so they're remembered next login
  myPhone = '';
  myName  = '';
  currentChat = '';
  chatMessages.clear();
  chatContacts.clear();
  showScreen('login');
  showToast('👋 Logged out');
}

// ============================================================
//  HOME UI UPDATE
// ============================================================
function updateHomeUI() {
  const initials = myName ? myName.substring(0, 2).toUpperCase() : myPhone.slice(-2);
  document.getElementById('my-avatar-initials').textContent = initials;
  // Load saved phantom contacts into contacts tab
  renderSavedContacts();
}

// ============================================================
//  OPEN CHAT
// ============================================================
function handleOpenChat() {
  const phone = document.getElementById('search-phone').value.trim();
  if (phone.length < 10) { showToast('⚠️ Enter a valid 10-digit number'); return; }
  if (phone === myPhone)  { showToast('⚠️ You cannot chat with yourself'); return; }
  openChat(phone, getNameForPhone(phone));
}

function openChat(phone, name) {
  currentChat     = phone;
  currentChatName = name || getNameForPhone(phone);

  const initials = currentChatName.substring(0, 2).toUpperCase();
  document.getElementById('chat-header-avatar').textContent = initials;
  document.getElementById('chat-header-name').textContent   = currentChatName;
  document.getElementById('chat-header-status').textContent = 'Checking…';

  setTimeout(() => socket.emit('check-user', { phoneNumber: phone }), 1500);

  const msgs = document.getElementById('chat-messages');
  while (msgs.children.length > 1) msgs.removeChild(msgs.lastChild);

  const history = chatMessages.get(phone) || [];
  history.forEach(m => renderMessage(m));
  scrollToBottom();

  if (!chatContacts.has(phone)) {
    updateChatContact(phone, currentChatName, 'Chat started', Date.now());
    renderChatList();
  }

  document.getElementById('search-phone').value = '';
  showScreen('chat');
}

// ============================================================
//  MESSAGING
// ============================================================
function handleSendMessage() {
  const input = document.getElementById('message-input');
  const text  = input.value.trim();
  if (!text || !currentChat) return;

  const messageId = Date.now() + '_' + Math.random();
  const timestamp = Date.now();

  socket.emit('send-message', { to: currentChat, from: myPhone, message: text, messageId });

  const msgObj = { from: myPhone, fromName: myName, message: text, timestamp, mine: true };
  storeMessage(currentChat, msgObj);
  updateChatContact(currentChat, currentChatName, text, timestamp);
  renderMessage(msgObj);
  scrollToBottom();
  renderChatList();

  input.value = '';
  input.style.height = 'auto';
}

function storeMessage(phone, msgObj) {
  if (!chatMessages.has(phone)) chatMessages.set(phone, []);
  chatMessages.get(phone).push(msgObj);
}

function updateChatContact(phone, name, lastMsg, lastTime) {
  chatContacts.set(phone, { name: name || phone, lastMsg, lastTime });
}

function renderMessage({ fromName, message, timestamp, mine }) {
  const wrap   = document.createElement('div');
  wrap.className = `msg-bubble-wrap ${mine ? 'sent' : 'received'}`;
  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${mine ? 'sent' : 'received'}`;
  bubble.textContent = message;
  const time   = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(timestamp);
  wrap.appendChild(bubble);
  wrap.appendChild(time);
  document.getElementById('chat-messages').appendChild(wrap);
}

function renderChatList() {
  const list        = document.getElementById('contacts-list');
  const placeholder = document.getElementById('no-chats-placeholder');
  list.querySelectorAll('.contact-item').forEach(el => el.remove());

  if (chatContacts.size === 0) { placeholder.style.display = 'block'; return; }
  placeholder.style.display = 'none';

  const sorted = [...chatContacts.entries()].sort((a, b) => b[1].lastTime - a[1].lastTime);
  sorted.forEach(([phone, { name, lastMsg, lastTime }]) => {
    const initials = (name || phone).substring(0, 2).toUpperCase();
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.innerHTML = `
      <div class="contact-avatar">${initials}</div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(name || phone)}</div>
        <div class="contact-preview">${escapeHtml((lastMsg || '').substring(0, 50))}</div>
      </div>
      <div class="contact-time">${formatTime(lastTime)}</div>
    `;
    item.addEventListener('click', () => openChat(phone, name));
    list.appendChild(item);
  });
}

// ============================================================
//  PHANTOM CONTACTS TAB
// ============================================================
function renderPhantomContacts(userList) {
  const list = document.getElementById('phantom-contacts-list');
  list.innerHTML = '';

  // Filter out self
  const others = userList.filter(u => u.phoneNumber !== myPhone);

  // Also show saved contacts that are offline
  const savedContacts = loadSavedContacts();
  const onlinePhones  = new Set(others.map(u => u.phoneNumber));

  // Merge: online users first, then offline saved contacts
  const allContacts = [...others.map(u => ({ ...u, isOnline: true }))];
  savedContacts.forEach(c => {
    if (c.phone !== myPhone && !onlinePhones.has(c.phone)) {
      allContacts.push({ phoneNumber: c.phone, name: c.name, isOnline: false });
    }
  });

  if (allContacts.length === 0) {
    list.innerHTML = `
      <div class="no-chats">
        <div class="icon">👥</div>
        <p>No Phantom users found</p>
        <small>Users appear here when they join Phantom</small>
      </div>`;
    return;
  }

  allContacts.forEach(u => {
    const initials  = (u.name || u.phoneNumber).substring(0, 2).toUpperCase();
    const statusDot = u.isOnline ? 'online-dot' : 'offline-dot';
    const statusTxt = u.isOnline ? '🟢 Online' : '⭕ Offline';
    const item = document.createElement('div');
    item.className = 'contact-item phantom-contact-item';
    item.innerHTML = `
      <div class="contact-avatar" style="position:relative;">
        ${initials}
        <div class="${statusDot}"></div>
      </div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(u.name || u.phoneNumber)}</div>
        <div class="contact-preview">${statusTxt}</div>
      </div>
      <button class="btn-chat-contact">Chat →</button>
    `;
    item.querySelector('.btn-chat-contact').addEventListener('click', () => {
      switchTab('chats');
      openChat(u.phoneNumber, u.name || u.phoneNumber);
    });
    list.appendChild(item);
  });
}

function renderSavedContacts() {
  const saved = loadSavedContacts().filter(c => c.phone !== myPhone);
  if (saved.length > 0) {
    renderPhantomContacts(saved.map(c => ({ phoneNumber: c.phone, name: c.name, isOnline: false })));
  }
}

// ============================================================
//  CALLING — OUTGOING
// ============================================================
async function startCall(type) {
  if (!currentChat) return;
  currentCallType = type;

  const displayName = currentChatName || getNameForPhone(currentChat);
  const initials    = displayName.substring(0, 2).toUpperCase();

  document.getElementById('calling-avatar').textContent    = initials;
  document.getElementById('calling-number').textContent    = displayName;
  document.getElementById('calling-type-label').textContent =
    type === 'video' ? '📹 Video Call' : '📞 Audio Call (Earpiece)';

  showScreen('calling');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: type === 'video'
    });

    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    setupPeerConnectionEvents(currentChat);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('call-offer', { to: currentChat, from: myPhone, offer, callType: type });

  } catch (err) {
    console.error('Call error:', err);
    showToast('❌ Could not access microphone/camera');
    cleanupCall();
    showScreen('chat');
  }
}

// ============================================================
//  CALLING — INCOMING ACCEPT
// ============================================================
async function acceptCall() {
  currentChat     = pendingCallFrom;
  currentChatName = pendingCallName;
  document.getElementById('ringtone').pause();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: currentCallType === 'video'
    });

    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    setupPeerConnectionEvents(pendingCallFrom);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingOffer));
    for (const c of iceCandidateQueue) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
    }
    iceCandidateQueue = [];

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('call-answer', { to: pendingCallFrom, from: myPhone, answer });

    // FIX: single trigger via onconnectionstatechange

  } catch (err) {
    console.error('Accept call error:', err);
    showToast('❌ Could not access microphone/camera');
    socket.emit('call-decline', { to: pendingCallFrom });
    pendingOffer = null;
    pendingCallFrom = null;
    pendingCallName = '';
    showScreen('home');
  }
}

// ============================================================
//  PEER CONNECTION
// ============================================================
function setupPeerConnectionEvents(remotePhone) {
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: remotePhone, candidate: event.candidate });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('[WebRTC] State:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'connected') {
      showActiveCallUI();
    }
    if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
      showToast('📵 Call disconnected');
      cleanupCall();
      showScreen(currentChat ? 'chat' : 'home');
    }
  };

  const remoteStream = new MediaStream();
  peerConnection.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
    if (currentCallType === 'video') {
      document.getElementById('remote-video').srcObject = remoteStream;
    }
  };

  if (currentCallType === 'video' && localStream) {
    document.getElementById('local-video').srcObject = localStream;
  }
}

// ============================================================
//  ACTIVE CALL UI
// ============================================================
function showActiveCallUI() {
  const displayName = currentChatName || pendingCallName || getNameForPhone(currentChat || pendingCallFrom);
  const initials    = displayName.substring(0, 2).toUpperCase();

  document.getElementById('active-call-avatar').textContent = initials;
  document.getElementById('active-call-number').textContent = displayName;

  const videoContainer = document.getElementById('video-container');
  const audioUI        = document.getElementById('audio-call-ui');
  const videoBtn       = document.getElementById('btn-toggle-video');

  if (currentCallType === 'video') {
    videoContainer.classList.remove('hidden');
    audioUI.classList.add('hidden');
    videoBtn.classList.remove('hidden');
    if (localStream) document.getElementById('local-video').srcObject = localStream;
  } else {
    // AUDIO CALL — earpiece only, no speaker button
    videoContainer.classList.add('hidden');
    audioUI.classList.remove('hidden');
    videoBtn.classList.add('hidden');
    // Force earpiece on web (best effort)
    if (localStream) {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(localStream);
      source.connect(audioCtx.destination);
    }
  }

  showScreen('call-active');
  startCallTimer();

  pendingOffer    = null;
  pendingCallFrom = null;
  pendingCallName = '';
}

// ============================================================
//  CALL CONTROLS
// ============================================================
function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  document.getElementById('btn-toggle-mute').textContent = isMuted ? '🔇' : '🎙️';
  document.getElementById('mute-label').textContent = isMuted ? 'Unmute' : 'Mute';
}

function toggleVideo() {
  if (!localStream) return;
  const tracks = localStream.getVideoTracks();
  if (tracks.length === 0) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  document.getElementById('btn-toggle-video').textContent = enabled ? '📷' : '🚫';
  document.getElementById('video-label').textContent = enabled ? 'Cam' : 'CamOff';
}

function startCallTimer() {
  callSeconds = 0;
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    const el = document.getElementById('call-timer');
    if (el) el.textContent = `${m}:${s}`;
  }, 1000);
}

// ============================================================
//  CLEANUP
// ============================================================
function cleanupCall() {
  clearInterval(callTimerInterval);
  callSeconds = 0;
  isMuted     = false;

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  const rv = document.getElementById('remote-video');
  const lv = document.getElementById('local-video');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;

  pendingOffer    = null;
  pendingCallFrom = null;
  pendingCallName = '';
  currentCallType = null;
  iceCandidateQueue = [];
}

// ============================================================
//  HELPERS
// ============================================================
function getCurrentScreen() {
  const active = document.querySelector('.screen.active');
  return active ? active.id.replace('screen-', '') : '';
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function scrollToBottom() {
  const c = document.getElementById('chat-messages');
  c.scrollTop = c.scrollHeight;
}
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}
