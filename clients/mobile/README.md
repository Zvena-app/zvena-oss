# zvena for iOS and Android

Capacitor 8 shells around the zvena web app. The app *is* the website
(`server.url`), so every web feature ships without a store review. The
native code adds only what a website cannot do:

- **Share to zvena**: a link or text shared from any app opens the web app's
  **Save to zvena** screen (`/clip?url=…&title=…&text=…`), filled in. That
  page picks a destination and saves through `POST /api/notes/clip` with the
  person's session; it saves only after a tap, so a crafted link cannot save
  anything by itself.
- **Deep links**: `zvena://<path>` opens `<APP_URL>/<path>` (host + path +
  query + hash), e.g. `zvena://docs?ws=…#Page-<id>`; `zvena://open?url=<URL>`
  opens a URL of the app's own origin. Anything that would leave the origin
  is ignored.
- **Universal links / App Links** for `https://zvena.app` under `/docs`,
  `/n/`, `/share/`, `/join/`, `/projects`, `/home`, `/inbox`, `/clip`. Other
  paths (the website, pricing…) stay in the browser.
- Status bar / safe areas, the splash screen, app icons, push plumbing.

The link rules live in `src/links.js` (tested by `npm test`) and are mirrored
in `android/app/src/main/java/app/zvena/mobile/Links.java` (JUnit:
`./gradlew testDebugUnitTest`) and `ios/App/App/Links.swift`. Change all
three together.

```
capacitor.config.js      app id app.zvena.mobile, server.url = APP_URL, allowNavigation, iOS app-bound domains
www/                     local pages: error.html (no connection, in 10 languages), index.html (bridge to server.url)
src/links.js             deep link, universal link and share mapping (the reference rules)
scripts/prepare.cjs      writes www/app-url.js from APP_URL (run by npm run sync*)
scripts/icons.mjs        icons and splash screens from clients/brand/ (zvena's logo)
scripts/strings.mjs      native strings in the 10 interface languages
scripts/ios-project.mjs  adds Links.swift, entitlements and the share extension target to the Xcode project
android/                 Android Studio project (MainActivity handles share and links)
ios/App/                 Xcode project (Swift Package Manager, no CocoaPods); ShareExtension/ is the share sheet target
```

## Environment

| Variable | Where | Default | Meaning |
| --- | --- | --- | --- |
| `APP_URL` | `npm run sync*`, Gradle | `https://zvena.app` | The server the app opens. Baked into the build (a self-hosted server needs its own build). Must be https (plain http only for `localhost`, `127.0.0.1`, `10.0.2.2`). Gradle uses its host for the App Links intent filter. |
| `ZVENA_VERSION_CODE` | Gradle | `1` | Android versionCode; every Play upload needs a higher one. |
| `ZVENA_KEYSTORE`, `ZVENA_KEYSTORE_PASSWORD`, `ZVENA_KEY_ALIAS`, `ZVENA_KEY_PASSWORD` | Gradle | — | Release signing (upload key). Without them the release build is unsigned. |

The web app serves the files the stores verify (set on the **web** server):

