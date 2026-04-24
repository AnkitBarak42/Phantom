// ============================================================
//  CALLING APP — Frontend Logic
//  RAM only. No localStorage. No recording. No persistence.
// ============================================================

// ⚠️  IMPORTANT: Change this to your Render server URL after deploy
//     e.g. 'https://phantom-app-xyz.onrender.com'
//     Leave as empty string to auto-detect (works when served from same server)
const SERVER_URL = 'https://phantom-d603.onrender.com';

// ============================================================
//  STATE — lives in RAM only
// ============================================================
let socket         = null;
let myPhone        = '';
let myOTP          = '';
let currentChat    = '';         // phone number of active chat partner
let peerConnection = null;
let localStream    = null;
let currentCallType = null;      // 'audio' | 'video'
let pendingOffer   = null;
let pendingCallFrom = null;
let isMuted        = false;
let callTimerInterval = null;
let callSeconds    = 0;

// In-memory messages: Map<phoneNumber, [{from, message, timestamp}]>
const chatMessages = new Map();
// Contacts seen this session: Map<phoneNumber, {lastMsg, lastTime}>
const contacts     = new Map();

// WebRTC config — STUN + free TURN servers for mobile network compatibility
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Free TURN servers via Open Relay — improves mobile/symmetric NAT success
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// ICE candidate queue — holds candidates that arrive before peerConnection is ready
let iceCandidateQueue = [];

// ============================================================
//  INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  const serverUrl = SERVER_URL || window.location.origin;
  socket = io(serverUrl, { transports: ['websocket', 'polling'] });
  setupSocketEvents();
  setupUIEvents();
  showScreen('login');
});

// ============================================================
//  SCREEN NAVIGATION
// ============================================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

// ============================================================
//  SOCKET EVENTS
// ============================================================
function setupSocketEvents() {

  socket.on('connect', () => console.log('[Socket] Connected:', socket.id));
  socket.on('disconnect', () => console.log('[Socket] Disconnected'));

  // Registration confirmed
  socket.on('registered', ({ phoneNumber }) => {
    myPhone = phoneNumber;
    document.getElementById('my-avatar-initials').textContent = phoneNumber.slice(-2);
    showScreen('home');
    showToast(`✅ Logged in as ${phoneNumber}`);
  });

  // User online status
  socket.on('user-status', ({ phoneNumber, isOnline }) => {
    if (phoneNumber === currentChat) {
      document.getElementById('chat-header-status').textContent =
        isOnline ? '🟢 Online' : '⭕ Offline';
    }
  });

  // Receive text message
  socket.on('receive-message', ({ from, message, timestamp }) => {
    storeMessage(from, { from, message, timestamp, mine: false });
    updateContact(from, message, timestamp);
    if (currentChat === from) {
      renderMessage({ from, message, timestamp, mine: false });
      scrollToBottom();
    } else {
      showToast(`💬 ${from}: ${message.substring(0, 40)}`);
      renderContactList();
    }
  });

  // Message delivered ack
  socket.on('message-delivered', () => {});

  // User offline when trying to message/call
  socket.on('user-offline', ({ phoneNumber }) => {
    showToast(`❌ ${phoneNumber} is not online`);
    if (['calling'].includes(getCurrentScreen())) showScreen('chat');
  });

  // ---- INCOMING CALL ----
  socket.on('incoming-call', ({ from, offer, callType }) => {
    pendingOffer    = offer;
    pendingCallFrom = from;
    currentCallType = callType;

    document.getElementById('incoming-avatar').textContent = from.slice(-2);
    document.getElementById('incoming-number').textContent = from;
    document.getElementById('incoming-type-label').textContent =
      callType === 'video' ? '📹 Video Call' : '📞 Audio Call';
    document.getElementById('incoming-call-status').textContent = 'Incoming Call…';

    // FIX 9: Play ringtone on incoming call
    const ringtone = document.getElementById('ringtone');
    ringtone.currentTime = 0;
    ringtone.play().catch(() => {}); // catch needed for autoplay policy

    showScreen('incoming');
  });

  // Call answered (callee accepted)
  socket.on('call-answered', async ({ answer }) => {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      // FIX 5: Drain any ICE candidates that arrived before remote description was set
      for (const c of iceCandidateQueue) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
      }
      iceCandidateQueue = [];
    }
  });

  // ICE candidate from the other side
  socket.on('ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    if (peerConnection && peerConnection.remoteDescription) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) { console.warn('ICE error:', e); }
    } else {
      // FIX 5: Queue candidates that arrive before peerConnection is ready
      iceCandidateQueue.push(candidate);
    }
  });

  // Call declined
  socket.on('call-declined', () => {
    showToast('❌ Call declined');
    cleanupCall();
    // FIX 4: Navigate to correct screen — not always 'chat'
    showScreen(currentChat ? 'chat' : 'home');
  });

  // Call ended by other party
  socket.on('call-ended', () => {
    showToast('📵 Call ended');
    cleanupCall();
    // FIX 4: Navigate to correct screen — not always 'chat'
    showScreen(currentChat ? 'chat' : 'home');
  });
}

