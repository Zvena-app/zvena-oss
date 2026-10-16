// manifest.json for each browser, from one description. Host access is the
// zvena server only; any other site is reached through activeTab (the
// person's click on the button, menu or shortcut) and only for that tab.
// The default build names no server: the person enters theirs in Settings
// and the extension asks for that one origin then (optional_host_permissions).

import { originPattern } from "./urls.js";

/** No built-in server: "" (a build for one server passes its origin). */
export const DEFAULT_SERVER = "";
export const BROWSERS = ["chrome", "firefox"];

/** `server`: an origin baked in as the default (a build for one server, such as a test stand); none by default. */
export function makeManifest({ browser, version, server = DEFAULT_SERVER }) {
  if (!BROWSERS.includes(browser)) throw new Error(`unknown browser ${browser}`);
  const host = server ? originPattern(server) : "";
  const m = {
    manifest_version: 3,
    name: "__MSG_extName__",
    short_name: "zvena",
    description: "__MSG_extDescription__",
    version,
    default_locale: "en",
    homepage_url: "https://github.com/Zvena-app/zvena-oss",
    icons: { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" },
    action: {
      default_title: "__MSG_actionTitle__",
      default_popup: "popup.html",
      default_icon: { 16: "icons/16.png", 32: "icons/32.png" },
    },
    permissions: ["activeTab", "contextMenus", "scripting", "storage"],
    // The person's zvena server: asked for at runtime, for that one origin, when they set it.
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    commands: {
      _execute_action: { suggested_key: { default: "Alt+Shift+Z" }, description: "__MSG_cmdOpen__" },
      "save-page": { suggested_key: { default: "Alt+Shift+S" }, description: "__MSG_cmdSavePage__" },
    },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
  // A build for one server declares its access and the Connect page's script up front;
  // otherwise the background registers that script for the server the person set.
  if (host) {
    m.host_permissions = [host];
    m.content_scripts = [{ matches: [`${host.slice(0, -1)}clipper/connected*`], js: ["connect.js"], run_at: "document_start" }];
  }
  if (browser === "chrome") {
    m.background = { service_worker: "background.js" };
    m.minimum_chrome_version = "116";
  } else {
    // Firefox runs MV3 backgrounds as event pages, not service workers.
    m.background = { scripts: ["background.js"] };
    m.browser_specific_settings = {
      gecko: {
        id: "web-clipper@zvena-oss",
        strict_min_version: "140.0",
        // AMO's data disclosure: a clip sends the page's content (and address) to the
        // person's zvena server when they press Save — nothing else, never in the background.
        data_collection_permissions: { required: ["websiteContent"] },
      },
      gecko_android: { strict_min_version: "142.0" },
    };
  }
  return m;
}
