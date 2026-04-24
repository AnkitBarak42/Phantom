# 👻 Phantom

Phantom — A private, RAM-only app with text messaging, audio calling, and video calling.
Built with Node.js, Socket.io, and WebRTC.

> ⚠️ **Zero storage policy** — No messages, calls, or sessions are ever saved.
> Everything lives in RAM only. Refresh = data gone. Server restart = all data wiped.

---

## 🎨 Features
- 📞 Audio Calling (WebRTC P2P)
- 📹 Video Calling (WebRTC P2P)
- 💬 Text Messaging (real-time via Socket.io)
- 🔐 Phone number login with simulated OTP
- 🔴 Red + White WhatsApp-style UI
- 📵 Absolutely zero data persistence

---

## 📁 Folder Structure

```
phantom-app/
├── server.js              ← Node.js + Socket.io backend
├── package.json           ← Server dependencies
├── render.yaml            ← Render auto-deploy config
├── capacitor.config.json  ← APK wrapping config
├── .gitignore
├── README.md
└── client/
    ├── index.html         ← App UI (all screens)
    ├── style.css          ← Red + White theme
    └── app.js             ← All frontend logic
```

---

## 🚀 STEP 1 — Deploy to Render

### 1.1 Push to GitHub

```bash
cd phantom-app
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/phantom-app.git
git push -u origin main
```

### 1.2 Deploy on Render

1. Go to **https://render.com** and log in
2. Click **New → Web Service**
3. Connect your GitHub repo: `phantom-app`
4. Render will auto-detect `render.yaml`
5. Click **Deploy**
6. Wait ~2 minutes
7. Your URL will be: `https://phantom-app-xxxx.onrender.com`

### 1.3 Update SERVER_URL in app.js

Open `client/app.js` and update line 10:

```javascript
const SERVER_URL = 'https://phantom-app-xxxx.onrender.com'; // ← your Render URL
```

Commit and push again:
```bash
git add client/app.js
git commit -m "Set Render server URL"
git push
```

Render will auto-redeploy.

### ✅ Test in Browser

Open `https://phantom-app-xxxx.onrender.com` on two different phones/browsers.
Login with different numbers. Test chat and calls!

---

## 📦 STEP 2 — Build Android APK (VS Code + Capacitor)

### 2.1 Prerequisites

Install these first (if not already installed):

- **Node.js** → https://nodejs.org (v18+)
- **Android Studio** → https://developer.android.com/studio
- **Java JDK 17** → https://adoptium.net

After installing Android Studio:
- Open Android Studio → SDK Manager
- Install: Android SDK, Android SDK Platform (API 33+), Android SDK Build-Tools

### 2.2 Install Capacitor

Open VS Code terminal in your `phantom-app/` folder:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
```

### 2.3 Update capacitor.config.json

Open `capacitor.config.json` and set your Render URL:

```json
{
  "server": {
    "url": "https://phantom-app-xxxx.onrender.com"
  }
}
```

### 2.4 Add Android Platform

```bash
npx cap add android
```

### 2.5 Sync and Open in Android Studio

```bash
npx cap sync android
npx cap open android
```

This opens Android Studio with your project.

### 2.6 Build APK in Android Studio

1. In Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**
2. Wait for build to finish
3. Click **"locate"** in the success notification
4. Your APK is at: `android/app/build/outputs/apk/debug/app-debug.apk`

### 2.7 Install APK on Phone

- Enable **"Install unknown apps"** on your Android phone
- Transfer APK via USB or WhatsApp/email
- Tap to install

---

## 📞 HOW IT WORKS

### Login Flow
1. Enter 10-digit phone number
2. OTP is generated and shown on screen (demo mode)
3. Enter OTP → registered with server in RAM
4. Refresh = logged out (no persistence)

### Calling Flow
```
User A (Caller)                    User B (Callee)
    │                                   │
    ├─ startCall() ─────────────────────►│
    │  socket: call-offer               │  incoming-call event
    │                                   │  [Accept / Decline screen]
    │◄─────────────────── call-answer ──┤
    │                                   │
    ├──── ICE candidates exchange ──────┤
    │                                   │
    └─── WebRTC P2P stream ────────────►│
         (audio / video directly        │
          between devices)              │
```

### What is NEVER stored
- ❌ Messages (RAM only, cleared on refresh)
- ❌ Call logs (not even duration)
- ❌ Phone numbers (cleared on server restart)
- ❌ Audio/video recordings (WebRTC is P2P, no server passes media)

---

## ⚙️ Run Locally (for testing)

```bash
cd phantom-app
npm install
node server.js
```

Open `http://localhost:3000` in two browser tabs.

---

## 🔧 Troubleshooting

| Problem | Fix |
|---|---|
| Video/audio not working | Allow camera/mic in browser permissions |
| Users can't connect | Check STUN servers are accessible (need internet) |
| Render free tier sleeps | Upgrade to paid, or use UptimeRobot to ping |
| APK camera/mic denied | Check Android permissions in app settings |

---

## 🛡️ Privacy Notes

- Server stores zero data to disk
- WebRTC audio/video is peer-to-peer (not routed through server)
- Text messages exist only in browser RAM
- Server restart wipes all user registrations

---

Made with ❤️ using Node.js, Socket.io, WebRTC
