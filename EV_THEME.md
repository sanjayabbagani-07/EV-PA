# EV theme: what changed

Your Jarvis project with the **EV interface** from EV.html applied. No feature was removed.

## Changed
- **Look:** new `frontend/ev-theme.css` + `frontend/ev-theme.js` (loaded last, so they sit on top of the old styles). Red/blue HUD, Orbitron + Rajdhani fonts, web background, scanlines, spider reactor on the home screen that reacts to listening / processing / speaking, boot sequence (once per session, tap to skip), header clock.
- **Colours:** every purple / mint / cyan in the app, settings, connectors, admin, website and effects CSS was recoloured to EV red and blue (hue shift only).
- **Name:** visible text KALKI / Kalki / Jarvis -> **EV**. Logo -> EV spider (app, website, Android icon).
- **Android:** app name "EV", new icon, notification text, wake phrase **"Hey EV"** added. "Hey KALKI" and "Hey Jarvis" still work. Telugu replies unchanged.
- **APK build workflow:** now loads the Pages site of the repo it is built in (was hard-wired to another account).

## Not touched (on purpose)
File names, CSS classes, JS functions/events, storage keys, Android package `com.growthos.jarvis`, backend routes, env var names (`KALKI_*`, `JARVIS_*`). Renaming them risks breaking things and does not change what you see.

## Point these at YOUR hosting
These still point at the original author's deployment:
- `https://jarvis-mobile-edition-alpha.vercel.app` (`/api/health`, `/api/command`, `/api/interaction/analyze`) in `frontend/script.js`
- Android default start URL in `android/app/build.gradle.kts` (the GitHub workflow already overrides it)
Until you deploy your own backend (see DEPLOYMENT.md, `render.yaml`) and change the first one, commands and tools run on that other backend.

## Known leftovers
- The "Visual effects" lab (`frontend/effects`) keeps its own colours inside its compiled bundle.
- `desktop-agent/` text still says KALKI.
- Fonts load from Google Fonts, so they need internet (system fonts are the fallback).
