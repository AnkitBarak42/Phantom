'use strict';

// ── SOCKET ──────────────────────────────────────────────────
const socket = io(window.location.origin, { transports: ['websocket'] });

// ── STATE ────────────────────────────────────────────────────
let myUser        = null;   // { uniqueId, name, mobile, gender, age, address }
let currentChat   = null;   // { uniqueId, name }
let pendingReqId  = null;
let localStream   = null;
let peerConn      = null;
let currentCallTo = null;
let callType      = 'audio';
let isMuted       = false;
let isCamOff      = false;
const messages    = {};     // uniqueId -> [msg objects]
const contacts    = {};     // uniqueId -> { name }

const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ── HELPERS ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}
function showToast(msg, duration = 2500) {
  const t = $('toast'); t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function firstLetter(name) { return (name || '?')[0].toUpperCase(); }

// ── LOCAL STORAGE ────────────────────────────────────────────
function saveUser()     { localStorage.setItem('phantom_user',     JSON.stringify(myUser)); }
function saveContacts() { localStorage.setItem('phantom_contacts', JSON.stringify(contacts)); }
function loadSaved() {
  try {
    const u = localStorage.getItem('phantom_user');
    const c = localStorage.getItem('phantom_contacts');
    if (u) myUser = JSON.parse(u);
    if (c) Object.assign(contacts, JSON.parse(c));
  } catch(e) {}
}
function clearUser() {
  myUser = null; pendingReqId = null;
  localStorage.removeItem('phantom_user');
  localStorage.removeItem('phantom_pending');
}

// ── BOOT ─────────────────────────────────────────────────────
loadSaved();

if (myUser) {
  // Already approved — reconnect
  socket.emit('user-reconnect', { uniqueId: myUser.uniqueId, name: myUser.name });
  initMainScreen();
} else {
  const pending = localStorage.getItem('phantom_pending');
  if (pending) {
    pendingReqId = JSON.parse(pending).requestId;
    socket.emit('rejoin-request', { requestId: pendingReqId });
    showScreen('screen-waiting');
  } else {
    showScreen('screen-login');
  }
}

// ── LOGIN FORM ────────────────────────────────────────────────
$('btn-request').addEventListener('click', () => {
  const name    = $('inp-name').value.trim();
  const mobile  = $('inp-mobile').value.trim();
  const gender  = $('inp-gender').value;
  const age     = parseInt($('inp-age').value);
  const address = $('inp-address').value.trim();
  const errEl   = $('login-error');

  errEl.textContent = '';
  if (!name || !mobile || !gender || !age || !address) {
    errEl.textContent = 'Please fill in all fields.'; return;
  }
  if (!/^\d{10,15}$/.test(mobile)) {
    errEl.textContent = 'Enter a valid mobile number.'; return;
  }
  if (age < 5 || age > 120) {
    errEl.textContent = 'Enter a valid age.'; return;
  }

  $('btn-request').disabled = true;
  $('btn-request').textContent = 'Sending...';
  socket.emit('submit-request', { name, mobile, gender, age, address });
});

$('btn-cancel-request').addEventListener('click', () => {
  localStorage.removeItem('phantom_pending');
  pendingReqId = null;
  showScreen('screen-login');
  $('btn-request').disabled = false;
  $('btn-request').textContent = 'Request Login';
});

$('btn-try-again').addEventListener('click', () => {
  showScreen('screen-login');
  $('btn-request').disabled = false;
  $('btn-request').textContent = 'Request Login';
});

// ── SOCKET: Request events ────────────────────────────────────
socket.on('request-submitted', ({ requestId }) => {
  pendingReqId = requestId;
  localStorage.setItem('phantom_pending', JSON.stringify({ requestId }));
  showScreen('screen-waiting');
});

socket.on('request-error', ({ error }) => {
  $('login-error').textContent = error;
  $('btn-request').disabled = false;
  $('btn-request').textContent = 'Request Login';
});

socket.on('request-still-pending', () => {
  showScreen('screen-waiting');
});

socket.on('request-not-found', () => {
  localStorage.removeItem('phantom_pending');
  pendingReqId = null;
  showScreen('screen-login');
  showToast('Your previous request expired. Please request again.');
});

socket.on('request-approved', (data) => {
  myUser = {
    uniqueId: data.uniqueId,
    name:     data.name,
    mobile:   data.mobile,
    gender:   data.gender,
    age:      data.age,
    address:  data.address,
  };
  saveUser();
  localStorage.removeItem('phantom_pending');
  pendingReqId = null;
  showToast('🎉 Request approved! Welcome to Phantom.');
  initMainScreen();
});

socket.on('request-rejected', ({ reason }) => {
  localStorage.removeItem('phantom_pending');
  pendingReqId = null;
  $('reject-reason').textContent = reason || 'Your request was not approved.';
  showScreen('screen-rejected');
});

socket.on('reconnected', () => {
  initMainScreen();
});

socket.on('force-logged-out', () => {
  clearUser();
  showScreen('screen-login');
  showToast('You were logged out from another device.');
});

// ── MAIN SCREEN ───────────────────────────────────────────────
function initMainScreen() {
  $('display-my-id').textContent = myUser.uniqueId;
  renderContacts();
  showScreen('screen-main');
}

$('btn-copy-id').addEventListener('click', () => {
  navigator.clipboard?.writeText(myUser.uniqueId).then(() => showToast('ID copied!'));
});

$('btn-logout').addEventListener('click', () => {
  if (!confirm('Log out? You will need owner approval to log in again.')) return;
  clearUser();
  Object.keys(contacts).forEach(k => delete contacts[k]);
  localStorage.removeItem('phantom_contacts');
  showScreen('screen-login');
  $('btn-request').disabled = false;
  $('btn-request').textContent = 'Request Login';
  showToast('Logged out.');
});

$('btn-add-contact').addEventListener('click', () => {
  $('inp-contact-id').value = '';
  $('contact-lookup-result').textContent = '';
  $('contact-lookup-result').className = 'lookup-result';
  $('add-contact-modal').style.display = 'flex';
});
$('btn-cancel-add').addEventListener('click', () => {
  $('add-contact-modal').style.display = 'none';
});

$('btn-lookup-contact').addEventListener('click', () => {
  const id = $('inp-contact-id').value.trim().toUpperCase();
  if (!id) return;
  if (id === myUser.uniqueId) {
    setLookupResult('That\'s your own ID!', false); return;
  }
  socket.emit('check-user', { uniqueId: id });
  $('contact-lookup-result').textContent = 'Searching...';
  $('contact-lookup-result').className = 'lookup-result';
});

socket.on('user-status', ({ uniqueId, isOnline, name }) => {
  if (name) {
    setLookupResult(`✅ Found: ${name} — ${isOnline ? 'Online' : 'Offline'}`, true);
    $('btn-lookup-contact').onclick = null;
    $('btn-lookup-contact').textContent = 'Add';
    $('btn-lookup-contact').onclick = () => {
      addContact(uniqueId, name);
      $('add-contact-modal').style.display = 'none';
      $('btn-lookup-contact').textContent = 'Search';
      $('btn-lookup-contact').onclick = () => {
        const id2 = $('inp-contact-id').value.trim().toUpperCase();
        if (id2) socket.emit('check-user', { uniqueId: id2 });
      };
    };
  } else {
    setLookupResult('❌ User not found.', false);
  }
});

function setLookupResult(msg, found) {
  const el = $('contact-lookup-result');
  el.textContent = msg;
  el.className = 'lookup-result ' + (found ? 'found' : 'not-found');
}

function addContact(uniqueId, name) {
  if (contacts[uniqueId]) { showToast('Already in contacts.'); return; }
  contacts[uniqueId] = { name };
  saveContacts();
  renderContacts();
  showToast(`${name} added!`);
}

function renderContacts() {
  const list = $('contacts-list');
  const keys = Object.keys(contacts);
  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state">No contacts yet.<br/>Add a contact using their Phantom ID.</div>';
    return;
  }
  list.innerHTML = keys.map(uid => `
    <div class="contact-item" data-id="${uid}">
      <div class="contact-avatar">${firstLetter(contacts[uid].name)}</div>
      <div class="contact-info">
        <div class="contact-name">${contacts[uid].name}</div>
        <div class="contact-id">${uid}</div>
      </div>
      <div class="contact-offline" id="dot-${uid}"></div>
    </div>
  `).join('');

  list.querySelectorAll('.contact-item').forEach(el => {
    el.addEventListener('click', () => openChat(el.dataset.id));
    socket.emit('check-user', { uniqueId: el.dataset.id });
  });
}

