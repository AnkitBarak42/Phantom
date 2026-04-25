// ============================================================
//  PHANTOM v3 — Frontend Logic
//  Echo fix + Group calls + One-time login + Names
// ============================================================

const SERVER_URL = 'https://phantom-d603.onrender.com';

// ============================================================
//  STATE
// ============================================================
let socket           = null;
let myPhone          = '';
let myName           = '';
let myOTP            = '';
let currentChat      = '';
let currentChatName  = '';
let peerConnection   = null;
let localStream      = null;
let currentCallType  = null;
let pendingOffer     = null;
let pendingCallFrom  = null;
let pendingCallName  = '';
let isMuted          = false;
let isVideoPaused    = false;
let callTimerInterval = null;
let callSeconds      = 0;
let currentTab       = 'chats';
let iceCandidateQueue = [];

// Group call state
let currentRoomId    = null;
let groupCallType    = 'audio';
let groupStream      = null;
let groupPeers       = new Map(); // phoneNumber -> RTCPeerConnection
let groupIceQueues   = new Map(); // phoneNumber -> [candidates]
let groupTimerInterval = null;
let groupSeconds     = 0;
let isGroupMuted     = false;
let isGroupVideoPaused = false;

// RAM only
const chatMessages = new Map();
const chatContacts = new Map();

// localStorage keys
const LS_PHONE    = 'phantom_phone';
const LS_NAME     = 'phantom_name';
const LS_CONTACTS = 'phantom_contacts';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',              username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',             username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

// ============================================================
//  LOCALSTORAGE HELPERS
// ============================================================
function lsGet(k)    { try { return localStorage.getItem(k); }     catch(e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); }         catch(e) {} }
function lsRemove(k) { try { localStorage.removeItem(k); }         catch(e) {} }

function loadSavedContacts() {
  try { return JSON.parse(lsGet(LS_CONTACTS) || '[]'); } catch(e) { return []; }
}
function saveContactToLS(phone, name) {
  const list = loadSavedContacts();
  const idx  = list.findIndex(c => c.phone === phone);
  if (idx >= 0) list[idx].name = name; else list.push({ phone, name });
  lsSet(LS_CONTACTS, JSON.stringify(list));
}
function getNameForPhone(phone) {
  const saved = loadSavedContacts().find(c => c.phone === phone);
  if (saved) return saved.name;
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

  const savedPhone = lsGet(LS_PHONE);
  const savedName  = lsGet(LS_NAME);
  if (savedPhone && savedName) {
    myPhone = savedPhone;
    myName  = savedName;
    socket.on('connect', () => socket.emit('register', { phoneNumber: myPhone, name: myName }));
    updateHomeUI();
    showScreen('home');
  } else {
    showScreen('login');
  }
});

// ============================================================
//  SCREEN + TAB
// ============================================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}
function getCurrentScreen() {
  const a = document.querySelector('.screen.active');
  return a ? a.id.replace('screen-', '') : '';
}
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`tab-content-${tab}`).classList.add('active');
  if (tab === 'contacts') socket.emit('get-users');
}

