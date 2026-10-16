# zvena for desktop

An Electron app around the zvena web app, like Notion's desktop app. All of
the product lives on the server; the app adds what a browser tab cannot do.

- **Server:** `APP_URL` from the environment, else the address in Settings.
  There is no built-in server: on the first start, without `APP_URL`, the
  app opens Settings and asks for your server's address (for example
  `https://zvena.example.com`) before any window opens; closing Settings
  without one quits. A window then opens on `/home`. Plain `http://` is
  accepted only for `localhost` / `127.0.0.1` (a dev server or a test stand).
- **Tabs:** ⌘/Ctrl+T new tab, ⌘W close (the last tab closes the window),
  ⌘1–8 a tab by position, ⌘9 the last one, ⌘⇧T reopen a closed tab (with its
  back/forward history), Ctrl+Tab / ⌘⇧] next tab and Ctrl+Shift+Tab / ⌘⇧[
  the previous one, ⌘[ / ⌘] back and forward (Alt+←/→ on Windows and Linux
  too), ⌘R reload, ⌘= / ⌘- / ⌘0 zoom. Drag tabs to reorder them; a middle
  click closes one. Links the app opens in a new window (`target=_blank`)
  become tabs when "Open zvena links in new tabs here" is on.
- **`zvena://` links:** `zvena://docs?ws=…#Page-<id>` opens
  `<server>/docs?ws=…#Page-<id>`; `zvena://open?url=<URL>` opens that URL if
  it is on the server's origin. Anything else is ignored. A tab already
  showing the page comes to the front instead of a new one. One app runs at a
  time: a second launch hands its link over and quits.
- **Notifications:** the web app's notifications (Inbox) show as the
  system's. A click brings the window and the tab to the front.
  `window.zvenaDesktop.setBadge(n)` sets the dock / taskbar count.
- **Quick search:** Alt+Shift+Space (⌥⇧Space) from any app opens a small
  window with Docs' search (`/docs#search`). The page you pick opens in a tab
  of the main window. Esc or a click elsewhere hides the window. Change the
  shortcut in Settings. If another app holds it, Settings says so.
- **Memory and comfort:** windows reopen with their size, place and tabs.
  Spell check runs, with suggestions in the right-click menu. There is a tray
  icon (Windows, Linux) or a dock menu (macOS) with New window and Quick
  search. Launch at login is optional: login items on macOS and Windows, an
  autostart entry on Linux. The app then starts without a window. Downloads
  open a save dialog in the Downloads folder.
- **Offline:** pages you opened recently keep working through the web app's
  service worker and local store. If the very first load fails, the tab shows
  "Can't reach zvena" with a Try again button.
- **Languages:** the menus, tab strip, tray and Settings come in the ten
  interface languages (en, zh, hi, es, ar with right-to-left, fr, bn, pt,
  ru, id), picked from the system's language. Pages use the language chosen
  in zvena.

How the web app tells it apart: the user agent ends with
`zvena-desktop/<version>` (the `Electron/` token is removed), and pages of
the server's origin get a frozen `window.zvenaDesktop = { isDesktop, version,
platform, setBadge }`.

## Security model

- Every page runs with `contextIsolation`, `sandbox`, no `nodeIntegration`,
  `webSecurity` on, no `<webview>`, and `app.enableSandbox()` for all
  renderers. Preloads expose only the frozen object above, and nothing at
  all to other origins.
- Navigation: a tab stays on the server's origin, the Design origin
  (`DESIGN_URL` or Settings) and https subdomains of the server's domain
  (design.example.com next to example.com). Every other http(s)/mailto link opens
  in the system browser. Other schemes (file:, javascript:, data:, custom)
  go nowhere. New windows are never created: an app link becomes a tab,
  anything else goes to the browser.
- Permissions: only `notifications`, `clipboard-sanitized-write` and
  `fullscreen`, and only for the server's origin. Camera, microphone,
  location, HID/USB/serial and everything else are refused. Certificate
  errors are never accepted.
- The app's own pages (tab strip, Settings, offline) are files under
  `zvena-ui://ui/` with `default-src 'none'; script-src 'self'; …`. Each IPC
  message is checked against its sender (the window's own strip, the
  Settings window, a tab of the server's origin).
- Electron fuses (set at package time): no `ELECTRON_RUN_AS_NODE`, no
  `NODE_OPTIONS` / `--inspect`, the app only from its integrity-checked asar,
  cookies encrypted at rest.
- Developer tools: available in a dev run (`npm start`). In packaged builds
  they appear only with `ZVENA_DEVTOOLS=1` in the environment (the menu item
  and "Inspect"), as Notion keeps them out of the way. A packaged app started
  with `--remote-debugging-port` / `--remote-debugging-pipe` quits unless
  `ZVENA_DEVTOOLS=1` is set (the smoke test sets it).

## Develop

```sh
npm install                                  # Electron 44.5.0, electron-builder 26.15.3, electron-updater 6.8.9
APP_URL=http://127.0.0.1:3955 npm start      # against a local stand
npm test                                     # node --test: links, shortcuts, settings, languages
npm run icons                                # build/ and assets/ icons from ../brand (needs sharp; uses ../../web/node_modules)
```

The icons are made from zvena's logo files in `clients/brand/` (the
white mark on a black square). Never use another mark.

## Build

The packages go to `dist/`.

```sh
# Linux (here): AppImage, and deb if binutils' `ar` is installed (fpm needs it)
npx electron-builder --config electron-builder.config.js --linux AppImage deb

# macOS (on a Mac): universal dmg, signed and notarized
export CSC_LINK=/path/to/DeveloperID_Application.p12   # or a base64 of it
export CSC_KEY_PASSWORD=…
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=ABCDE12345
npx electron-builder --config electron-builder.config.js --mac dmg

# Windows (on Windows, or with a signing service): nsis installer, x64 + arm64
set CSC_LINK=C:\path\to\codesign.pfx        & rem or WIN_CSC_LINK
set CSC_KEY_PASSWORD=…
npx electron-builder --config electron-builder.config.js --win nsis
```

Without `CSC_LINK` the macOS build is unsigned: Gatekeeper blocks it, and it
is not notarized (notarization runs only when all three `APPLE_*` variables
are set). Without a Windows certificate, SmartScreen warns on first run. For
an EV certificate or Azure Trusted Signing, add `win.signtoolOptions` or
`win.azureSignOptions` to `electron-builder.config.js`.

## Updates

electron-updater from a generic feed (a folder with `latest*.yml` and the
packages, as electron-builder writes them to `dist/`):

- `ZVENA_UPDATE_URL=https://downloads.example.com/desktop/` **at build time**
  bakes the feed into the app (`app-update.yml`);
- or the same variable **at run time** points an installed app at a feed.

With neither, and in any unpackaged run, updates are off and the menu does
not offer them. Updates download in the background and install when the app
quits. On macOS only signed builds can update. On Linux only the AppImage
updates (deb comes from the package manager).
