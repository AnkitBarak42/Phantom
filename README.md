# 👻 Phantom v2.0

Private messaging + calling app with **admin-approved login**.

---

## 📁 Project Structure

```
phantom/
├── server.js                   ← Single backend for both apps
├── package.json
├── .env                        ← (create from .env.example)
├── render.yaml
├── client/                     ← User APK source
│   ├── index.html
│   ├── style.css
│   └── app.js
├── admin/                      ← Admin APK source
│   ├── index.html
│   ├── style.css
│   └── app.js
├── capacitor.user.config.json  ← Config for User APK
└── capacitor.admin.config.json ← Config for Admin APK
```

---

## 🚀 Setup

### 1. Environment Variables

```bash
cp .env.example .env
```

Fill in `.env`:
```
ADMIN_USERNAME=your_username
ADMIN_PASSWORD=your_strong_password
```

On Render → Environment tab → add both variables.

### 2. Deploy to Render

Push to GitHub → connect repo on Render → it auto-deploys.

---

## 📱 Building APKs

### Prerequisites
```bash
npm install -g @capacitor/cli
npm install @capacitor/android
```

### User APK

```bash
# Copy capacitor config
cp capacitor.user.config.json capacitor.config.json

# Update YOUR-RENDER-URL in capacitor.config.json

# Add Android platform
npx cap add android
npx cap sync

# Build APK in Android Studio
npx cap open android
# → Build → Generate Signed Bundle/APK
```

### Admin APK

```bash
cp capacitor.admin.config.json capacitor.config.json
# Update YOUR-RENDER-URL in capacitor.config.json
npx cap sync
npx cap open android
# → Build → Generate Signed Bundle/APK
```

---

## 🔑 Admin Access

- Admin opens the Admin APK
- Login with ADMIN_USERNAME + ADMIN_PASSWORD from .env
- Pending requests appear in real time
- Approve → user gets auto-logged in instantly
- Reject → user sees rejection message
- Approved users stored on admin's device only

---

## 🔄 User Flow

```
Install User APK
       ↓
Fill form: Name, Mobile, Gender, Age, Address
       ↓
Tap "Request Login"
       ↓
Wait for admin approval
       ↓
Admin approves → auto login
       ↓
Stays logged in forever (WhatsApp-style)
       ↓
Logout → needs fresh request
```

---

## 💡 Keep Render Awake (Free)

Use UptimeRobot (free) to ping your Render URL every 10 minutes → server never sleeps.
