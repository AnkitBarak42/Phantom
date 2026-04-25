# 🔒 Phantom APK Security Guide

## FLAG_SECURE — Block Screenshots + Screen Recording

After running `npx cap add android`, follow these steps:

### Step 1 — Find MainActivity.java
Navigate to:
```
android/app/src/main/java/com/phantom/app/MainActivity.java
```

### Step 2 — Replace entire file content
Replace everything in `MainActivity.java` with the content from:
```
android-patch/MainActivity.java
```

### Step 3 — Sync and build
```bash
npx cap sync android
npx cap open android
```

In Android Studio:
```
Build → Build Bundle(s) / APK(s) → Build APK(s)
```

---

## What FLAG_SECURE does:
- ✅ Blocks Android screenshot (power + volume)
- ✅ Blocks screen recording apps
- ✅ Blocks casting/mirroring apps
- ✅ App appears as black screen in recent apps
- ✅ Blocks Google Assistant screen reading

## Earpiece-Only Audio:
- ✅ Forces all audio through earpiece
- ✅ Speaker button removed from UI
- ✅ setSpeakerphoneOn(false) prevents physical speaker button
- ✅ MODE_IN_COMMUNICATION = phone call quality audio

## Legal Warning:
- ✅ Shown on incoming call screen
- ✅ Shown during active call
- Text: "🔒 Recording this call is strictly prohibited"