socket.on('user-status', ({ uniqueId, isOnline }) => {
  const dot = $(`dot-${uniqueId}`);
  if (dot) {
    dot.className = isOnline ? 'contact-online' : 'contact-offline';
  }
  if (currentChat?.uniqueId === uniqueId) {
    $('chat-contact-status').textContent = isOnline ? 'Online' : 'Offline';
  }
});

// ── CHAT ─────────────────────────────────────────────────────
function openChat(uniqueId) {
  currentChat = { uniqueId, name: contacts[uniqueId]?.name || uniqueId };
  $('chat-contact-name').textContent = currentChat.name;
  $('chat-avatar').textContent       = firstLetter(currentChat.name);
  $('chat-contact-status').textContent = '...';
  socket.emit('check-user', { uniqueId });
  renderMessages(uniqueId);
  showScreen('screen-chat');
}

$('btn-back-chat').addEventListener('click', () => {
  currentChat = null;
  showScreen('screen-main');
});

$('btn-send-msg').addEventListener('click', sendMessage);
$('message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

function sendMessage() {
  const input = $('message-input');
  const text  = input.value.trim();
  if (!text || !currentChat) return;
  const messageId = Date.now() + '-' + Math.random().toString(36).slice(2);
  socket.emit('send-message', { to: currentChat.uniqueId, message: text, messageId });
  appendMessage(currentChat.uniqueId, { from: myUser.uniqueId, message: text, messageId, timestamp: Date.now(), status: 'sent' });
  input.value = '';
}

socket.on('receive-message', (data) => {
  const { from, fromName, message, messageId, timestamp } = data;
  if (contacts[from] === undefined) {
    contacts[from] = { name: fromName || from };
    saveContacts();
    renderContacts();
  }
  appendMessage(from, { from, message, messageId, timestamp, status: 'received' });
  if (currentChat?.uniqueId !== from) showToast(`💬 ${fromName || from}: ${message.slice(0,40)}`);
});

socket.on('message-delivered', ({ messageId }) => {
  const el = document.querySelector(`[data-mid="${messageId}"] .msg-status`);
  if (el) el.textContent = '✓✓';
});
socket.on('message-queued', ({ messageId }) => {
  const el = document.querySelector(`[data-mid="${messageId}"] .msg-status`);
  if (el) el.textContent = '🕐';
});

function appendMessage(contactId, msg) {
  if (!messages[contactId]) messages[contactId] = [];
  messages[contactId].push(msg);
  if (currentChat?.uniqueId === contactId) renderMessages(contactId);
}

function renderMessages(contactId) {
  const container = $('messages-container');
  const msgs = messages[contactId] || [];
  container.innerHTML = msgs.map(m => {
    const isMe = m.from === myUser.uniqueId;
    return `
      <div class="msg-bubble-wrap ${isMe ? 'me' : 'them'}" data-mid="${m.messageId || ''}">
        <div class="msg-bubble ${isMe ? 'me' : 'them'}">
          ${m.message}
          <div class="msg-time">${formatTime(m.timestamp)} <span class="msg-status">${isMe ? (m.status === 'sent' ? '✓' : '') : ''}</span></div>
        </div>
      </div>
    `;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

// ── CALLS ─────────────────────────────────────────────────────
$('btn-audio-call').addEventListener('click', () => startCall('audio'));
$('btn-video-call').addEventListener('click', () => startCall('video'));
$('btn-end-call').addEventListener('click', endCall);
$('btn-mute').addEventListener('click', toggleMute);
$('btn-cam-toggle').addEventListener('click', toggleCam);
$('btn-accept-call').addEventListener('click', acceptCall);
$('btn-decline-call').addEventListener('click', declineCall);

async function startCall(type) {
  if (!currentChat) return;
  callType      = type;
  currentCallTo = currentChat.uniqueId;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true, video: type === 'video'
    });
    showCallScreen(currentChat.name, 'Calling...');
    if (type === 'video') {
      $('local-video').srcObject = localStream;
      $('video-container').style.display = 'block';
      $('btn-cam-toggle').style.display = 'flex';
    }
    peerConn = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
    peerConn.onicecandidate = e => {
      if (e.candidate) socket.emit('ice-candidate', { to: currentCallTo, candidate: e.candidate });
    };
    peerConn.ontrack = e => {
      $('remote-video').srcObject = e.streams[0];
    };
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    socket.emit('call-offer', { to: currentCallTo, offer, callType: type });
  } catch(e) {
    console.error('startCall error:', e);
    showToast('Could not access microphone/camera.');
    cleanupCall();
  }
}

socket.on('incoming-call', async ({ from, fromName, offer, callType: ct }) => {
  if (peerConn) { socket.emit('call-decline', { to: from }); return; }
  callType      = ct;
  currentCallTo = from;
  $('incoming-caller-name').textContent = fromName || from;
  $('incoming-call-type').textContent   = ct === 'video' ? '📹 Video Call' : '📞 Audio Call';
  $('incoming-call-overlay').style.display = 'flex';
  window._pendingOffer = offer;
});

async function acceptCall() {
  $('incoming-call-overlay').style.display = 'none';
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true, video: callType === 'video'
    });
    showCallScreen($('incoming-caller-name').textContent, 'Connected');
    if (callType === 'video') {
      $('local-video').srcObject = localStream;
      $('video-container').style.display = 'block';
      $('btn-cam-toggle').style.display = 'flex';
    }
    peerConn = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
    peerConn.onicecandidate = e => {
      if (e.candidate) socket.emit('ice-candidate', { to: currentCallTo, candidate: e.candidate });
    };
    peerConn.ontrack = e => {
      $('remote-video').srcObject = e.streams[0];
    };
    await peerConn.setRemoteDescription(new RTCSessionDescription(window._pendingOffer));
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    socket.emit('call-answer', { to: currentCallTo, answer });
  } catch(e) {
    console.error('acceptCall error:', e);
    showToast('Could not access microphone/camera.');
    cleanupCall();
  }
}

