'use strict';

const socket = io(window.location.origin, { transports: ['websocket'] });

// ── STATE ─────────────────────────────────────────────────────
let adminToken      = null;
let pendingRequests = {};  // requestId -> request object
let approvedUsers   = {};  // uniqueId  -> user object
let rejectTargetId  = null;

// ── HELPERS ───────────────────────────────────────────────────
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
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}
function firstLetter(name) { return (name || '?')[0].toUpperCase(); }

// ── LOCAL STORAGE ─────────────────────────────────────────────
function saveToken()   { if (adminToken) localStorage.setItem('phantom_admin_token', adminToken); }
function saveApproved(){ localStorage.setItem('phantom_approved', JSON.stringify(approvedUsers)); }
function clearToken()  { adminToken = null; localStorage.removeItem('phantom_admin_token'); }
function loadSaved() {
  adminToken = localStorage.getItem('phantom_admin_token') || null;
  try {
    const a = localStorage.getItem('phantom_approved');
    if (a) approvedUsers = JSON.parse(a);
  } catch(e) {}
}

// ── BOOT ──────────────────────────────────────────────────────
loadSaved();
if (adminToken) {
  socket.emit('admin-reconnect', { token: adminToken });
} else {
  showScreen('screen-login');
}

// ── LOGIN ─────────────────────────────────────────────────────
$('btn-login').addEventListener('click', doLogin);
$('inp-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

function doLogin() {
  const username = $('inp-username').value.trim();
  const password = $('inp-password').value;
  $('login-error').textContent = '';
  if (!username || !password) { $('login-error').textContent = 'Enter username and password.'; return; }
  $('btn-login').disabled = true;
  $('btn-login').textContent = 'Logging in...';
  socket.emit('admin-login', { username, password });
}

socket.on('admin-auth', ({ success, token, error }) => {
  $('btn-login').disabled = false;
  $('btn-login').textContent = 'Login';
  if (success) {
    adminToken = token;
    saveToken();
    initDashboard();
  } else {
    $('login-error').textContent = error || 'Invalid credentials.';
  }
});

socket.on('admin-session-expired', () => {
  clearToken();
  showScreen('screen-login');
  showToast('Session expired. Please login again.');
});

// ── DASHBOARD ─────────────────────────────────────────────────
function initDashboard() {
  renderPending();
  renderApproved();
  showScreen('screen-dashboard');
}

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

$('btn-logout').addEventListener('click', () => {
  if (!confirm('Logout from admin panel?')) return;
  clearToken();
  showScreen('screen-login');
  $('inp-username').value = '';
  $('inp-password').value = '';
});

// ── PENDING REQUESTS ──────────────────────────────────────────
socket.on('pending-requests', ({ requests }) => {
  pendingRequests = {};
  requests.forEach(r => pendingRequests[r.requestId] = r);
  renderPending();
});

socket.on('new-request', (request) => {
  pendingRequests[request.requestId] = request;
  renderPending();
  showToast(`📩 New request from ${request.name}`);
  // Vibrate if supported
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
});

socket.on('request-processed', ({ requestId, uniqueId, action, userDetails }) => {
  if (action === 'approved' && uniqueId && userDetails) {
    approvedUsers[uniqueId] = {
      uniqueId,
      name:       userDetails.name,
      mobile:     userDetails.mobile,
      gender:     userDetails.gender,
      age:        userDetails.age,
      address:    userDetails.address,
      approvedAt: Date.now(),
    };
    saveApproved();
    renderApproved();
    showToast(`✅ ${userDetails.name} approved → ID: ${uniqueId}`);
  } else if (action === 'rejected') {
    showToast('❌ Request rejected.');
  }
  delete pendingRequests[requestId];
  renderPending();
});

socket.on('admin-error', ({ error }) => {
  showToast('Error: ' + error);
});

function renderPending() {
  const list = $('pending-list');
  const keys = Object.keys(pendingRequests);
  $('pending-badge').textContent = keys.length;

  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state">No pending requests.<br/>You\'ll be notified when someone requests access.</div>';
    return;
  }

  list.innerHTML = keys.map(rid => {
    const r = pendingRequests[rid];
    return `
      <div class="request-card" id="card-${rid}">
        <div class="card-header">
          <div class="card-avatar">${firstLetter(r.name)}</div>
          <div>
            <div class="card-name">${r.name}</div>
            <div class="card-time">${formatTime(r.timestamp)}</div>
          </div>
        </div>
        <div class="card-details">
          <div class="detail-item">
            <div class="detail-label">Mobile</div>
            <div class="detail-value">${r.mobile}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Gender</div>
            <div class="detail-value">${r.gender}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Age</div>
            <div class="detail-value">${r.age}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Address</div>
            <div class="detail-value">${r.address}</div>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-approve" onclick="approveRequest('${rid}')">✅ Approve</button>
          <button class="btn-reject"  onclick="openRejectModal('${rid}')">❌ Reject</button>
        </div>
      </div>
    `;
  }).join('');
}

function approveRequest(requestId) {
  const card = $(`card-${requestId}`);
  if (card) { card.style.opacity = '.5'; card.style.pointerEvents = 'none'; }
  socket.emit('approve-request', { requestId, token: adminToken });
}

function openRejectModal(requestId) {
  rejectTargetId = requestId;
  $('inp-reject-reason').value = '';
  $('reject-modal').style.display = 'flex';
}

$('btn-confirm-reject').addEventListener('click', () => {
  if (!rejectTargetId) return;
  const reason = $('inp-reject-reason').value.trim();
  socket.emit('reject-request', { requestId: rejectTargetId, token: adminToken, reason });
  $('reject-modal').style.display = 'none';
  rejectTargetId = null;
});

$('btn-cancel-reject').addEventListener('click', () => {
  $('reject-modal').style.display = 'none';
  rejectTargetId = null;
});

// ── APPROVED USERS ────────────────────────────────────────────
function renderApproved() {
  const list = $('approved-list');
  const keys = Object.keys(approvedUsers);
  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state">No approved users yet.</div>';
    return;
  }
  list.innerHTML = keys.map(uid => {
    const u = approvedUsers[uid];
    return `
      <div class="approved-card">
        <div class="card-header">
          <div class="card-avatar">${firstLetter(u.name)}</div>
          <div>
            <div class="card-name">${u.name}</div>
            <div class="card-time">Approved: ${formatTime(u.approvedAt)}</div>
          </div>
        </div>
        <div class="approved-id-badge">${u.uniqueId}</div>
        <div class="card-details">
          <div class="detail-item">
            <div class="detail-label">Mobile</div>
            <div class="detail-value">${u.mobile}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Gender</div>
            <div class="detail-value">${u.gender}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Age</div>
            <div class="detail-value">${u.age}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Address</div>
            <div class="detail-value">${u.address}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Make functions global for onclick handlers
window.approveRequest  = approveRequest;
window.openRejectModal = openRejectModal;
