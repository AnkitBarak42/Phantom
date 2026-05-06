// ============================================================
//  PHANTOM v4
//  - Names only (no numbers shown)
//  - Add contacts (fetch name from server)
//  - One device per number
//  - WhatsApp-style group call (no room code)
//  - Echo fix
// ============================================================

const SERVER_URL = 'https://phantom-d603.onrender.com';

// ============================================================
//  STATE
// ============================================================
let socket           = null;
let myEmail          = '';
let myName           = '';
let myDeviceToken    = '';
let otpCountdownInterval = null;
let currentChat      = '';       // phone (internal only)
let currentChatName  = '';       // display name
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

// Group call
let currentRoomId      = null;
let groupCallType      = 'audio';
let groupStream        = null;
let groupPeers         = new Map(); // phone -> RTCPeerConnection
let groupIceQueues     = new Map(); // phone -> [candidates]
let groupTimerInterval = null;
let groupSeconds       = 0;
let isGroupMuted       = false;
let isGroupVideoPaused = false;

// Contact select modal state
let modalMode          = 'new-group'; // 'new-group' | 'add-to-call' | 'add-to-group'
let selectedContacts   = new Set();

// RAM only
const chatMessages = new Map(); // phone -> [msg]
const chatContacts = new Map(); // phone -> {name, lastMsg, lastTime}

// localStorage keys
const LS_PHONE   = 'phantom_email';
const LS_NAME    = 'phantom_name';
const LS_TOKEN   = 'phantom_token';
const LS_CONTACTS = 'phantom_my_contacts'; // [{phone, name}]

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',               username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

// ============================================================
//  LOCALSTORAGE
// ============================================================
function lsGet(k)    { try { return localStorage.getItem(k); }     catch(e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); }         catch(e) {} }
function lsRemove(k) { try { localStorage.removeItem(k); }         catch(e) {} }