// ============================================================
//  UI EVENTS
// ============================================================
function setupUIEvents() {

  // --- LOGIN ---
  document.getElementById('btn-send-otp').addEventListener('click', handleSendOTP);
  document.getElementById('phone-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSendOTP();
  });

  // --- OTP ---
  document.getElementById('btn-verify-otp').addEventListener('click', handleVerifyOTP);
  document.getElementById('btn-back-login').addEventListener('click', () => showScreen('login'));

  // OTP box auto-advance
  const otpBoxes = document.querySelectorAll('.otp-box');
  otpBoxes.forEach((box, i) => {
    box.addEventListener('input', (e) => {
      // Keep only single digit
      box.value = box.value.slice(-1);
      if (box.value && i < otpBoxes.length - 1) otpBoxes[i + 1].focus();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) otpBoxes[i - 1].focus();
    });
  });

  // --- HOME ---
  document.getElementById('btn-open-chat').addEventListener('click', handleOpenChat);
  document.getElementById('search-phone').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleOpenChat();
  });

  // --- CHAT ---
  document.getElementById('btn-back-home').addEventListener('click', () => {
    currentChat = '';
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

  // --- OUTGOING CALL ---
  document.getElementById('btn-cancel-call').addEventListener('click', () => {
    socket.emit('call-end', { to: currentChat });
    cleanupCall();
    showScreen('chat');
  });

  // --- INCOMING CALL ---
  document.getElementById('btn-accept-call').addEventListener('click', acceptCall);
  document.getElementById('btn-decline-call').addEventListener('click', () => {
    document.getElementById('ringtone').pause(); // FIX 9: stop ring
    socket.emit('call-decline', { to: pendingCallFrom });
    pendingOffer    = null;
    pendingCallFrom = null;
    showScreen(currentChat ? 'chat' : 'home');
  });

  // --- ACTIVE CALL ---
  document.getElementById('btn-end-call').addEventListener('click', () => {
    socket.emit('call-end', { to: currentChat || pendingCallFrom });
    cleanupCall();
    showScreen('chat');
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

  // Generate random 6-digit OTP (simulated)
  // myOTP = String(Math.floor(100000 + Math.random() * 900000));
  // alert('👻 Your Phantom OTP: ' + myOTP);
  myOTP = '193618';

  // Show OTP on screen (demo mode — no SMS)
  // const hint = document.getElementById('otp-hint');
  // hint.style.display = 'block';
 //  hint.innerHTML = `🔑 Your OTP: <strong>${myOTP}</strong><br/><small>(In production, this arrives via SMS)</small>`;

  document.getElementById('otp-subtitle').textContent =
    `Enter the OTP for +91 ${phone}`;

  // Clear OTP boxes
  document.querySelectorAll('.otp-box').forEach(b => b.value = '');
  myPhone = phone;

  showScreen('otp');
  setTimeout(() => document.querySelector('.otp-box').focus(), 200);
}

function handleVerifyOTP() {
  const entered = Array.from(document.querySelectorAll('.otp-box'))
    .map(b => b.value).join('');

  if (entered.length < 6) {
    showToast('⚠️ Enter all 6 digits');
    return;
  }
  if (entered !== myOTP) {
    showToast('❌ Wrong OTP. Try again.');
    return;
  }

  // Register with server
  socket.emit('register', { phoneNumber: myPhone });
}

// ============================================================
//  HOME — Open Chat
// ============================================================
function handleOpenChat() {
  const phone = document.getElementById('search-phone').value.trim();
  if (phone.length < 10) {
    showToast('⚠️ Enter a valid 10-digit number');
    return;
  }
  if (phone === myPhone) {
    showToast('⚠️ You cannot chat with yourself');
    return;
  }
  openChat(phone);
}

function openChat(phone) {
  currentChat = phone;

  // Update chat header
  document.getElementById('chat-header-avatar').textContent = phone.slice(-2);
  document.getElementById('chat-header-name').textContent = phone;
  document.getElementById('chat-header-status').textContent = 'Checking…';

  // Check if online
  socket.emit('check-user', { phoneNumber: phone });

  // Render existing messages
  const msgs = document.getElementById('chat-messages');
  while (msgs.children.length > 1) msgs.removeChild(msgs.lastChild);

  const history = chatMessages.get(phone) || [];
  history.forEach(m => renderMessage(m));
  scrollToBottom();

  // FIX 10: Add to contact list immediately on open (not just after first message)
  if (!contacts.has(phone)) {
    updateContact(phone, 'Chat started', Date.now());
    renderContactList();
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

  socket.emit('send-message', {
    to: currentChat,
    from: myPhone,
    message: text,
    messageId
  });

  const msgObj = { from: myPhone, message: text, timestamp, mine: true };
  storeMessage(currentChat, msgObj);
  updateContact(currentChat, text, timestamp);
  renderMessage(msgObj);
  scrollToBottom();
  renderContactList();

  input.value = '';
  input.style.height = 'auto';
}

function storeMessage(phone, msgObj) {
  if (!chatMessages.has(phone)) chatMessages.set(phone, []);
  chatMessages.get(phone).push(msgObj);
}

function updateContact(phone, lastMsg, lastTime) {
  contacts.set(phone, { lastMsg, lastTime });
}

function renderMessage({ from, message, timestamp, mine }) {
  const wrap = document.createElement('div');
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

function renderContactList() {
  const list = document.getElementById('contacts-list');
  const placeholder = document.getElementById('no-chats-placeholder');

  // Remove old contact items
  list.querySelectorAll('.contact-item').forEach(el => el.remove());

  if (contacts.size === 0) {
    placeholder.style.display = 'block';
    return;
  }
  placeholder.style.display = 'none';

  // Sort by most recent
  const sorted = [...contacts.entries()].sort((a, b) => b[1].lastTime - a[1].lastTime);

  sorted.forEach(([phone, { lastMsg, lastTime }]) => {
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.innerHTML = `
      <div class="contact-avatar">${phone.slice(-2)}</div>
      <div class="contact-info">
        <div class="contact-name">${phone}</div>
        <div class="contact-preview">${escapeHtml(lastMsg.substring(0, 50))}</div>
      </div>
      <div class="contact-time">${formatTime(lastTime)}</div>
    `;
    item.addEventListener('click', () => openChat(phone));
    list.appendChild(item);
  });
}

// ============================================================
//  CALLING — OUTGOING
// ============================================================
async function startCall(type) {
  if (!currentChat) return;
  currentCallType = type;

  // Show outgoing call screen
  document.getElementById('calling-avatar').textContent = currentChat.slice(-2);
  document.getElementById('calling-number').textContent = currentChat;
  document.getElementById('calling-type-label').textContent =
    type === 'video' ? '📹 Video Call' : '📞 Audio Call';

  showScreen('calling');

  try {
    // Get user media
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video'
    });

    // Create peer connection
    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    setupPeerConnectionEvents(currentChat);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('call-offer', {
      to: currentChat,
      from: myPhone,
      offer,
      callType: type
    });

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
  currentChat = pendingCallFrom;
  document.getElementById('ringtone').pause(); // FIX 9: stop ringtone

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: currentCallType === 'video'
    });

    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    setupPeerConnectionEvents(pendingCallFrom);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingOffer));

    // FIX 5: Drain ICE candidates queued before remote description was set
    for (const c of iceCandidateQueue) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
    }
    iceCandidateQueue = [];

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('call-answer', {
      to: pendingCallFrom,
      from: myPhone,
      answer
    });

    // FIX 3: Do NOT call showActiveCallUI() here.
    // onconnectionstatechange === 'connected' is the single trigger for both caller and callee.

  } catch (err) {
    console.error('Accept call error:', err);
    showToast('❌ Could not access microphone/camera');
    socket.emit('call-decline', { to: pendingCallFrom });
    pendingOffer = null;
    pendingCallFrom = null;
    showScreen('home');
  }
}

