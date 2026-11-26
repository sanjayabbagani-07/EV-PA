# EV Android shell

Thin, secure Android WebView wrapper around the deployed `frontend/`. Package ID remains `com.growthos.jarvis`; no backend credentials, API keys, or bundled secrets are embedded. The build-time URL must be HTTPS and defaults to the GitHub Pages frontend.

## Android pairing and app control (Phases 1–3)
- The existing Android app pairs from **Settings → Android companion** in the EV frontend. The owner signs in with `EV_OWNER_PASSPHRASE`, creates a one-time code, then pastes it into the pairing field and selects **Pair this phone**.
- Pairing codes expire after five minutes and are single-use. The Android app exchanges the code with the existing `/api/agent` backend over HTTPS, stores the returned random device credential encrypted with Android Keystore AES-GCM, and sends an authenticated status heartbeat while the app is in the foreground.
- **Disconnect this phone** revokes the backend credential before clearing local storage. If the backend cannot be reached, EV reports the failure and retains the credential so it does not claim revocation succeeded. The owner can also revoke active devices in the same settings panel.
- The frontend and Android build must use the same backend origin. The frontend currently configures `EV_BACKEND_BASE` in `frontend/script.js`; `JARVIS_BACKEND_URL` configures the native companion.
- EV tools can list launchable apps, initiate app launches, open HTTP(S) links, navigate back, tap accessible controls, enter ordinary text, scroll, and read a limited visible-state summary. Launch and link results confirm Android accepted the launch intent; they do not prove the destination app finished loading.
- Commands travel through the paired device's authenticated HTTPS polling channel. The phone must be online; keep EV open for app launch and URL actions. When Accessibility is enabled, its bound service keeps the command channel active while another app is foregrounded.
- Accessible UI interaction is optional and user-enabled: in EV Settings choose **Open Android Accessibility Settings**, review **EV user-authorized app control**, and manually turn it on. The service does not inspect accessibility events; it reads visible labels only when an explicit `android.get_visible_state` action is requested, excludes editable values, and does not capture screenshots. Turn it off any time in Android Accessibility Settings.
- The UI tools never enter passwords, verification codes, payment credentials, or other sensitive fields. EV cannot bypass login screens, CAPTCHAs, biometrics, or application security. App accessibility and navigation behavior varies.
- Device metadata, capability status, and pending commands are currently held by the backend's in-memory store. A backend restart invalidates pairings and credentials; pair again after restart. This is not a durable production device registry.
- Additional Android app-specific automation such as YouTube search/playback is not included; these phases provide generic app discovery, launching, and accessible interactions.

## Final EV wake experience
- Wake is OFF by default and is never started at boot. The user explicitly enables it from the frontend and grants microphone/notification permissions.
- `WakeWordService.java` is an Android foreground microphone service with a visible ongoing notification and a **Stop EV** action. It uses `START_STICKY` only after explicit enablement so Android can reconnect the user-enabled service after process pressure; it does not create a boot receiver and an explicit Stop destroys it.
- Android 12+ requests the platform on-device `SpeechRecognizer` when the device exposes one and also sets `EXTRA_PREFER_OFFLINE`; otherwise it uses the platform recognizer. This is the strongest no-secret, low-latency implementation available without shipping a third-party model. It is **not** a deterministic always-on hotword engine: recognition availability, Telugu/English language packs, OEM policy, and network fallback remain device-dependent.
- Both **“Hey EV”** and legacy **“Hey EV”** are accepted. On a bare wake phrase the service speaks the exact Telugu acknowledgement **“చెప్పండి Boss”**, then listens for one command. A wake phrase with an inline command is also supported.
- “Stop EV” / “Stop EV” stops the foreground listener. External actions remain explicit; no incoming-message auto-replies or automatic messaging are implemented.
- Telugu TTS uses `te-IN` when the device has the voice data and safely falls back to `en-IN` only if Telugu TTS data is unavailable. The acknowledgement text is not changed.

## Honest platform limitations
A home-screen/locked-screen demonstration is **not claimed until physical OnePlus testing**. Android may restrict microphone recognition after force-stop, OEM battery management, denied permissions, missing language data, or user/system microphone privacy controls. Force-stopping EV from Android Settings is a deliberate hard stop that a foreground service cannot bypass; the user must reopen the app and enable wake again. Disable battery optimization only if the user chooses to do so in Android settings.

No bundled Porcupine/Vosk/wake-word model was added: shipping one would require selecting and complying with its license/model terms, increasing APK size, and validating Telugu-accent accuracy. The platform on-device recognizer is therefore used where available rather than pretending a legal offline keyword model exists.

## Build and test
The project pins Android Gradle Plugin 8.7.3, which requires Gradle 8.9 and JDK 17; Android SDK 35 must also be installed. This repository does not include a Gradle wrapper, so use a compatible installed Gradle version.

```bash
gradle --no-daemon -p android :app:assembleDebug
# optional URL override (must be HTTPS)
gradle --no-daemon -p android :app:assembleDebug -PJARVIS_START_URL=https://your-frontend.example/
# backend URL override (must be HTTPS; no trailing slash required)
gradle --no-daemon -p android :app:assembleDebug -PJARVIS_BACKEND_URL=https://your-ev-backend.example
```

Install with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`. On a Moto phone, pair it while EV is open; verify connection status, use **Run Android task** with “List launchable apps” and “Open Settings,” then manually enable the Accessibility Service. Return to EV and test “Go back,” tapping a visible non-sensitive element, typing into an ordinary search field without submitting it, scrolling, and requesting visible state. Confirm password/OTP fields are refused, disable the service in Settings, and verify EV reports it disabled. Physical-device testing remains required; no physical touch behavior is claimed until these steps have been performed on-device.
