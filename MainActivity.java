package com.phantom.app;

import android.os.Bundle;
import android.view.WindowManager;
import android.media.AudioManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // ============================================================
    // SECURITY: Block screenshots and screen recording completely
    // FLAG_SECURE prevents ANY screen capture on Android
    // ============================================================
    getWindow().setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE
    );

    // ============================================================
    // AUDIO: Force earpiece only — disable speaker/handsfree
    // Users cannot switch to speaker during calls
    // ============================================================
    AudioManager audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
    if (audioManager != null) {
      audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
      audioManager.setSpeakerphoneOn(false);
    }
  }
}