// ============================================================
//  SOCKET EVENTS
// ============================================================
function setupSocketEvents() {

  socket.on('connect', () => {
    if (myPhone && myName) socket.emit('register', { phoneNumber: myPhone, name: myName });
  });

  socket.on('registered', ({ success, phoneNumber, name }) => {
    if (!success) return;
    myPhone = phoneNumber;
    myName  = name || phoneNumber;
    lsSet(LS_PHONE, myPhone);
    lsSet(LS_NAME, myName);
    updateHomeUI();
    if (getCurrentScreen() !== 'home') { showScreen('home'); showToast(`✅ Welcome, ${myName}!`); }
  });

  socket.on('phantom-users', (userList) => {
    userList.forEach(u => { if (u.phoneNumber !== myPhone) saveContactToLS(u.phoneNumber, u.name); });
    renderPhantomContacts(userList);
  });

  socket.on('user-status', ({ phoneNumber, isOnline, name }) => {
    if (name) saveContactToLS(phoneNumber, name);
    if (phoneNumber === currentChat) {
      document.getElementById('chat-header-status').textContent = isOnline ? '🟢 Online' : '⭕ Offline';
      if (name && name !== phoneNumber) {
        document.getElementById('chat-header-name').textContent = name;
        currentChatName = name;
      }
    }
  });

  socket.on('receive-message', ({ from, fromName, message, timestamp }) => {
    if (fromName) saveContactToLS(from, fromName);
    const displayName = fromName || getNameForPhone(from);
    storeMessage(from, { from, fromName: displayName, message, timestamp, mine: false });
    updateChatContact(from, displayName, message, timestamp);
    if (currentChat === from) { renderMessage({ fromName: displayName, message, timestamp, mine: false }); scrollToBottom(); }
    else { showToast(`💬 ${displayName}: ${message.substring(0, 35)}`); renderChatList(); }
  });

  socket.on('user-offline', ({ phoneNumber }) => {
    showToast(`❌ ${getNameForPhone(phoneNumber)} is not online`);
    if (getCurrentScreen() === 'calling') showScreen('chat');
  });

  // ---- 1-to-1 INCOMING CALL ----
  socket.on('incoming-call', ({ from, fromName, offer, callType }) => {
    pendingOffer    = offer;
    pendingCallFrom = from;
    pendingCallName = fromName || getNameForPhone(from);
    currentCallType = callType;
    if (fromName) saveContactToLS(from, fromName);

    const initials = pendingCallName.substring(0, 2).toUpperCase();
    document.getElementById('incoming-avatar').textContent     = initials;
    document.getElementById('incoming-number').textContent     = pendingCallName;
    document.getElementById('incoming-type-label').textContent = callType === 'video' ? '📹 Video Call' : '📞 Audio Call';
    document.getElementById('incoming-call-status').textContent = 'Incoming Call…';

    const ringtone = document.getElementById('ringtone');
    ringtone.currentTime = 0;
    ringtone.play().catch(() => {});
    showScreen('incoming');
  });

  socket.on('call-answered', async ({ answer }) => {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      for (const c of iceCandidateQueue) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
      }
      iceCandidateQueue = [];
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    if (!candidate) return;
    if (peerConnection && peerConnection.remoteDescription) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch(e) { console.warn('ICE:', e); }
    } else {
      iceCandidateQueue.push(candidate);
    }
  });

  socket.on('call-declined', () => { showToast('❌ Call declined'); cleanupCall(); showScreen(currentChat ? 'chat' : 'home'); });
  socket.on('call-ended',    () => { showToast('📵 Call ended');    cleanupCall(); showScreen(currentChat ? 'chat' : 'home'); });

  // ---- GROUP CALL EVENTS ----
  socket.on('group-existing-members', async ({ roomId, members, callType }) => {
    // We joined — now create peer connections with everyone already in room
    for (const member of members) {
      if (member.phoneNumber === myPhone) continue;
      await createGroupPeer(member.phoneNumber, member.name, roomId, callType, true /* initiator */);
    }
    updateGroupUI();
  });

  socket.on('group-user-joined', async ({ roomId, phoneNumber, name, callType }) => {
    if (phoneNumber === myPhone) return;
    showToast(`👥 ${name} joined the call`);
    saveContactToLS(phoneNumber, name);
    // New person joined — they will initiate offer to us, we just wait
    // But create a peer entry so we're ready
    if (!groupPeers.has(phoneNumber)) {
      await createGroupPeer(phoneNumber, name, roomId, callType, false /* not initiator */);
    }
    updateGroupUI();
  });

  socket.on('group-offer', async ({ from, fromName, roomId, offer }) => {
    if (from === myPhone) return;
    saveContactToLS(from, fromName);
    let pc = groupPeers.get(from);
    if (!pc) {
      pc = await createGroupPeer(from, fromName, roomId, groupCallType, false);
    }
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    // Drain ICE queue
    const queue = groupIceQueues.get(from) || [];
    for (const c of queue) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
    }
    groupIceQueues.set(from, []);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('group-answer', { to: from, roomId, answer });
  });

  socket.on('group-answer', async ({ from, answer }) => {
    const pc = groupPeers.get(from);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      const queue = groupIceQueues.get(from) || [];
      for (const c of queue) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
      }
      groupIceQueues.set(from, []);
    }
  });

  socket.on('group-ice', async ({ from, candidate }) => {
    const pc = groupPeers.get(from);
    if (pc && pc.remoteDescription) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    } else {
      if (!groupIceQueues.has(from)) groupIceQueues.set(from, []);
      groupIceQueues.get(from).push(candidate);
    }
  });

  socket.on('group-user-left', ({ phoneNumber }) => {
    const name = getNameForPhone(phoneNumber);
    showToast(`👋 ${name} left the call`);
    removeGroupPeer(phoneNumber);
    updateGroupUI();
  });
}