function declineCall() {
  socket.emit('call-decline', { to: currentCallTo });
  $('incoming-call-overlay').style.display = 'none';
  currentCallTo = null; window._pendingOffer = null;
}

socket.on('call-answered', async ({ answer }) => {
  $('call-status').textContent = 'Connected';
  try { await peerConn?.setRemoteDescription(new RTCSessionDescription(answer)); }
  catch(e) { console.error('call-answered error:', e); }
});

socket.on('ice-candidate', async ({ candidate }) => {
  try { if (peerConn && candidate) await peerConn.addIceCandidate(new RTCIceCandidate(candidate)); }
  catch(e) {}
});

socket.on('call-declined', () => {
  showToast('Call declined.');
  cleanupCall();
  showScreen(currentChat ? 'screen-chat' : 'screen-main');
});

socket.on('call-ended', () => {
  showToast('Call ended.');
  cleanupCall();
  showScreen(currentChat ? 'screen-chat' : 'screen-main');
});

socket.on('user-offline', () => {
  showToast('User is offline.');
  cleanupCall();
  showScreen(currentChat ? 'screen-chat' : 'screen-main');
});

function endCall() {
  if (currentCallTo) socket.emit('call-end', { to: currentCallTo });
  cleanupCall();
  showScreen(currentChat ? 'screen-chat' : 'screen-main');
}

function cleanupCall() {
  localStream?.getTracks().forEach(t => t.stop());
  peerConn?.close();
  localStream = peerConn = null;
  currentCallTo = null;
  isMuted = false; isCamOff = false;
  $('video-container').style.display = 'none';
  $('btn-cam-toggle').style.display = 'none';
  $('btn-mute').textContent = '🎙️';
  $('btn-cam-toggle').textContent = '📷';
}

function showCallScreen(name, status) {
  $('call-avatar').textContent       = firstLetter(name);
  $('call-contact-name').textContent = name;
  $('call-status').textContent       = status;
  showScreen('screen-call');
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('btn-mute').textContent = isMuted ? '🔇' : '🎙️';
}

function toggleCam() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  $('btn-cam-toggle').textContent = isCamOff ? '🚫' : '📷';
}
