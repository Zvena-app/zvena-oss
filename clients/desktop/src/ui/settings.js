// Settings: the form of the main process's settings (zv:settings-get /
// zv:settings-save, checked again there).

"use strict";

const FIELDS = ["serverUrl", "designUrl", "quickSearchShortcut"];
const CHECKS = ["launchAtLogin", "openLinksInApp"];
const $ = (id) => document.getElementById(id);

async function start() {
  const view = await window.zvUi.settings.load();
  if (!view) return;
  document.documentElement.dir = view.rtl ? "rtl" : "ltr";
  document.title = view.words.settingsTitle;
  $("title").textContent = view.words.settingsTitle;
  for (const el of document.querySelectorAll("[data-w]")) el.textContent = view.words[el.dataset.w] ?? "";
  for (const k of FIELDS) $(k).value = view.values[k] ?? "";
  for (const k of CHECKS) $(k).checked = Boolean(view.values[k]);
  $("serverUrl").placeholder = view.envServer || view.exampleServer;
  // APP_URL (the environment) decides the server while it is set.
  if (view.envServer) $("serverUrl").disabled = true;
  // The first start: no server yet, so its address comes first (Save says so if it is left empty).
  if (view.needsServer) {
    $("serverUrl").required = true;
    $("serverUrl").focus();
  }
  if (!view.shortcutOk) $("quickSearchShortcut-err").textContent = view.words.shortcutTaken;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = Object.fromEntries([...FIELDS.map((k) => [k, $(k).value]), ...CHECKS.map((k) => [k, $(k).checked])]);
  const r = await window.zvUi.settings.save(values);
  for (const k of FIELDS) $(`${k}-err`).textContent = r?.errors?.[k] ?? "";
  if (r?.ok) window.zvUi.settings.close();
});
$("cancel").addEventListener("click", () => window.zvUi.settings.close());

void start();