// ============================================================
//  UI EVENTS
// ============================================================
function setupUIEvents() {

  // LOGIN
  document.getElementById('btn-send-otp').addEventListener('click', handleSendOTP);
  document.getElementById('phone-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleSendOTP(); });

  // OTP
  document.getElementById('btn-verify-otp').addEventListener('click', handleVerifyOTP);
  document.getElementById('btn-back-login').addEventListener('click', () => showScreen('login'));
  const otpBoxes = document.querySelectorAll('.otp-box');
  otpBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(-1);
      if (box.value && i < otpBoxes.length - 1) otpBoxes[i + 1].focus();
    });
    box.addEventListener('keydown', e => { if (e.key === 'Backspace' && !box.value && i > 0) otpBoxes[i - 1].focus(); });
  });

  // NAME
  document.getElementById('btn-save-name').addEventListener('click', handleSaveName);
  document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleSaveName(); });

  // HOME
  document.getElementById('btn-open-chat').addEventListener('click', handleOpenChat);
  document.getElementById('search-phone').addEventListener('keydown', e => { if (e.key === 'Enter') handleOpenChat(); });
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  document.getElementById('btn-refresh-contacts').addEventListener('click', () => { socket.emit('get-users'); showToast('🔄 Refreshing…'); });
  document.getElementById('btn-group-call-home').addEventListener('click', () => showScreen('group-setup'));

  // CHAT
  document.getElementById('btn-back-home').addEventListener('click', () => { currentChat = ''; currentChatName = ''; showScreen('home'); });
  document.getElementById('btn-send-msg').addEventListener('click', handleSendMessage);
  document.getElementById('message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } });
  document.getElementById('btn-audio-call').addEventListener('click', () => startCall('audio'));
  document.getElementById('btn-video-call').addEventListener('click', () => startCall('video'));

  // OUTGOING CALL
  document.getElementById('btn-cancel-call').addEventListener('click', () => { socket.emit('call-end', { to: currentChat }); cleanupCall(); showScreen('chat'); });

  // INCOMING CALL
  document.getElementById('btn-accept-call').addEventListener('click', acceptCall);
  document.getElementById('btn-decline-call').addEventListener('click', () => {
    document.getElementById('ringtone').pause();
    socket.emit('call-decline', { to: pendingCallFrom });
    pendingOffer = null; pendingCallFrom = null; pendingCallName = '';
    showScreen(currentChat ? 'chat' : 'home');
  });

  // ACTIVE CALL
  document.getElementById('btn-end-call').addEventListener('click', () => { socket.emit('call-end', { to: currentChat || pendingCallFrom }); cleanupCall(); showScreen(currentChat ? 'chat' : 'home'); });
  document.getElementById('btn-toggle-mute').addEventListener('click', toggleMute);
  document.getElementById('btn-toggle-video').addEventListener('click', toggleVideo);

  // GROUP SETUP
  document.getElementById('btn-back-from-group-setup').addEventListener('click', () => showScreen('home'));
  document.getElementById('btn-create-room').addEventListener('click', handleCreateRoom);
  document.getElementById('btn-join-room').addEventListener('click', handleJoinRoom);
  document.getElementById('room-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleJoinRoom(); });

  // GROUP CALL CONTROLS
  document.getElementById('btn-group-mute').addEventListener('click', toggleGroupMute);
  document.getElementById('btn-group-end').addEventListener('click', leaveGroupCall);
  document.getElementById('btn-group-video').addEventListener('click', toggleGroupVideo);
}

// ============================================================
//  AUTH
// ============================================================
function handleSendOTP() {
  const phone = document.getElementById('phone-input').value.trim();
  if (phone.length < 10) { showToast('⚠️ Enter a valid 10-digit number'); return; }
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
  const savedName = lsGet(LS_NAME);
  if (savedName) { myName = savedName; socket.emit('register', { phoneNumber: myPhone, name: myName }); }
  else { showScreen('name'); setTimeout(() => document.getElementById('name-input').focus(), 200); }
}

function handleSaveName() {
  const name = document.getElementById('name-input').value.trim();
  if (name.length < 1) { showToast('⚠️ Please enter your name'); return; }
  myName = name;
  socket.emit('register', { phoneNumber: myPhone, name: myName });
}

function handleLogout() {
  if (!confirm('Are you sure you want to logout?')) return;
  lsRemove(LS_PHONE); lsRemove(LS_NAME);
  myPhone = ''; myName = ''; currentChat = '';
  chatMessages.clear(); chatContacts.clear();
  showScreen('login'); showToast('👋 Logged out');
}

function updateHomeUI() {
  const initials = myName ? myName.substring(0, 2).toUpperCase() : myPhone.slice(-2);
  document.getElementById('my-avatar-initials').textContent = initials;
  renderSavedContacts();
}

// ============================================================
//  CHAT
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
  const initials  = currentChatName.substring(0, 2).toUpperCase();
  document.getElementById('chat-header-avatar').textContent   = initials;
  document.getElementById('chat-header-name').textContent     = currentChatName;
  document.getElementById('chat-header-status').textContent   = 'Checking…';
  setTimeout(() => socket.emit('check-user', { phoneNumber: phone }), 1500);
  const msgs = document.getElementById('chat-messages');
  while (msgs.children.length > 1) msgs.removeChild(msgs.lastChild);
  (chatMessages.get(phone) || []).forEach(m => renderMessage(m));
  scrollToBottom();
  if (!chatContacts.has(phone)) { updateChatContact(phone, currentChatName, 'Chat started', Date.now()); renderChatList(); }
  document.getElementById('search-phone').value = '';
  showScreen('chat');
}

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
  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(timestamp);
  wrap.appendChild(bubble);
  wrap.appendChild(time);
  document.getElementById('chat-messages').appendChild(wrap);
}
function renderChatList() {
  const list = document.getElementById('contacts-list');
  const ph   = document.getElementById('no-chats-placeholder');
  list.querySelectorAll('.contact-item').forEach(el => el.remove());
  if (chatContacts.size === 0) { ph.style.display = 'block'; return; }
  ph.style.display = 'none';
  [...chatContacts.entries()].sort((a,b) => b[1].lastTime - a[1].lastTime).forEach(([phone, { name, lastMsg, lastTime }]) => {
    const initials = (name||phone).substring(0,2).toUpperCase();
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.innerHTML = `<div class="contact-avatar">${initials}</div><div class="contact-info"><div class="contact-name">${escapeHtml(name||phone)}</div><div class="contact-preview">${escapeHtml((lastMsg||'').substring(0,50))}</div></div><div class="contact-time">${formatTime(lastTime)}</div>`;
    item.addEventListener('click', () => openChat(phone, name));
    list.appendChild(item);
  });
}
function renderPhantomContacts(userList) {
  const list    = document.getElementById('phantom-contacts-list');
  list.innerHTML = '';
  const others   = userList.filter(u => u.phoneNumber !== myPhone);
  const saved    = loadSavedContacts();
  const onlineSet = new Set(others.map(u => u.phoneNumber));
  const all      = [...others.map(u => ({ ...u, isOnline: true }))];
  saved.forEach(c => { if (c.phone !== myPhone && !onlineSet.has(c.phone)) all.push({ phoneNumber: c.phone, name: c.name, isOnline: false }); });
  if (all.length === 0) { list.innerHTML = `<div class="no-chats"><div class="icon">👥</div><p>No Phantom users found</p><small>Users appear when they join</small></div>`; return; }
  all.forEach(u => {
    const initials = (u.name||u.phoneNumber).substring(0,2).toUpperCase();
    const item = document.createElement('div');
    item.className = 'contact-item phantom-contact-item';
    item.innerHTML = `<div class="contact-avatar" style="position:relative;">${initials}<div class="${u.isOnline ? 'online-dot' : 'offline-dot'}"></div></div><div class="contact-info"><div class="contact-name">${escapeHtml(u.name||u.phoneNumber)}</div><div class="contact-preview">${u.isOnline ? '🟢 Online' : '⭕ Offline'}</div></div><button class="btn-chat-contact">Chat →</button>`;
    item.querySelector('.btn-chat-contact').addEventListener('click', () => { switchTab('chats'); openChat(u.phoneNumber, u.name||u.phoneNumber); });
    list.appendChild(item);
  });
}
function renderSavedContacts() {
  const saved = loadSavedContacts().filter(c => c.phone !== myPhone);
  if (saved.length > 0) renderPhantomContacts(saved.map(c => ({ phoneNumber: c.phone, name: c.name, isOnline: false })));
}