function getMyContacts() {
  try { return JSON.parse(lsGet(LS_CONTACTS) || '[]'); } catch(e) { return []; }
}
function saveMyContacts(list) { lsSet(LS_CONTACTS, JSON.stringify(list)); }
function addMyContact(phone, name) {
  const list = getMyContacts();
  if (!list.find(c => c.phone === phone)) {
    list.push({ phone, name });
    saveMyContacts(list);
  }
}
function getNameForPhone(phone) {
  const contact = getMyContacts().find(c => c.phone === phone);
  if (contact) return contact.name;
  if (chatContacts.has(phone)) return chatContacts.get(phone).name || '?';
  return '?'; // Never show phone number
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
  const savedToken = lsGet(LS_TOKEN);

  if (savedPhone && savedName && savedToken) {
    myEmail       = savedPhone;
    myName        = savedName;
    myDeviceToken = savedToken;
    // Kicked out because another device logged in with same number
  socket.on('force-logged-out', ({ reason }) => {
    lsRemove(LS_PHONE); lsRemove(LS_NAME); lsRemove(LS_TOKEN);
    myEmail = ''; myName = ''; myDeviceToken = '';
    currentChat = ''; chatMessages.clear(); chatContacts.clear();
    try { cleanupCall(); } catch(e) {}
    showScreen('login');
    setTimeout(() => showToast('⚠️ ' + reason), 500);
  });

  socket.on('connect', () => {
      socket.emit('register', { email: myEmail, name: myName, deviceToken: myDeviceToken });
    });
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
  if (tab === 'contacts') renderMyContacts();
}

// ============================================================
//  SOCKET EVENTS
// ============================================================
function setupSocketEvents() {

  socket.on('connect', () => {
    if (myEmail && myName && myDeviceToken) {
      socket.emit('register', { email: myEmail, name: myName, deviceToken: myDeviceToken });
    }
  });

  // ---- OTP EVENTS ----
  socket.on('otp-sent', ({ expiresIn }) => {
    showScreen('otp');
    startOTPCountdown(expiresIn);
    setTimeout(() => document.querySelector('.otp-box').focus(), 200);
  });

  socket.on('otp-error', ({ error }) => {
    showToast(`❌ ${error}`);
    document.getElementById('btn-send-otp').disabled  = false;
    document.getElementById('btn-resend-otp').disabled = false;
  });

  socket.on('otp-result', ({ success, error, attemptsLeft }) => {
    if (!success) {
      showToast(`❌ ${error}`);
      if (attemptsLeft === 0 || error.includes('expired') || error.includes('new OTP')) {
        clearOTPCountdown();
        document.querySelectorAll('.otp-box').forEach(b => b.value = '');
        document.getElementById('btn-resend-otp').style.display = 'inline-block';
        document.getElementById('btn-verify-otp').disabled = true;
      }
      return;
    }
    clearOTPCountdown();
    // OTP correct — proceed to name entry or register
    const savedName  = lsGet(LS_NAME);
    const savedToken = lsGet(LS_TOKEN);
    if (savedName && savedToken) {
      myName = savedName; myDeviceToken = savedToken;
      socket.emit('register', { email: myEmail, name: myName, deviceToken: myDeviceToken });
    } else {
      showScreen('name');
      setTimeout(() => document.getElementById('name-input').focus(), 200);
    }
  });

  socket.on('registered', ({ success, email, name, deviceToken, error }) => {
    if (!success) {
      showToast(`❌ ${error}`);
      // If rejected due to device mismatch, stay on login
      if (getCurrentScreen() !== 'login') showScreen('login');
      return;
    }
    myEmail       = email;
    myName        = name;
    myDeviceToken = deviceToken || myDeviceToken;
    lsSet(LS_PHONE, myEmail);
    lsSet(LS_NAME,  myName);
    if (deviceToken) lsSet(LS_TOKEN, deviceToken);
    updateHomeUI();
    if (getCurrentScreen() !== 'home') { showScreen('home'); showToast(`✅ Welcome, ${myName}!`); }
  });

  socket.on('user-status', ({ email, isOnline, name }) => {
    if (email === currentChat) {
      document.getElementById('chat-header-status').textContent = isOnline ? '🟢 Online' : '⭕ Offline';
    }
  });

  socket.on('lookup-result', ({ found, email, name }) => {
    const resultDiv  = document.getElementById('contact-lookup-result');
    const notFound   = document.getElementById('contact-not-found');
    if (found) {
      resultDiv.classList.remove('hidden');
      notFound.classList.add('hidden');
      document.getElementById('lookup-avatar').textContent = name.substring(0,2).toUpperCase();
      document.getElementById('lookup-name').textContent   = name;
      resultDiv.dataset.phone = email;
      resultDiv.dataset.name  = name;
    } else {
      resultDiv.classList.add('hidden');
      notFound.classList.remove('hidden');
    }
  });

  socket.on('receive-message', ({ from, fromName, message, timestamp, messageId, wasOffline }) => {
    const displayName = getNameForPhone(from) !== '?' ? getNameForPhone(from) : (fromName || '?');
    storeMessage(from, { from, fromName: displayName, message, timestamp, mine: false, messageId, wasOffline });
    updateChatContact(from, displayName, message, timestamp);
    if (currentChat === from) {
      renderMessage({ fromName: displayName, message, timestamp, mine: false, messageId, wasOffline });
      scrollToBottom();
    } else {
      const prefix = wasOffline ? '📨 ' : '💬 ';
      showToast(`${prefix}${displayName}: ${message.substring(0,35)}`);
      renderChatList();
    }
  });

  socket.on('message-delivered', () => {});

  // Message queued for offline user — show pending indicator
  socket.on('message-queued', ({ messageId }) => {
    // Find message bubble and mark as pending
    const el = document.querySelector(`[data-msgid="${messageId}"]`);
    if (el) {
      el.title = 'Pending — will deliver when user comes online';
      el.style.opacity = '0.7';
    }
    showToast('📨 Message queued — will deliver when user comes online');
  });

  socket.on('user-offline', ({ email }) => {
    showToast(`❌ ${getNameForPhone(email)} is not online`);
    if (getCurrentScreen() === 'calling') showScreen('chat');
  });

  // 1-to-1 incoming call
  socket.on('incoming-call', ({ from, fromName, offer, callType }) => {
    pendingOffer    = offer;
    pendingCallFrom = from;
    pendingCallName = getNameForPhone(from) !== '?' ? getNameForPhone(from) : (fromName || '?');
    currentCallType = callType;

    document.getElementById('incoming-avatar').textContent      = pendingCallName.substring(0,2).toUpperCase();
    document.getElementById('incoming-name').textContent        = pendingCallName;
    document.getElementById('incoming-type-label').textContent  = callType === 'video' ? '📹 Video Call' : '📞 Audio Call';
    document.getElementById('incoming-call-status').textContent = 'Incoming Call…';

    const ringtone = document.getElementById('ringtone');
    ringtone.currentTime = 0;
    ringtone.play().catch(() => {});
    showScreen('incoming');
  });

  socket.on('call-answered', async ({ answer }) => {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      for (const c of iceCandidateQueue) { try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {} }
      iceCandidateQueue = [];
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    if (!candidate) return;
    if (peerConnection && peerConnection.remoteDescription) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    } else { iceCandidateQueue.push(candidate); }
  });

  socket.on('call-declined', () => { showToast('❌ Call declined'); cleanupCall(); showScreen(currentChat ? 'chat' : 'home'); });
  socket.on('call-ended',    () => { showToast('📵 Call ended');    cleanupCall(); showScreen(currentChat ? 'chat' : 'home'); });

  // Group call events
  socket.on('group-existing-members', async ({ roomId, members, callType }) => {
    for (const m of members) {
      if (m.email !== myEmail) await createGroupPeer(m.email, m.name, roomId, callType, true);
    }
    updateGroupUI();
  });

  socket.on('group-user-joined', async ({ roomId, email, name, callType }) => {
    if (email === myEmail) return;
    const displayName = getNameForPhone(email) !== '?' ? getNameForPhone(email) : name;
    showToast(`👥 ${displayName} joined`);
    if (!groupPeers.has(email)) await createGroupPeer(email, displayName, roomId, callType, false);
    updateGroupUI();
  });

  socket.on('group-offer', async ({ from, fromName, roomId, offer }) => {
    if (from === myEmail) return;
    const displayName = getNameForPhone(from) !== '?' ? getNameForPhone(from) : fromName;
    let pc = groupPeers.get(from);
    if (!pc) pc = await createGroupPeer(from, displayName, roomId, groupCallType, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const queue = groupIceQueues.get(from) || [];
    for (const c of queue) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {} }
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
      for (const c of queue) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {} }
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

  socket.on('group-user-left', ({ email }) => {
    const name = getNameForPhone(email);
    showToast(`👋 ${name} left`);
    removeGroupPeer(email);
    updateGroupUI();
  });
}

// ============================================================
//  UI EVENTS
// ============================================================
function setupUIEvents() {

  // LOGIN
  document.getElementById('btn-send-otp').addEventListener('click', handleSendOTP);
  document.getElementById('email-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleSendOTP(); });

  // OTP
  document.getElementById('btn-verify-otp').addEventListener('click', handleVerifyOTP);
  document.getElementById('btn-resend-otp').addEventListener('click', handleResendOTP);
  document.getElementById('btn-back-login').addEventListener('click', () => { clearOTPCountdown(); showScreen('login'); });
  const otpBoxes = document.querySelectorAll('.otp-box');
  otpBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(-1);
      if (box.value && i < otpBoxes.length - 1) otpBoxes[i+1].focus();
    });
    box.addEventListener('keydown', e => { if (e.key === 'Backspace' && !box.value && i > 0) otpBoxes[i-1].focus(); });
  });

  // NAME
  document.getElementById('btn-save-name').addEventListener('click', handleSaveName);
  document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleSaveName(); });

  // HOME
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  document.getElementById('fab-new-chat').addEventListener('click', () => { openContactSelectModal('new-chat'); });
  document.getElementById('fab-group-call').addEventListener('click', () => openContactSelectModal('new-group'));

  // ADD CONTACT
  document.getElementById('btn-add-contact').addEventListener('click', () => showScreen('add-contact'));
  document.getElementById('btn-back-from-add').addEventListener('click', () => { showScreen('home'); switchTab('contacts'); });
  document.getElementById('btn-lookup-contact').addEventListener('click', handleLookupContact);
  document.getElementById('add-contact-phone').addEventListener('keydown', e => { if (e.key === 'Enter') handleLookupContact(); });
  document.getElementById('btn-confirm-add-contact').addEventListener('click', handleConfirmAddContact);

  // CHAT
  document.getElementById('btn-back-home').addEventListener('click', () => { currentChat = ''; currentChatName = ''; showScreen('home'); });
  document.getElementById('btn-send-msg').addEventListener('click', handleSendMessage);
  document.getElementById('message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } });
  document.getElementById('btn-audio-call').addEventListener('click', () => startCall('audio'));
  document.getElementById('btn-video-call').addEventListener('click', () => startCall('video'));

  // OUTGOING
  document.getElementById('btn-cancel-call').addEventListener('click', () => { socket.emit('call-end', { to: currentChat }); cleanupCall(); showScreen('chat'); });

  // INCOMING
  document.getElementById('btn-accept-call').addEventListener('click', acceptCall);
  document.getElementById('btn-decline-call').addEventListener('click', () => {
    document.getElementById('ringtone').pause();
    socket.emit('call-decline', { to: pendingCallFrom });
    pendingOffer = null; pendingCallFrom = null; pendingCallName = '';
    showScreen(currentChat ? 'chat' : 'home');
  });

  // ACTIVE CALL
  document.getElementById('btn-end-call').addEventListener('click', () => { socket.emit('call-end', { to: currentChat }); cleanupCall(); showScreen(currentChat ? 'chat' : 'home'); });
  document.getElementById('btn-toggle-mute').addEventListener('click', toggleMute);
  document.getElementById('btn-toggle-video').addEventListener('click', toggleVideo);
  document.getElementById('btn-add-to-call').addEventListener('click', () => openContactSelectModal('add-to-call'));

  // GROUP CALL
  document.getElementById('btn-group-mute').addEventListener('click', toggleGroupMute);
  document.getElementById('btn-group-end').addEventListener('click', leaveGroupCall);
  document.getElementById('btn-group-video').addEventListener('click', toggleGroupVideo);
  document.getElementById('btn-add-to-group').addEventListener('click', () => openContactSelectModal('add-to-group'));

  // MODAL
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-modal-confirm').addEventListener('click', handleModalConfirm);
}

