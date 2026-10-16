// The tab's page when the server could not be reached on the first load
// (later loads are kept offline by the web app's service worker). The words
// come in the query, set as text only.

"use strict";

const q = new URLSearchParams(location.search);
document.documentElement.dir = q.get("dir") === "rtl" ? "rtl" : "ltr";
document.getElementById("message").textContent = q.get("m") || "";
const retry = document.getElementById("retry");
retry.textContent = q.get("r") || "Try again";
retry.addEventListener("click", () => window.zvUi?.send("retry"));
// Back online: try on its own.
window.addEventListener("online", () => window.zvUi?.send("retry"));