// ============================================================
//  1-to-1 CALLING
// ============================================================
async function startCall(type) {
  if (!currentChat) return;
  currentCallType = type;
  const displayName = currentChatName || getNameForPhone(currentChat);
  document.getElementById('calling-avatar').textContent     = displayName.substring(0,2).toUpperCase();
  document.getElementById('calling-number').textContent     = displayName;
  document.getElementById('calling-type-label').textContent = type === 'video' ? '📹 Video Call' : '📞 Audio Call';
  showScreen('calling');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      // ECHO FIX: enable all echo/noise suppression constraints
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        channelCount:     1
      },
      video: type === 'video'
    });
    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    setupPeerEvents(currentChat);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('call-offer', { to: currentChat, from: myPhone, offer, callType: type });
  } catch(err) {
    console.error(err);
    showToast('❌ Could not access microphone/camera');
    cleanupCall(); showScreen('chat');
  }
}

async function acceptCall() {
  currentChat     = pendingCallFrom;
  currentChatName = pendingCallName;
  document.getElementById('ringtone').pause();
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: currentCallType === 'video'
    });
    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    setupPeerEvents(pendingCallFrom);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingOffer));
    for (const c of iceCandidateQueue) { try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {} }
    iceCandidateQueue = [];
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('call-answer', { to: pendingCallFrom, from: myPhone, answer });
  } catch(err) {
    console.error(err);
    showToast('❌ Could not access microphone/camera');
    socket.emit('call-decline', { to: pendingCallFrom });
    pendingOffer = null; pendingCallFrom = null; pendingCallName = '';
    showScreen('home');
  }
}