// ============================================================
//  AUTH
// ============================================================
function handleSendOTP() {
  const email = document.getElementById('email-input').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('⚠️ Enter a valid email address'); return; }
  myEmail = email;
  document.getElementById('otp-subtitle').textContent = `OTP sent to ${email}`;
  document.querySelectorAll('.otp-box').forEach(b => b.value = '');
  document.getElementById('btn-verify-otp').disabled  = false;
  document.getElementById('btn-resend-otp').style.display = 'none';
  document.getElementById('btn-send-otp').disabled = true;
  socket.emit('request-otp', { email: email });
}

function handleResendOTP() {
  if (!myEmail) return;
  document.querySelectorAll('.otp-box').forEach(b => b.value = '');
  document.getElementById('btn-resend-otp').disabled = true;
  document.getElementById('btn-verify-otp').disabled  = false;
  socket.emit('request-otp', { email: myEmail });
}

function startOTPCountdown(expiresIn) {
  clearOTPCountdown();
  const timerEl = document.getElementById('otp-timer');
  let remaining = Math.floor(expiresIn / 1000);
  const tick = () => {
    if (remaining <= 0) {
      clearOTPCountdown();
      timerEl.textContent = 'OTP expired. Request a new one.';
      timerEl.style.color = 'var(--red-primary, #C62828)';
      document.getElementById('btn-verify-otp').disabled = true;
      document.getElementById('btn-resend-otp').style.display = 'inline-block';
      return;
    }
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    timerEl.textContent = `OTP expires in ${m}:${s}`;
    timerEl.style.color = remaining <= 30 ? 'var(--red-primary, #C62828)' : '#888';
    remaining--;
  };
  tick();
  otpCountdownInterval = setInterval(tick, 1000);
}

