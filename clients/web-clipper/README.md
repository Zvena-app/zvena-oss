# zvena Web Clipper

A browser extension that saves web pages to zvena Docs, like Notion's Web Clipper.
Manifest V3. One code base builds three packages: Chrome and Edge share one, and Firefox has its own.

## What it does

- **Popup.** It has these parts:
  - **Title:** the page's title, which you can edit.
  - **Add to:** a workspace picker and a search box for pages and databases you can edit. It also lists your last five destinations. Databases are marked: a clip saved to a database becomes a new row with its URL property set. **Private** (a new top-level page in your Private section) is the default.
  - **Save as:** **Full page** (the readable content, from Mozilla Readability), **Bookmark**, or **Selection** (only what is selected; this option is off when nothing is selected).
  - **Save**, then **Open in zvena**.
- **Right-click menu.** "Save to zvena" appears on pages, selections, links and images:
  - A link is saved as a bookmark.
  - An image is saved as a page that holds the image.
  - A selection is saved in selection mode.

  The menu opens the popup so you can pick the destination. Where a browser cannot open the popup, the clip goes straight to the last destination, and the toolbar badge shows the result.
- **Keyboard shortcuts.** You can change them in `chrome://extensions/shortcuts` or in Firefox's add-on manager.
  - **Alt+Shift+Z** opens the popup.
  - **Alt+Shift+S** saves the page to the last destination without opening the popup.
- **Languages.** English (the default) plus zh_CN, hi, es, ar (right to left), fr, bn, pt_BR, pt_PT, ru and id. All strings are in `src/_locales`.
- **Look.** The popup follows zvena's design system: the tokens of `web/src/app/ui-theme.css`, the "Zvena Sans" (Inter) font, and light and dark themes. The brand files are the owner's, from `clients/brand/`: the `zvena.` wordmark, and icons rasterized from `favicon.svg` by `scripts/icons.mjs`.

## Permissions, and why

| Permission | Why |
| --- | --- |
| `activeTab` | Reads the tab you clip, and only when you click the button, the menu or the shortcut. The extension has no standing access to any website. |
| `scripting` | Runs the page reader (`extract.js`) in that tab, once per clip. |
| `contextMenus` | Adds the "Save to zvena" menu item. |
| `storage` | Keeps the clipper token, the server address and recent destinations, all on this device. |
| `host_permissions: https://zvena.app/*` | Calls the zvena API, and runs the content script of the Connect page. |
| `optional_host_permissions` | Used only when you point the clipper at a self-hosted server in Settings. The extension then asks for that one origin, at that moment. |

The extension does not request `tabs`, `cookies`, `<all_urls>` or `webRequest`. It loads no remote code and uses no `eval`. The extension pages run under `script-src 'self'`.

## Sign-in: a scoped clipper token, not the site's cookie

The clipper never uses the zvena session cookie. You connect it once, and it gets a token that can do only two things: list destinations and create clips.

Here is how Connect works:

1. The extension creates a random `state` and a PKCE `verifier`. It keeps both in `storage.session` (memory only).
2. It opens `/clipper/connect?state=…&challenge=S256(verifier)&client=chrome|edge|firefox` on the server.
3. You press **Allow** on that page while signed in to zvena. The server then redirects to `/clipper/connected#code=…&state=…`.
4. A content script that runs only on that page reads the code from the URL fragment. It clears the fragment at once and passes the code to the background.
5. The background checks the `state` and confirms that the message came from the top frame of the server's origin. It then sends `POST /api/clipper/token {code, verifier}` and gets the token back.
6. From then on, every API call carries `Authorization: Bearer <token>` with `credentials: "omit"`.

**Disconnect** in Settings sends `DELETE /api/clipper/token`. You can also revoke the token in zvena's Settings.

Why a token instead of the cookie:

- **Least privilege.** The token cannot read your documents, and it cannot change or delete anything. A leaked token, or a bug in the extension, can only add pages.
- **No relaxed CSRF rules.** If the clipper used the cookie, the server would have to accept cookie-authenticated writes from extension origins. Firefox's `moz-extension://` origins are random for each install, so the server would effectively have to accept any extension origin. With a token, cookie requests stay same-origin only. A web page cannot get the token: it lives in extension storage and is sent only by the background.
- **Revocable per device.** The server stores only a hash of the token.
- **Works under cookie partitioning.** Firefox Total Cookie Protection, Safari and third-party-cookie phase-outs all leave it working. It also keeps working after you sign out of the website, as Notion's clipper does.
- **The code is useless alone.** PKCE binds it to a verifier that never leaves the extension until the exchange.

## Build

```sh
npm ci
npm test                 # unit tests (node --test)
npm run build            # dist/chrome, dist/firefox, and the three zips below
```

- `dist/zvena-web-clipper-chrome-<version>.zip`: upload to the Chrome Web Store and to Edge Add-ons.
- `dist/zvena-web-clipper-firefox-<version>.zip`: upload to AMO.
- `dist/zvena-web-clipper-source-<version>.zip`: the source package that AMO asks for, because the code is bundled.

The zips are written by `scripts/zip.mjs`, a small deterministic ZIP writer, so no `zip` tool is needed. The same tree always gives the same bytes.

To build for another server, such as a test stand or a self-hosted instance (unpacked only, never for a store):