function setupPeerEvents(remotePhone) {
  peerConnection.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: remotePhone, candidate: e.candidate });
  };
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') showActiveCallUI();
    if (['disconnected','failed','closed'].includes(peerConnection.connectionState)) {
      showToast('📵 Call disconnected'); cleanupCall(); showScreen(currentChat ? 'chat' : 'home');
    }
  };
  const remoteStream = new MediaStream();
  peerConnection.ontrack = e => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    if (currentCallType === 'video') {
      document.getElementById('remote-video').srcObject = remoteStream;
    } else {
      // ECHO FIX: route audio to <audio> element (earpiece) NOT to speakers
      const audioEl = document.getElementById('remote-audio');
      audioEl.srcObject = remoteStream;
      audioEl.play().catch(() => {});
    }
  };
  if (currentCallType === 'video' && localStream) {
    document.getElementById('local-video').srcObject = localStream;
  }
}

function showActiveCallUI() {
  const displayName = currentChatName || pendingCallName || getNameForPhone(currentChat || pendingCallFrom);
  document.getElementById('active-call-avatar').textContent = displayName.substring(0,2).toUpperCase();
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
    videoContainer.classList.add('hidden');
    audioUI.classList.remove('hidden');
    videoBtn.classList.add('hidden');
  }
  showScreen('call-active');
  startCallTimer();
  pendingOffer = null; pendingCallFrom = null; pendingCallName = '';
}

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
  if (!tracks.length) return;
  isVideoPaused = !isVideoPaused;
  tracks.forEach(t => t.enabled = !isVideoPaused);
  document.getElementById('btn-toggle-video').textContent = isVideoPaused ? '🚫' : '📷';
  document.getElementById('video-label').textContent = isVideoPaused ? 'CamOff' : 'Cam';
}