function clearOTPCountdown() {
  if (otpCountdownInterval) { clearInterval(otpCountdownInterval); otpCountdownInterval = null; }
  const timerEl = document.getElementById('otp-timer');
  if (timerEl) timerEl.textContent = '';
  document.getElementById('btn-send-otp').disabled = false;
}

function handleVerifyOTP() {
  const entered = Array.from(document.querySelectorAll('.otp-box')).map(b => b.value).join('');
  if (entered.length < 6) { showToast('⚠️ Enter all 6 digits'); return; }
  socket.emit('verify-otp', { email: myEmail, otp: entered });
}


function handleSaveName() {
  const name = document.getElementById('name-input').value.trim();
  if (name.length < 2) { showToast('⚠️ Name must be at least 2 characters'); return; }
  if (name.length > 30) { showToast('⚠️ Name must be 30 characters or less'); return; }
  if (!/^[a-zA-Z\s'\-.]+$/.test(name)) { showToast('⚠️ Name can only contain letters, spaces, hyphens'); return; }
  myName = name;
  socket.emit('register', { email: myEmail, name: myName });
}

function handleLogout() {
  if (!confirm('Are you sure you want to logout?')) return;
  // Clear device token on server so new device can login
  socket.emit('force-logout', { email: myEmail, deviceToken: myDeviceToken });
  lsRemove(LS_PHONE); lsRemove(LS_NAME); lsRemove(LS_TOKEN);
  myEmail = ''; myName = ''; myDeviceToken = '';
  currentChat = ''; chatMessages.clear(); chatContacts.clear();
  showScreen('login'); showToast('👋 Logged out');
}

function updateHomeUI() {
  document.getElementById('my-avatar-initials').textContent = myName.substring(0,2).toUpperCase();
  renderChatList();
  renderMyContacts();
}

// ============================================================
//  ADD CONTACT
// ============================================================
function handleLookupContact() {
  const phone = document.getElementById('add-contact-phone').value.trim();
  if (phone.length < 10) { showToast('⚠️ Enter a valid 10-digit number'); return; }
  if (phone === myEmail)  { showToast('⚠️ That is your own email'); return; }
  document.getElementById('contact-lookup-result').classList.add('hidden');
  document.getElementById('contact-not-found').classList.add('hidden');
  socket.emit('lookup-user', { email: phone });
}

function handleConfirmAddContact() {
  const resultDiv = document.getElementById('contact-lookup-result');
  const phone = resultDiv.dataset.phone;
  const name  = resultDiv.dataset.name;
  if (!phone || !name) return;
  addMyContact(phone, name);
  renderMyContacts();
  showToast(`✅ ${name} added to contacts`);
  document.getElementById('add-contact-phone').value = '';
  resultDiv.classList.add('hidden');
  showScreen('home');
  switchTab('contacts');
}

function renderMyContacts() {
  const list = document.getElementById('my-contacts-list');
  const ph   = document.getElementById('no-contacts-placeholder');
  list.querySelectorAll('.contact-item').forEach(el => el.remove());
  const contacts = getMyContacts();
  if (contacts.length === 0) { ph.style.display = 'block'; return; }
  ph.style.display = 'none';
  contacts.forEach(({ phone, name }) => {
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.innerHTML = `
      <div class="contact-avatar" style="position:relative;">${name.substring(0,2).toUpperCase()}</div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(name)}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="action-btn" style="background:var(--red-light);color:var(--red-primary);" onclick="openChat('${phone}','${escapeHtml(name)}')">💬</button>
        <button class="action-btn" style="background:var(--red-light);color:var(--red-primary);" onclick="startCallTo('${phone}','audio')">📞</button>
      </div>`;
    list.appendChild(item);
  });
}

// ============================================================
//  CONTACT SELECT MODAL (for group call / add participant)
// ============================================================
function openContactSelectModal(mode) {
  modalMode = mode;
  selectedContacts.clear();
  const contacts = getMyContacts().filter(c => c.phone !== myEmail);
  if (contacts.length === 0) { showToast('⚠️ No contacts yet. Add contacts first.'); return; }

  const titles = {
    'new-group':    'Select Contacts for Group Call',
    'new-chat':     'Select Contact to Chat',
    'add-to-call':  'Add to Call',
    'add-to-group': 'Add to Group Call'
  };
  document.getElementById('modal-title').textContent = titles[mode] || 'Select Contact';

  const confirmBtn = document.getElementById('btn-modal-confirm');
  confirmBtn.textContent = mode === 'new-chat' ? 'Open Chat' : 'Call Selected';

  const list = document.getElementById('modal-contacts-list');
  list.innerHTML = '';
  contacts.forEach(({ phone, name }) => {
    const item = document.createElement('div');
    item.className = 'modal-contact-item';
    item.dataset.phone = phone;
    item.innerHTML = `
      <div class="modal-check" id="check-${phone}">☐</div>
      <div class="contact-avatar" style="width:40px;height:40px;font-size:15px;">${name.substring(0,2).toUpperCase()}</div>
      <div class="contact-name" style="font-size:14px;">${escapeHtml(name)}</div>`;
    item.addEventListener('click', () => toggleContactSelect(phone, item));
    list.appendChild(item);
  });

  document.getElementById('contact-select-modal').classList.remove('hidden');
}

function toggleContactSelect(phone, item) {
  if (selectedContacts.has(phone)) {
    selectedContacts.delete(phone);
    item.classList.remove('selected');
    document.getElementById(`check-${phone}`).textContent = '☐';
  } else {
    selectedContacts.add(phone);
    item.classList.add('selected');
    document.getElementById(`check-${phone}`).textContent = '☑';
  }
}

function closeModal() {
  document.getElementById('contact-select-modal').classList.add('hidden');
  selectedContacts.clear();
}

function handleModalConfirm() {
  if (selectedContacts.size === 0) { showToast('⚠️ Select at least one contact'); return; }
  closeModal();

  if (modalMode === 'new-chat') {
    const phone = [...selectedContacts][0];
    const name  = getNameForPhone(phone);
    openChat(phone, name);
    return;
  }

  if (modalMode === 'new-group' || modalMode === 'add-to-group') {
    startGroupCall([...selectedContacts], 'audio');
    return;
  }

  if (modalMode === 'add-to-call') {
    // Add selected contacts to existing 1-to-1 call → upgrade to group
    upgradeToGroupCall([...selectedContacts]);
    return;
  }
}

// ============================================================
//  CHAT
// ============================================================
function openChat(phone, name) {
  currentChat     = phone;
  currentChatName = name || getNameForPhone(phone);
  const initials  = currentChatName.substring(0,2).toUpperCase();
  document.getElementById('chat-header-avatar').textContent = initials;
  document.getElementById('chat-header-name').textContent   = currentChatName;
  document.getElementById('chat-header-status').textContent = 'Checking…';
  setTimeout(() => socket.emit('check-user', { email: phone }), 1500);
  const msgs = document.getElementById('chat-messages');
  while (msgs.children.length > 1) msgs.removeChild(msgs.lastChild);
  (chatMessages.get(phone) || []).forEach(m => renderMessage(m));
  scrollToBottom();
  if (!chatContacts.has(phone)) { updateChatContact(phone, currentChatName, 'Chat started', Date.now()); renderChatList(); }
  showScreen('chat');
}

function handleSendMessage() {
  const input = document.getElementById('message-input');
  const text  = input.value.trim();
  if (!text || !currentChat) return;
  const messageId = Date.now() + '_' + Math.random();
  const timestamp = Date.now();
  socket.emit('send-message', { to: currentChat, from: myEmail, message: text, messageId });
  const msgObj = { from: myEmail, fromName: myName, message: text, timestamp, mine: true, messageId };
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
  chatContacts.set(phone, { name: name||phone, lastMsg, lastTime });
}
function renderMessage({ fromName, message, timestamp, mine, messageId, wasOffline }) {
  const wrap   = document.createElement('div');
  wrap.className = `msg-bubble-wrap ${mine ? 'sent' : 'received'}`;
  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${mine ? 'sent' : 'received'}`;
  if (messageId) bubble.dataset.msgid = messageId;
  bubble.textContent = message;
  const time = document.createElement('div');
  time.className = 'msg-time';
  // Show clock icon for offline-delivered messages
  time.textContent = (wasOffline ? '🕐 ' : '') + formatTime(timestamp);
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
    const initials = (name||'?').substring(0,2).toUpperCase();
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.innerHTML = `<div class="contact-avatar">${initials}</div><div class="contact-info"><div class="contact-name">${escapeHtml(name||'?')}</div><div class="contact-preview">${escapeHtml((lastMsg||'').substring(0,50))}</div></div><div class="contact-time">${formatTime(lastTime)}</div>`;
    item.addEventListener('click', () => openChat(phone, name));
    list.appendChild(item);
  });
}

// ============================================================
//  1-to-1 CALLING
// ============================================================
function startCallTo(phone, type) {
  currentChat     = phone;
  currentChatName = getNameForPhone(phone);
  startCall(type);
}

async function startCall(type) {
  if (!currentChat) return;
  currentCallType = type;
  const displayName = currentChatName || getNameForPhone(currentChat);
  document.getElementById('calling-avatar').textContent     = displayName.substring(0,2).toUpperCase();
  document.getElementById('calling-name').textContent       = displayName;
  document.getElementById('calling-status').textContent     = 'Calling…';
  document.getElementById('calling-type-label').textContent = type === 'video' ? '📹 Video Call' : '📞 Audio Call';
  showScreen('calling');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: type === 'video'
    });
    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    setupPeerEvents(currentChat);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('call-offer', { to: currentChat, from: myEmail, offer, callType: type });
  } catch(err) {
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
    socket.emit('call-answer', { to: pendingCallFrom, from: myEmail, answer });
  } catch(err) {
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
  document.getElementById('active-call-name').textContent   = displayName;
  const videoContainer = document.getElementById('video-container');
  const audioUI        = document.getElementById('audio-call-ui');
  const videoBtn       = document.getElementById('btn-toggle-video');
  if (currentCallType === 'video') {
    videoContainer.classList.remove('hidden'); audioUI.classList.add('hidden'); videoBtn.classList.remove('hidden');
    if (localStream) document.getElementById('local-video').srcObject = localStream;
  } else {
    videoContainer.classList.add('hidden'); audioUI.classList.remove('hidden'); videoBtn.classList.add('hidden');
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
  callTimerInterval = setInterval(() => { callSeconds++; const el = document.getElementById('call-timer'); if (el) el.textContent = fmtTimer(callSeconds); }, 1000);
}
function cleanupCall() {
  clearInterval(callTimerInterval); callSeconds = 0; isMuted = false; isVideoPaused = false;
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  ['remote-video','local-video'].forEach(id => { const el = document.getElementById(id); if (el) el.srcObject = null; });
  const ra = document.getElementById('remote-audio'); if (ra) ra.srcObject = null;
  pendingOffer = null; pendingCallFrom = null; pendingCallName = ''; currentCallType = null; iceCandidateQueue = [];
}

// Upgrade 1-to-1 to group call
async function upgradeToGroupCall(newPhones) {
  const roomId = generateRoomCode();
  currentRoomId = roomId;
  groupCallType = currentCallType || 'audio';
  groupStream   = localStream;
  localStream   = null;

  // Add current peer to group
  if (currentChat && peerConnection) {
    groupPeers.set(currentChat, peerConnection);
    peerConnection = null;
  }

  showGroupCallUI();
  socket.emit('group-join', { roomId, callType: groupCallType });

  // Invite new contacts
  for (const phone of newPhones) {
    await inviteToGroup(phone, roomId);
  }
  cleanupCall();
}

// ============================================================
//  GROUP CALL
// ============================================================
function generateRoomCode() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

async function startGroupCall(phones, type) {
  if (phones.length === 0) return;
  groupCallType = type;
  currentRoomId = generateRoomCode();

  try {
    groupStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: type === 'video'
    });
  } catch(err) { showToast('❌ Could not access microphone/camera'); return; }

  showGroupCallUI();
  socket.emit('group-join', { roomId: currentRoomId, callType: type });

  // Invite all selected contacts
  for (const phone of phones) {
    await inviteToGroup(phone, currentRoomId);
  }
}

async function inviteToGroup(phone, roomId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  groupPeers.set(phone, pc);
  groupIceQueues.set(phone, []);

  if (groupStream) groupStream.getTracks().forEach(t => pc.addTrack(t, groupStream));

  pc.onicecandidate = e => { if (e.candidate) socket.emit('group-ice', { to: phone, roomId, candidate: e.candidate }); };

  const remoteStream = new MediaStream();
  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    const displayName = getNameForPhone(phone);
    if (groupCallType === 'video') addVideoTile(phone, displayName, remoteStream);
    else addAudioStream(phone, displayName, remoteStream);
    updateGroupUI();
  };
  pc.onconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.connectionState)) { removeGroupPeer(phone); updateGroupUI(); }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('group-offer', { to: phone, roomId, offer });
}

async function createGroupPeer(phone, name, roomId, callType, isInitiator) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  groupPeers.set(phone, pc);
  groupIceQueues.set(phone, []);

  if (groupStream) groupStream.getTracks().forEach(t => pc.addTrack(t, groupStream));

  pc.onicecandidate = e => { if (e.candidate) socket.emit('group-ice', { to: phone, roomId, candidate: e.candidate }); };

  const remoteStream = new MediaStream();
  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    const displayName = getNameForPhone(phone) !== '?' ? getNameForPhone(phone) : name;
    if (callType === 'video') addVideoTile(phone, displayName, remoteStream);
    else addAudioStream(phone, displayName, remoteStream);
    updateGroupUI();
  };
  pc.onconnectionstatechange = () => {
    if (['disconnected','failed','closed'].includes(pc.connectionState)) { removeGroupPeer(phone); updateGroupUI(); }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('group-offer', { to: phone, roomId, offer });
  }
  return pc;
}

function showGroupCallUI() {
  const videoGrid = document.getElementById('group-video-grid');
  const audioUI   = document.getElementById('group-audio-ui');
  const videoBtn  = document.getElementById('btn-group-video');

  document.getElementById('group-call-timer').textContent   = '00:00';
  document.getElementById('group-member-count').textContent = '👥 1';

  if (groupCallType === 'video') {
    videoGrid.classList.remove('hidden'); audioUI.classList.add('hidden'); videoBtn.classList.remove('hidden');
    document.getElementById('group-local-video').srcObject = groupStream;
    document.getElementById('local-tile-label').textContent = myName;
  } else {
    videoGrid.classList.add('hidden'); audioUI.classList.remove('hidden'); videoBtn.classList.add('hidden');
    renderGroupParticipant(myEmail, myName, true);
  }
  showScreen('group-call');
  startGroupTimer();
}

function addVideoTile(phone, name, stream) {
  const grid = document.getElementById('group-video-grid');
  let tile = document.getElementById(`tile-${phone}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile'; tile.id = `tile-${phone}`;
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true;
    const label = document.createElement('div');
    label.className = 'tile-label'; label.textContent = name;
    tile.appendChild(video); tile.appendChild(label);
    grid.appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
}

function addAudioStream(phone, name, stream) {
  let audioEl = document.getElementById(`audio-${phone}`);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = `audio-${phone}`; audioEl.autoplay = true; audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
  renderGroupParticipant(phone, name, false);
}

function renderGroupParticipant(phone, name, isMe) {
  const list = document.getElementById('group-participants-list');
  if (document.getElementById(`participant-${phone}`)) return;
  const item = document.createElement('div');
  item.className = 'group-participant'; item.id = `participant-${phone}`;
  item.innerHTML = `<div class="group-avatar">${(name||'?').substring(0,2).toUpperCase()}</div><div class="group-pname">${escapeHtml(name||'?')}${isMe?' (You)':''}</div><div class="group-mic">🎙️</div>`;
  list.appendChild(item);
}

function removeGroupPeer(phone) {
  const pc = groupPeers.get(phone);
  if (pc) { pc.close(); groupPeers.delete(phone); }
  groupIceQueues.delete(phone);
  ['tile','audio','participant'].forEach(prefix => { const el = document.getElementById(`${prefix}-${phone}`); if (el) el.remove(); });
}

function updateGroupUI() {
  document.getElementById('group-member-count').textContent = `👥 ${groupPeers.size + 1}`;
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
  document.getElementById('group-video-grid').innerHTML = `<div class="video-tile" id="local-tile"><video id="group-local-video" autoplay playsinline muted></video><div class="tile-label" id="local-tile-label">You</div></div>`;
  document.getElementById('group-participants-list').innerHTML = '';
  currentRoomId = null; isGroupMuted = false; isGroupVideoPaused = false;
}
function startGroupTimer() {
  groupSeconds = 0; clearInterval(groupTimerInterval);
  groupTimerInterval = setInterval(() => { groupSeconds++; const el = document.getElementById('group-call-timer'); if (el) el.textContent = fmtTimer(groupSeconds); }, 1000);
}

// ============================================================
//  HELPERS
// ============================================================
function fmtTimer(s) { return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
function escapeHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function scrollToBottom() { const c = document.getElementById('chat-messages'); c.scrollTop = c.scrollHeight; }
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}
