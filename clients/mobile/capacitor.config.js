// Capacitor shell around the zvena web app. The app is the website itself
// (server.url), so features ship without a store review; www/ holds only
// the local pages shown before the site loads or when it cannot.
//
// APP_URL is read when `npx cap sync` runs (default https://zvena.app) and
// is baked into the native projects; a self-hosted or test server needs its
// own build. Plain http is for a local dev server only.

"use strict";

const { version } = require("./package.json");

const APP_URL = process.env.APP_URL || "https://zvena.app";
const app = new URL(APP_URL);
if (app.protocol !== "https:" && !/^(localhost|127\.0\.0\.1|10\.0\.2\.2)$/.test(app.hostname)) {
  throw new Error(`APP_URL must be https (got ${APP_URL})`);
}

/** @type {import('@capacitor/cli').CapacitorConfig} */
module.exports = {
  appId: "app.zvena.mobile",
  appName: "zvena",
  webDir: "www",
  appendUserAgent: `zvena-mobile/${version}`,
  backgroundColor: "#ffffff",
  loggingBehavior: "none",
  server: {
    url: app.origin,
    // Only the app's own host stays inside the app; other links open in the browser.
    allowNavigation: [app.host],
    androidScheme: "https",
    cleartext: app.protocol === "http:",
    errorPath: "error.html",
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: "never",
    // WKAppBoundDomains in Info.plist lists the same host.
    limitsNavigationsToAppBoundDomains: true,
    allowsLinkPreview: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SystemBars: {
      // The web app lays out with viewport-fit=cover and env(safe-area-inset-*).
      insetsHandling: "css",
      initialViewportFitValueHint: "cover",
    },
    StatusBar: {
      overlaysWebView: true,
    },
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#000000",
      showSpinner: false,
      androidScaleType: "CENTER_INSIDE",
      splashFullScreen: false,
      splashImmersive: false,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};