function startCallTimer() {
  callSeconds = 0; clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const el = document.getElementById('call-timer');
    if (el) el.textContent = fmtTimer(callSeconds);
  }, 1000);
}

function cleanupCall() {
  clearInterval(callTimerInterval); callSeconds = 0; isMuted = false; isVideoPaused = false;
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  const rv = document.getElementById('remote-video');
  const lv = document.getElementById('local-video');
  const ra = document.getElementById('remote-audio');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;
  if (ra) ra.srcObject = null;
  pendingOffer = null; pendingCallFrom = null; pendingCallName = null;
  currentCallType = null; iceCandidateQueue = [];
}

// ============================================================
//  GROUP CALL
// ============================================================
function selectGroupType(type) {
  groupCallType = type;
  document.getElementById('gbtn-audio').classList.toggle('active', type === 'audio');
  document.getElementById('gbtn-video').classList.toggle('active', type === 'video');
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function handleCreateRoom() {
  const roomId = generateRoomCode();
  document.getElementById('room-code-input').value = roomId;
  await joinRoom(roomId);
}

async function handleJoinRoom() {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (code.length < 4) { showToast('⚠️ Enter a valid room code'); return; }
  await joinRoom(code);
}

async function joinRoom(roomId) {
  currentRoomId = roomId;
  try {
    groupStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: groupCallType === 'video'
    });
  } catch(err) {
    showToast('❌ Could not access microphone/camera'); return;
  }

  // Setup group call UI
  document.getElementById('group-room-code-display').textContent = `Room: ${roomId}`;
  document.getElementById('group-member-count').textContent = '👥 1';
  document.getElementById('group-call-timer').textContent = '00:00';

  const videoGrid = document.getElementById('group-video-grid');
  const audioUI   = document.getElementById('group-audio-ui');
  const videoBtn  = document.getElementById('btn-group-video');

  if (groupCallType === 'video') {
    videoGrid.classList.remove('hidden');
    audioUI.classList.add('hidden');
    videoBtn.classList.remove('hidden');
    document.getElementById('group-local-video').srcObject = groupStream;
    document.getElementById('local-tile-label').textContent = myName || myPhone;
  } else {
    videoGrid.classList.add('hidden');
    audioUI.classList.remove('hidden');
    videoBtn.classList.add('hidden');
    renderGroupParticipant(myPhone, myName || myPhone, true);
  }

  showScreen('group-call');
  startGroupTimer();

  // Join room on server — server will tell us who else is there
  socket.emit('group-join', { roomId, callType: groupCallType });
}

async function createGroupPeer(phone, name, roomId, callType, isInitiator) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  groupPeers.set(phone, pc);
  groupIceQueues.set(phone, []);

  // Add local tracks
  if (groupStream) {
    groupStream.getTracks().forEach(t => pc.addTrack(t, groupStream));
  }

  // ICE
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('group-ice', { to: phone, roomId, candidate: e.candidate });
  };

  // Remote stream
  const remoteStream = new MediaStream();
  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    if (callType === 'video') {
      addVideoTile(phone, name, remoteStream);
    } else {
      addAudioStream(phone, name, remoteStream);
    }
    updateGroupUI();
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.connectionState)) {
      removeGroupPeer(phone);
      updateGroupUI();
    }
  };

  // If initiator → create and send offer
  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('group-offer', { to: phone, roomId, offer });
  }

  return pc;
}

