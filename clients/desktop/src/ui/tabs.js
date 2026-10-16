// The tab strip: draws the window's tabs from the main process's state and
// sends back what the person does (window.zvUi from preload/ui.js).

"use strict";

const $ = (id) => document.getElementById(id);
const strip = document.body;
const list = $("tabs");
let dragId = null;

const X_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>';

function render(state) {
  document.documentElement.dir = state.rtl ? "rtl" : "ltr";
  strip.classList.toggle("mac", state.platform === "darwin");
  strip.classList.toggle("full", Boolean(state.fullScreen));
  strip.classList.toggle("overlay", state.platform !== "darwin");
  $("menu").hidden = state.platform === "darwin";
  $("menu").title = state.words.menu;
  $("back").disabled = !state.canBack;
  $("forward").disabled = !state.canForward;
  $("back").title = state.words.back;
  $("forward").title = state.words.forward;
  $("new").title = state.words.newTab;
  list.replaceChildren(
    ...state.tabs.map((tab, index) => {
      const el = document.createElement("div");
      el.className = `tab${tab.active ? " active" : ""}`;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab.active));
      el.draggable = true;
      el.title = tab.title;
      if (tab.loading) {
        const s = document.createElement("span");
        s.className = "spin";
        el.append(s);
      }
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = tab.title;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "icon x";
      x.title = state.words.closeTab;
      x.innerHTML = X_ICON;
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        window.zvUi.send("close", { id: tab.id });
      });
      el.append(title, x);
      el.addEventListener("mousedown", (e) => e.button === 0 && window.zvUi.send("select", { id: tab.id }));
      // A middle click closes a tab, as in browsers.
      el.addEventListener("auxclick", (e) => e.button === 1 && window.zvUi.send("close", { id: tab.id }));
      el.addEventListener("dragstart", (e) => {
        dragId = tab.id;
        el.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => ((dragId = null), el.classList.remove("dragging")));
      el.addEventListener("dragover", (e) => dragId !== null && e.preventDefault());
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragId !== null && dragId !== tab.id) window.zvUi.send("move", { id: dragId, to: index });
      });
      return el;
    })
  );
}

$("back").addEventListener("click", () => window.zvUi.send("back"));
$("forward").addEventListener("click", () => window.zvUi.send("forward"));
$("new").addEventListener("click", () => window.zvUi.send("newTab"));
$("menu").addEventListener("click", () => window.zvUi.send("menu"));

window.zvUi.onState(render);