// ============================================================
//  PEER CONNECTION SETUP
// ============================================================
function setupPeerConnectionEvents(remotePhone) {
  // ICE candidate
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        to: remotePhone,
        candidate: event.candidate
      });
    }
  };

  // Connection state
  peerConnection.onconnectionstatechange = () => {
    console.log('[WebRTC] State:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'connected') {
      showActiveCallUI();
    }
    if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
      showToast('📵 Call disconnected');
      cleanupCall();
      showScreen('chat');
    }
  };

  // Remote stream
  const remoteStream = new MediaStream();
  peerConnection.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
    if (currentCallType === 'video') {
      document.getElementById('remote-video').srcObject = remoteStream;
    }
  };

  // Local video preview
  if (currentCallType === 'video' && localStream) {
    document.getElementById('local-video').srcObject = localStream;
  }
}

// ============================================================
//  ACTIVE CALL UI
// ============================================================
function showActiveCallUI() {
  const activePhone = currentChat || pendingCallFrom;

  document.getElementById('active-call-avatar').textContent = activePhone.slice(-2);
  document.getElementById('active-call-number').textContent = activePhone;

  const videoContainer  = document.getElementById('video-container');
  const audioUI         = document.getElementById('audio-call-ui');
  const toggleVideoBtn  = document.getElementById('btn-toggle-video');

  if (currentCallType === 'video') {
    videoContainer.classList.remove('hidden');
    audioUI.classList.add('hidden');
    toggleVideoBtn.classList.remove('hidden');
    if (localStream) document.getElementById('local-video').srcObject = localStream;
  } else {
    videoContainer.classList.add('hidden');
    audioUI.classList.remove('hidden');
    toggleVideoBtn.classList.add('hidden');
  }

  showScreen('call-active');
  startCallTimer();

  pendingOffer    = null;
  pendingCallFrom = null;
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
    const timerEl = document.getElementById('call-timer');
    if (timerEl) timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

// ============================================================
//  CLEANUP
// ============================================================
function cleanupCall() {
  clearInterval(callTimerInterval);
  callSeconds = 0;
  isMuted = false;

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  // Clear video elements
  const rv = document.getElementById('remote-video');
  const lv = document.getElementById('local-video');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;

  pendingOffer    = null;
  pendingCallFrom = null;
  currentCallType = null;
}

// ============================================================
//  HELPERS
// ============================================================
function getCurrentScreen() {
  const active = document.querySelector('.screen.active');
  return active ? active.id.replace('screen-', '') : '';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