function addVideoTile(phone, name, stream) {
  const grid = document.getElementById('group-video-grid');
  let tile = document.getElementById(`tile-${phone}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${phone}`;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = name;
    tile.appendChild(video);
    tile.appendChild(label);
    grid.appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
}

function addAudioStream(phone, name, stream) {
  // Create hidden audio element for each remote peer
  let audioEl = document.getElementById(`audio-${phone}`);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = `audio-${phone}`;
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
  renderGroupParticipant(phone, name, false);
}

function renderGroupParticipant(phone, name, isMe) {
  const list = document.getElementById('group-participants-list');
  if (document.getElementById(`participant-${phone}`)) return;
  const item = document.createElement('div');
  item.className = 'group-participant';
  item.id = `participant-${phone}`;
  item.innerHTML = `<div class="group-avatar">${(name||phone).substring(0,2).toUpperCase()}</div><div class="group-pname">${escapeHtml(name||phone)}${isMe ? ' (You)' : ''}</div><div class="group-mic">🎙️</div>`;
  list.appendChild(item);
}

function removeGroupPeer(phone) {
  const pc = groupPeers.get(phone);
  if (pc) { pc.close(); groupPeers.delete(phone); }
  groupIceQueues.delete(phone);
  // Remove video tile
  const tile = document.getElementById(`tile-${phone}`);
  if (tile) tile.remove();
  // Remove audio element
  const audioEl = document.getElementById(`audio-${phone}`);
  if (audioEl) audioEl.remove();
  // Remove participant item
  const item = document.getElementById(`participant-${phone}`);
  if (item) item.remove();
}

function updateGroupUI() {
  const count = groupPeers.size + 1; // +1 for self
  document.getElementById('group-member-count').textContent = `👥 ${count}`;
}

function toggleGroupMute() {
  if (!groupStream) return;
  isGroupMuted = !isGroupMuted;
  groupStream.getAudioTracks().forEach(t => t.enabled = !isGroupMuted);
  document.getElementById('btn-group-mute').textContent = isGroupMuted ? '🔇' : '🎙️';
  document.getElementById('group-mute-label').textContent = isGroupMuted ? 'Unmute' : 'Mute';
}

function toggleGroupVideo() {
  if (!groupStream) return;
  isGroupVideoPaused = !isGroupVideoPaused;
  groupStream.getVideoTracks().forEach(t => t.enabled = !isGroupVideoPaused);
  document.getElementById('btn-group-video').textContent = isGroupVideoPaused ? '🚫' : '📷';
  document.getElementById('group-video-label').textContent = isGroupVideoPaused ? 'CamOff' : 'Cam';
}

function leaveGroupCall() {
  socket.emit('group-leave', { roomId: currentRoomId });
  cleanupGroupCall();
  showScreen('home');
}

function cleanupGroupCall() {
  clearInterval(groupTimerInterval); groupSeconds = 0;
  groupPeers.forEach((pc, phone) => removeGroupPeer(phone));
  groupPeers.clear(); groupIceQueues.clear();
  if (groupStream) { groupStream.getTracks().forEach(t => t.stop()); groupStream = null; }
  // Clear video tiles except local
  document.getElementById('group-video-grid').innerHTML = `<div class="video-tile" id="local-tile"><video id="group-local-video" autoplay playsinline muted></video><div class="tile-label" id="local-tile-label">You</div></div>`;
  document.getElementById('group-participants-list').innerHTML = '';
  currentRoomId = null; isGroupMuted = false; isGroupVideoPaused = false;
}

function startGroupTimer() {
  groupSeconds = 0; clearInterval(groupTimerInterval);
  groupTimerInterval = setInterval(() => {
    groupSeconds++;
    const el = document.getElementById('group-call-timer');
    if (el) el.textContent = fmtTimer(groupSeconds);
  }, 1000);
}

// ============================================================
//  HELPERS
// ============================================================
function fmtTimer(s) {
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function scrollToBottom() {
  const c = document.getElementById('chat-messages'); c.scrollTop = c.scrollHeight;
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}