```sh
node build.mjs --server http://127.0.0.1:3955 --out dist/chrome-test [--browser firefox]
```

This bakes the origin into `host_permissions`, into the Connect content script's match, and into the default server.

The icons in `src/icons` are generated from `clients/brand/favicon.svg`. Run `node scripts/icons.mjs` only when the brand file changes. It needs `sharp`: by default the web app's copy, or the path set in `SHARP=…`.

Pinned dependencies (dev only, bundled at build time):

- `@mozilla/readability` 0.6.0 (Apache-2.0; its license ships in `licenses/`)
- `esbuild` 0.28.2

Inter (OFL) also ships with its license.

## Browser checks

Both scripts run in the Playwright image on the server:

```sh
docker run --rm --name zvcli-ext-$$ --network host -v $PWD:/clipper:ro \
  -e PLAYWRIGHT_CORE=/opt/penpot/exporter/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core \
  -e CHROMIUM=/opt/penpot/browsers/chromium-1234/chrome-linux64/chrome \
  --entrypoint node penpotapp/exporter:2.18.3 /clipper/test/load-check.mjs /clipper/dist/chrome
```

- `test/load-check.mjs` checks the store build: it loads, the popup shows Connect, and the page reader returns clean HTML with absolute URLs.
- `test/flow-check.mjs` runs the whole flow against a stand-in server that follows the contract: Connect, the destination picker, an article clip, a selection clip, recent destinations, revocation, and Disconnect. Build it first with `node build.mjs --server http://127.0.0.1:39571 --out dist/chrome-mock`.

### Hooks for end-to-end tests

- `popup.html?tab=<tabId>` makes the popup act on that tab. Without it, a popup opened as a normal page would clip itself.

  Opening the popup as a page grants no `activeTab`, so the target tab must be on an origin the build has host access to. For the test build, that means a page served from the test server's origin. You can find the tab id from the service worker: `(await chrome.tabs.query({})).find(t => t.url?.endsWith(path)).id`.
- Stable selectors:

  | Selector | What it is |
  | --- | --- |
  | `[data-test=connect]` | The Connect button |
  | `[data-test=connect-screen]` | The Connect screen |
  | `[data-test=clip-screen]` | The clip screen |
  | `[data-test=done-screen]` | The success screen |
  | `[data-test=title]` | The title input |
  | `[data-test=workspace]` | The workspace picker (shown with 2 or more workspaces) |
  | `[data-test=search]` | The search box |
  | `[data-test=dest][data-id=<id or "private">][data-kind=page\|database\|private]` | A destination row (`aria-selected="true"` when chosen) |
  | `[data-test=mode][data-mode=article\|bookmark\|selection]` | The Save as radios |
  | `[data-test=save]` | The Save button |
  | `[data-test=open]` | The "Open in zvena" link (its `href` is the new page) |
  | `[data-test=error]` | The error box |
  | `[data-test=settings]` | The Settings button |
  | `[data-test=server]` | The server input |
  | `[data-test=server-save]` | The button that saves the server |
  | `[data-test=disconnect]` | The Disconnect button |
- On `/clipper/connected`, the content script sets `data-zv-clipper="connected"` (or an error name) on `<html>` once the code is exchanged.

## Store submission

**Chrome Web Store**

1. In the Developer Dashboard, add a new item and upload the chrome zip.
2. Fill in the listing: the name and summary come from `_locales`, in every language. Add screenshots (1280×800) and the 128 px icon from `src/icons`.
3. Privacy tab:
   - Single purpose: "Save web pages to the user's zvena workspace."
   - Permission justifications: use the table above.
   - Data usage: website content, sent only when the user saves a clip. It is not sold, not used for ads, and not used for unrelated purposes.
   - Privacy policy URL: your server's privacy policy (`ZVENA_PRIVACY_URL`).
4. The store assigns the item ID. Give it to the server (see "Server side" below).

**Edge Add-ons (Partner Center)**

Upload the same chrome zip. Use the same listing and privacy answers.

**Firefox (AMO)**

1. Upload the firefox zip.
2. When asked about source code, upload `zvena-web-clipper-source-<version>.zip`. Build instructions for the reviewer: Node 22 or later, `cd clients/web-clipper && npm ci && npm run build`. The output is `dist/firefox/`.
3. The manifest declares `data_collection_permissions: { required: ["websiteContent"] }`, which AMO requires. The add-on ID is `web-clipper@zvena.app`. The minimum version is Firefox 140 on desktop and 142 on Android.

To release an update, bump `version` in `package.json`, rebuild, and upload to each store.

### Server side

The server's Connect page and token endpoint decide which clients may connect. Before you publish, set the store IDs in the server's environment:

- the Chrome Web Store ID;
- the Edge Add-ons ID;
- the Firefox add-on ID, `web-clipper@zvena.app`.

The variable names are in the web app's deploy notes.

## Privacy

- Nothing leaves the browser until you press Save, choose the menu item, or use the save shortcut.
- A clip sends the following to your own zvena server, and to no one else:
  - the page's address and title;
  - the readable content (or the selection);
  - its cover image URL, site name and icon URL.
- No analytics, no tracking, no third-party requests.
- The token, the server address and recent destinations stay in this browser's extension storage. Disconnect removes them, and revokes the token on the server.
