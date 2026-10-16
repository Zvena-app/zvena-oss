// Main process: the application menu, the right-click menu of pages
// (spelling suggestions first, as in a browser), the tray (Windows, Linux)
// and the dock menu (macOS).

"use strict";

const path = require("node:path");
const { app, clipboard, Menu, Tray, nativeImage } = require("electron");
const { isExternalOpenable } = require("./links");

const MAC = process.platform === "darwin";

/**
 * `ctx`: t, run(action) (on the focused window), newWindow(), quickSearch(),
 * settings(), help(), updates (null when updates are off), devTools.
 */
function appMenu(ctx) {
  const { t } = ctx;
  const run = (type, extra) => () => ctx.run({ type, ...extra });
  const tabs = Array.from({ length: 9 }, (_, i) => ({ label: `${t("window")} ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, visible: false, click: run("selectTab", { index: i + 1 }) }));
  const template = [
    ...(MAC
      ? [
          {
            label: "zvena",
            submenu: [
              { label: t("about"), role: "about" },
              ...(ctx.updates ? [{ label: t("checkUpdates"), click: () => ctx.updates() }] : []),
              { type: "separator" },
              { label: t("settings"), accelerator: "Cmd+,", click: () => ctx.settings() },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { label: t("hide"), role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { label: t("quit"), role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: t("file"),
      submenu: [
        { label: t("newTab"), accelerator: "CmdOrCtrl+T", click: run("newTab") },
        { label: t("newWindow"), accelerator: "CmdOrCtrl+N", click: () => ctx.newWindow() },
        { label: t("reopenTab"), accelerator: "CmdOrCtrl+Shift+T", click: run("reopenTab") },
        { label: t("quickSearch"), click: () => ctx.quickSearch() },
        { type: "separator" },
        { label: t("closeTab"), accelerator: "CmdOrCtrl+W", click: run("closeTab") },
        ...(MAC ? [] : [{ type: "separator" }, { label: t("settings"), click: () => ctx.settings() }, ...(ctx.updates ? [{ label: t("checkUpdates"), click: () => ctx.updates() }] : []), { type: "separator" }, { label: t("quit"), role: "quit" }]),
      ],
    },
    {
      label: t("edit"),
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { label: t("cut"), role: "cut" }, { label: t("copy"), role: "copy" }, { label: t("paste"), role: "paste" }, { label: t("pastePlain"), role: "pasteAndMatchStyle" }, { label: t("selectAll"), role: "selectAll" }],
    },
    {
      label: t("view"),
      submenu: [
        { label: t("reload"), accelerator: "CmdOrCtrl+R", click: run("reload") },
        { type: "separator" },
        { label: t("zoomIn"), accelerator: "CmdOrCtrl+=", click: run("zoom", { delta: 1 }) },
        { label: t("zoomOut"), accelerator: "CmdOrCtrl+-", click: run("zoom", { delta: -1 }) },
        { label: t("zoomReset"), accelerator: "CmdOrCtrl+0", click: run("zoom", { delta: 0 }) },
        { type: "separator" },
        { label: t("fullScreen"), role: "togglefullscreen" },
        ...(ctx.devTools ? [{ type: "separator" }, { label: t("devTools"), accelerator: MAC ? "Alt+Cmd+I" : "Ctrl+Shift+I", click: run("devTools") }] : []),
      ],
    },
    {
      label: t("history"),
      submenu: [
        { label: t("back"), accelerator: "CmdOrCtrl+[", click: run("back") },
        { label: t("forward"), accelerator: "CmdOrCtrl+]", click: run("forward") },
      ],
    },
    {
      label: t("window"),
      submenu: [
        { role: "minimize" },
        ...(MAC ? [{ role: "zoom" }] : []),
        { type: "separator" },
        { label: t("nextTab"), accelerator: MAC ? "Cmd+Shift+]" : "Ctrl+Tab", click: run("nextTab") },
        { label: t("prevTab"), accelerator: MAC ? "Cmd+Shift+[" : "Ctrl+Shift+Tab", click: run("prevTab") },
        ...tabs,
        ...(MAC ? [{ type: "separator" }, { role: "front" }] : []),
      ],
    },
    { label: t("help"), role: "help", submenu: [{ label: t("helpCenter"), click: () => ctx.help() }] },
  ];
  return Menu.buildFromTemplate(template);
}

/** The right-click menu of a page: spelling, editing, links, images. */
function contextMenu(ctx, win, wc, params) {
  const { t } = ctx;
  const items = [];
  if (params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).slice(0, 6);
    for (const s of suggestions) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!suggestions.length) items.push({ label: t("noSuggestions"), enabled: false });
    items.push({ label: t("addToDictionary"), click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    items.push({ type: "separator" });
  }
  if (params.linkURL && isExternalOpenable(params.linkURL)) {
    items.push({ label: t("copyLink"), click: () => clipboard.writeText(params.linkURL) });
    items.push({ label: t("openInBrowser"), click: () => ctx.openExternal(params.linkURL) });
    items.push({ type: "separator" });
  }
  if (params.mediaType === "image" && params.srcURL) items.push({ label: t("copyImage"), click: () => wc.copyImageAt(params.x, params.y) }, { type: "separator" });
  const f = params.editFlags || {};
  if (params.isEditable) {
    items.push({ label: t("cut"), role: "cut", enabled: f.canCut }, { label: t("copy"), role: "copy", enabled: f.canCopy }, { label: t("paste"), role: "paste", enabled: f.canPaste }, { label: t("pastePlain"), role: "pasteAndMatchStyle", enabled: f.canPaste }, { label: t("selectAll"), role: "selectAll" });
  } else if (params.selectionText) {
    items.push({ label: t("copy"), role: "copy" });
  }
  const word = (params.selectionText || "").trim();
  if (MAC && word && word.length < 60) items.push({ type: "separator" }, { label: t("lookUp", { word: word.length > 24 ? `${word.slice(0, 24)}…` : word }), click: () => wc.showDefinitionForSelection() });
  if (ctx.devTools) items.push({ type: "separator" }, { label: t("inspect"), click: () => wc.inspectElement(params.x, params.y) });
  while (items.length && items[items.length - 1].type === "separator") items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win.win });
}

const ICON = path.join(__dirname, "..", "assets", "tray.png");

/** The tray icon (Windows, Linux) or the dock menu (macOS). */
function trayOrDock(ctx) {
  const { t } = ctx;
  const items = [
    { label: t("newWindow"), click: () => ctx.newWindow() },
    { label: t("quickSearch"), click: () => ctx.quickSearch() },
  ];
  if (MAC) {
    app.dock?.setMenu(Menu.buildFromTemplate(items));
    return null;
  }
  const tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip("zvena");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: t("open"), click: () => ctx.show() }, ...items, { type: "separator" }, { label: t("settings"), click: () => ctx.settings() }, { label: t("quit"), click: () => app.quit() }]));
  tray.on("click", () => ctx.show());
  return tray;
}

module.exports = { appMenu, contextMenu, trayOrDock };
