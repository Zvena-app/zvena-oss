// electron-builder: macOS dmg, Windows nsis, Linux AppImage and deb.
//
// Signing comes from the environment of the machine that builds (see
// README.md): CSC_LINK / CSC_KEY_PASSWORD for macOS and Windows certificates,
// APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID for notarization.
// Updates: with ZVENA_UPDATE_URL set at build time the feed is baked into
// the app (app-update.yml); without it the app is built with updates off.

"use strict";

const updateUrl = /^https:\/\//.test(process.env.ZVENA_UPDATE_URL || "") ? process.env.ZVENA_UPDATE_URL : null;

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "app.zvena.desktop",
  productName: "zvena",
  executableName: "zvena",
  copyright: "© zvena",
  artifactName: "zvena-${version}-${os}-${arch}.${ext}",
  directories: { output: "dist", buildResources: "build" },
  files: ["src/**/*", "assets/**/*", "package.json", "!**/*.map", "!test/**", "!scripts/**"],
  asar: true,
  protocols: [{ name: "zvena", schemes: ["zvena"] }],
  publish: updateUrl ? [{ provider: "generic", url: updateUrl }] : null,
  // Electron's fuses: no running as plain Node, no inspector or NODE_OPTIONS,
  // the app only from its own (integrity-checked) asar, cookies encrypted at rest.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    target: [{ target: "dmg", arch: ["universal"] }],
    category: "public.app-category.productivity",
    icon: "build/icon.png",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    // Notarized when the Apple credentials are in the environment.
    notarize: Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD),
  },
  dmg: { title: "zvena ${version}" },
  win: {
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    icon: "build/icon.png",
    // Authenticode: CSC_LINK / CSC_KEY_PASSWORD (or WIN_CSC_LINK) of the Windows certificate; signtoolOptions.publisherName when the certificate needs it.
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    shortcutName: "zvena",
  },
  linux: {
    target: ["AppImage", "deb"],
    category: "Office",
    icon: "build/icons",
    synopsis: "Docs, projects and design in one window",
    description: "zvena for desktop: docs, projects and design in one window.",
    // x-scheme-handler/zvena comes from "protocols" above.
    // The window's app id / WM_CLASS matches zvena.desktop, so the dock groups it with the launcher.
    syncDesktopName: true,
    maintainer: "zvena <hello@zvena.app>",
    vendor: "zvena",
    desktop: { entry: { StartupWMClass: "zvena", Keywords: "docs;notes;projects;design;" } },
  },
  deb: { packageCategory: "office" },
};
