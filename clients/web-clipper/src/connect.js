// Runs on the zvena server's /clipper/connected page only: hands the
// one-time code in the address's #fragment to the background, which
// exchanges it with the verifier it kept. The fragment is wiped at once so
// the code stays out of the history and the page's own scripts.

const ext = globalThis.browser ?? globalThis.chrome;
const params = new URLSearchParams(location.hash.slice(1));
const code = params.get("code");
const state = params.get("state");
if (code && state) {
  history.replaceState(null, "", location.pathname);
  ext.runtime.sendMessage({ type: "zv-connect", code, state }).then(
    (res) => document.documentElement.setAttribute("data-zv-clipper", res?.ok ? "connected" : res?.error || "failed"),
    () => document.documentElement.setAttribute("data-zv-clipper", "failed")
  );
}