| Variable | Meaning |
| --- | --- |
| `ZVENA_IOS_APP_ID` | `TEAMID.app.zvena.mobile` (comma-separated for several) → `/.well-known/apple-app-site-association` |
| `ZVENA_ANDROID_PACKAGE` | default `app.zvena.mobile` → `/.well-known/assetlinks.json` |
| `ZVENA_ANDROID_CERT_SHA256` | comma-separated SHA-256 fingerprints of the signing certificates (Play App Signing's **app signing key**, plus the upload key if you sideload) |

Without them those routes answer 404 and links simply open in the browser.

For a server other than zvena.app, also change the host in
`ios/App/App/Info.plist` (`WKAppBoundDomains`) and
`ios/App/App/App.entitlements` (`applinks:`).

## Everyday commands

```sh
npm ci                 # Capacitor and plugins (exact versions)
npm test               # link rules (node --test)
npm run sync           # www/ + config + plugins → android/ and ios/ (needed after a fresh clone)
npm run icons          # after changing clients/brand/ (needs sharp; SHARP=/path/to/sharp)
node scripts/strings.mjs
```

`npx cap sync` never rewrites `ios/App/App.xcodeproj/project.pbxproj`; if
`ios/` is ever generated anew (`npx cap add ios --packagemanager SPM`), run
`node scripts/ios-project.mjs` once to put the share extension back.

## Android

Needs JDK 21 and the Android SDK (platform 36, build-tools 36). Gradle comes
with the wrapper.

```sh
export ANDROID_HOME=~/Android/Sdk JAVA_HOME=/path/to/jdk-21
npm run sync:android
cd android
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest        # LinksTest
```

Release (Play Store wants an App Bundle):

```sh
keytool -genkeypair -v -keystore zvena-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
export ZVENA_KEYSTORE=$PWD/zvena-upload.jks ZVENA_KEYSTORE_PASSWORD=… ZVENA_KEY_ALIAS=upload ZVENA_KEY_PASSWORD=… ZVENA_VERSION_CODE=2
npm run android:release            # android/app/build/outputs/bundle/release/app-release.aab
```

Keep the keystore out of the repo (it is git-ignored). In Play Console, turn
on Play App Signing and put the **app signing** certificate's SHA-256
(Setup → App signing) into `ZVENA_ANDROID_CERT_SHA256` on the web server, so
App Links verify. Check with `adb shell pm get-app-links app.zvena.mobile`.

Push: add Firebase's `android/app/google-services.json` (git-ignored); the
Gradle file applies the Google Services plugin only when it exists. Until
then the web app must not call `PushNotifications.register()` on Android
(Firebase is not initialised and the call fails).

Data safety: the app sets `allowBackup="false"` and excludes everything from
cloud backups and device transfers, because the WebView's storage holds the
session cookie.

## iOS (on a Mac)

Needs Xcode 16+ (Swift Package Manager; no CocoaPods).

1. `npm ci && npm run sync:ios`, then open `ios/App/App.xcodeproj`.
   Xcode resolves the packages (`CapApp-SPM` points into `node_modules`).
2. Signing & Capabilities, for **both** targets `App` (`app.zvena.mobile`)
   and `ShareExtension` (`app.zvena.mobile.share`): pick the team.
   Capabilities already in the entitlements files:
   - App: Push Notifications, Associated Domains (`applinks:zvena.app`),
     App Groups (`group.app.zvena.mobile`).
   - ShareExtension: App Groups (`group.app.zvena.mobile`).
   Register the App Group in the developer account if Xcode does not offer
   to.
3. Put `TEAMID.app.zvena.mobile` into `ZVENA_IOS_APP_ID` on the web server
   (universal links). Apple's CDN fetches the file; check with
   `https://app-site-association.cdn-apple.com/a/v1/zvena.app`.
4. Run on a device; Product → Archive → Distribute App → App Store Connect.

The share extension (`ios/App/ShareExtension/`) stores the item in the App
Group and opens the app at `zvena://clip?…`; the app loads the Save to zvena
page. Extensions get no `UIApplication`, so it reaches the host app through
the responder chain, which needs `APPLICATION_EXTENSION_API_ONLY = NO` on that
target (set). If iOS ever refuses that, the item is still saved in the App
Group and the app opens Save to zvena the next time it comes to the front
(within ten minutes). If the project ever needs re-creating by hand:
File → New → Target → Share Extension named `ShareExtension`, delete its
generated files, add the files in `ios/App/ShareExtension/` to it, set
`INFOPLIST_FILE = ShareExtension/Info.plist`,
`CODE_SIGN_ENTITLEMENTS = ShareExtension/ShareExtension.entitlements`,
bundle id `app.zvena.mobile.share`, and add `App/Links.swift` +
`App/App.entitlements` to the App target.

Push: the Push Notifications capability is on (`aps-environment`). Upload an
APNs key in the Apple developer account when a sender exists.

## Push notifications (plumbing only)

`@capacitor/push-notifications` is installed and the native callbacks are
wired (AppDelegate on iOS, Firebase messaging service on Android). zvena has
**no push sender yet**. Because Capacitor injects its bridge into the remote
page, the web app can register when it runs inside the app:

```js
const push = window.Capacitor?.Plugins?.PushNotifications;
if (push) {
  const { receive } = await push.requestPermissions();
  if (receive === "granted") {
    push.addListener("registration", ({ value: token }) => fetch("/api/…/devices", { method: "POST", body: JSON.stringify({ token }) }));
    await push.register();
  }
}
```

The server side (storing device tokens per account, sending through APNs and
FCM from Inbox events) is still to be built.

## Store submission notes

- Bundle ids: `app.zvena.mobile` (app), `app.zvena.mobile.share` (extension);
  Android package `app.zvena.mobile`.
- Apple's guideline 4.2 (minimum functionality) rejects bare website
  wrappers: the submission notes should point at what is native (share
  extension, universal links, push) and the offline behaviour of the web app
  (its service worker keeps recently opened Docs pages).
- `ITSAppUsesNonExemptEncryption = false` (only HTTPS).
- Privacy: no tracking and no third-party SDKs except Firebase Messaging on
  Android once push is enabled; declare it in Play's Data safety form then.
- Account deletion: the web app's Settings has it (both stores require it in
  apps with sign-up).
