/* zvena's service worker: the installed app boots and opens recently used
 * pages without a network; Documents keep their pages and unsent edits in
 * IndexedDB themselves (lib/notes/store.ts, sync.ts) and send them when the
 * connection is back.
 *
 * What is cached, and for whom:
 *   - the build's own files (/_next/static, fonts, brand icons, the offline
 *     page): the same for everyone, cache first, in "zv-static";
 *   - app pages (/docs, /home, …) as HTML: network first, kept per person in
 *     "zv-user-<scope>" — <scope> is an HMAC of the account id the server
 *     writes into each page (<meta name="zv-scope">), and a page is stored
 *     only in the cache of the scope written in that very page, so one
 *     person's page can never be served to another;
 *   - pictures placed in pages (/api/notes/file/…): per person too;
 *   - nothing else: API answers, page data requests (RSC), posts and other
 *     sites always go to the network and are never stored.
 * Signing out (the logout routes pass through here), a page saying another
 * scope, or a page saying nobody is signed in drops every person's cache.
 *
 * The policy is a set of pure functions, exported for the unit tests
 * (tests/unit/sw-policy.test.ts) when this file is loaded by Node. */

(function (root) {
  "use strict";

  var VERSION = "zv-sw-1";
  var STATIC_CACHE = "zv-static-" + VERSION;
  var SHARE_CACHE = "zv-share";
  var USER_PREFIX = "zv-user-";
  var META_URL = "/__zv-sw/scope";
  var OFFLINE_URL = "/offline";
  var STATIC_MAX = 800;
  var FILES_MAX = 300;
  var FILE_MAX_BYTES = 8 * 1024 * 1024;

  var APP_PAGE = /^\/(docs|home|inbox|projects|settings|templates|team)(\/|$)/;
  var STATIC_PATH = /^\/(_next\/static\/|fonts\/|brand\/|icons\/)|^\/(favicon\.ico|icon\.svg|apple-icon\.png|manifest\.webmanifest|offline)$/;
  var FILE_PATH = /^\/api\/notes\/file\/[a-f0-9]{40}\.(png|jpg|gif|webp|avif|svg|ico)$/;
  var LOGOUT_PATH = /^\/api\/auth\/(logout|logout-all|account)$/;
  var SCOPE_RE = /^([A-Za-z0-9_-]{16,64}|guest)$/;

  /** What to do with a request: "static" | "page" | "file" | "share" | "logout" | "bypass". */
  function classify(input) {
    var url;
    try {
      url = new URL(input.url);
    } catch {
      return "bypass";
    }
    if (input.origin && url.origin !== input.origin) return "bypass";
    var method = (input.method || "GET").toUpperCase();
    if (method === "POST" && url.pathname === "/share-target") return "share";
    if ((method === "POST" || method === "DELETE") && LOGOUT_PATH.test(url.pathname)) return "logout";
    if (method !== "GET") return "bypass";
    var h = input.headers || {};
    // Next.js page data (client navigations, prefetches) is a person's data in another shape: never stored.
    if (h.rsc || h["next-router-prefetch"] || h["next-router-state-tree"] || url.searchParams.has("_rsc")) return "bypass";
    if (h.range) return "bypass";
    if (input.mode === "navigate" && APP_PAGE.test(url.pathname)) return "page";
    if (STATIC_PATH.test(url.pathname)) return "static";
    if (FILE_PATH.test(url.pathname)) return "file";
    return "bypass";
  }

  /** A page is kept by its path only: /docs?ws=a#Page and /docs open the same app, whose own store knows the rest. */
  function pageKey(raw) {
    var u = new URL(raw);
    return u.origin + u.pathname.replace(/\/+$/, "");
  }

  function userCacheName(scope) {
    return SCOPE_RE.test(scope || "") ? USER_PREFIX + scope : null;
  }

  /** The scope a page was rendered for: its <meta name="zv-scope">, or null (not an app page). */
  function scopeFromHtml(html) {
    var head = String(html).slice(0, 20000);
    var m = /<meta\s+name="zv-scope"\s+content="([^"]*)"/i.exec(head) || /<meta\s+content="([^"]*)"\s+name="zv-scope"/i.exec(head);
    return m && SCOPE_RE.test(m[1]) ? m[1] : null;
  }

  /** The caches to delete when `scope` is the current person (null: nobody): other people's, and old versions of the static one. */
  function cachesToDrop(names, scope) {
    var keep = scope ? userCacheName(scope) : null;
    return names.filter(function (n) {
      if (n.indexOf(USER_PREFIX) === 0) return n !== keep && n !== keep + "-files";
      if (n.indexOf("zv-static-") === 0) return n !== STATIC_CACHE;
      return false;
    });
  }

  /** Whether a network answer may be stored: a whole, successful, same-origin answer the server did not forbid storing. */
  function storable(res, kind) {
    if (!res || res.status !== 200 || res.type === "opaque" || res.redirected) return false;
    var cc = (res.headers.get("cache-control") || "").toLowerCase();
    if (kind === "static" && /no-store/.test(cc)) return false;
    if (kind === "file") {
      var len = Number(res.headers.get("content-length") || "0");
      if (len > FILE_MAX_BYTES) return false;
    }
    if (kind === "page" && !/text\/html/.test(res.headers.get("content-type") || "")) return false;
    return true;
  }

  var policy = { VERSION: VERSION, STATIC_CACHE: STATIC_CACHE, classify: classify, pageKey: pageKey, userCacheName: userCacheName, scopeFromHtml: scopeFromHtml, cachesToDrop: cachesToDrop, storable: storable };

  if (typeof module === "object" && module.exports) {
    module.exports = policy;
    return;
  }

  // ---------------------------------------------------------------- the worker

  var sw = root;

  function readScope() {
    return caches
      .open(STATIC_CACHE)
      .then(function (c) {
        return c.match(META_URL);
      })
      .then(function (r) {
        return r ? r.text() : null;
      })
      .then(function (s) {
        return s && SCOPE_RE.test(s) ? s : null;
      })
      .catch(function () {
        return null;
      });
  }

  function writeScope(scope) {
    return caches.open(STATIC_CACHE).then(function (c) {
      return scope ? c.put(META_URL, new Response(scope)) : c.delete(META_URL);
    });
  }

  /** Makes `scope` the current person: everyone else's pages and pictures go. */
  function switchScope(scope) {
    return readScope().then(function (cur) {
      if (cur === scope) return;
      return caches
        .keys()
        .then(function (names) {
          return Promise.all(
            cachesToDrop(names, scope).map(function (n) {
              return caches.delete(n);
            })
          );
        })
        .then(function () {
          return writeScope(scope);
        });
    });
  }

  function trim(cache, max) {
    return cache.keys().then(function (keys) {
      // Oldest first (insertion order): a long-lived install does not keep every old build.
      return Promise.all(
        keys.slice(0, Math.max(0, keys.length - max)).map(function (k) {
          return cache.delete(k);
        })
      );
    });
  }

  function putStatic(req, res) {
    return caches.open(STATIC_CACHE).then(function (c) {
      return c.put(req, res).then(function () {
        return trim(c, STATIC_MAX);
      });
    });
  }

  /** Stores an app page in the cache of the scope written in the page itself. */
  function putPage(url, res) {
    return res.text().then(function (html) {
      var scope = scopeFromHtml(html);
      if (!scope) return;
      return switchScope(scope).then(function () {
        var name = userCacheName(scope);
        if (!name) return;
        return caches.open(name).then(function (c) {
          return c.put(pageKey(url), new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
        });
      });
    });
  }

  function cachedPage(url) {
    return readScope().then(function (scope) {
      var name = userCacheName(scope);
      if (!name) return null;
      return caches.open(name).then(function (c) {
        return c.match(pageKey(url)).then(function (hit) {
          if (hit) return hit;
          // A page not kept here: Documents, which work offline, if they are.
          var docs = new URL("/docs", url).toString();
          return c.match(pageKey(docs)).then(function (d) {
            return d ? Response.redirect(docs, 302) : null;
          });
        });
      });
    });
  }

  function offline() {
    return caches.match(OFFLINE_URL).then(function (r) {
      return r || new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    });
  }

  // A network hiccup (ERR_NETWORK_CHANGED: an interface came or went) fails a
  // request that would succeed a moment later; static files and files are
  // asked for once more, then looked up in any cache, before the page sees an error.
  function fetchAgain(req) {
    return fetch(req).catch(function (err) {
      return new Promise(function (r) {
        setTimeout(r, 300);
      })
        .then(function () {
          return fetch(req);
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            if (hit) return hit;
            throw err;
          });
        });
    });
  }

  function onPage(event) {
    var req = event.request;
    return fetch(req)
      .then(function (res) {
        if (storable(res, "page")) event.waitUntil(putPage(req.url, res.clone()).catch(function () {}));
        return res;
      })
      .catch(function () {
        return cachedPage(req.url).then(function (hit) {
          return hit || offline();
        });
      });
  }

  function onStatic(event) {
    var req = event.request;
    return caches.match(req, { cacheName: STATIC_CACHE }).then(function (hit) {
      if (hit) return hit;
      return fetchAgain(req).then(function (res) {
        if (storable(res, "static")) event.waitUntil(putStatic(req, res.clone()).catch(function () {}));
        return res;
      });
    });
  }

  function onFile(event) {
    var req = event.request;
    return readScope().then(function (scope) {
      var name = userCacheName(scope);
      var files = name ? name + "-files" : null;
      return (files ? caches.open(files).then(function (c) { return c.match(req); }) : Promise.resolve(null)).then(function (hit) {
        if (hit) return hit;
        return fetchAgain(req).then(function (res) {
          if (files && storable(res, "file")) {
            event.waitUntil(
              caches.open(files).then(function (c) {
                return c.put(req, res.clone()).then(function () {
                  return trim(c, FILES_MAX);
                });
              })
            );
          }
          return res;
        });
      });
    });
  }

  function onLogout(event) {
    return fetch(event.request).then(function (res) {
      if (res.ok) event.waitUntil(switchScope(null).catch(function () {}));
      return res;
    });
  }

  function randomId() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map
      .call(a, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      })
      .join("");
  }

  /** The installed app's share target: files wait in a cache for Documents to import; a link or text opens the /clip page. */
  function onShare(event) {
    return event.request
      .formData()
      .then(function (fd) {
        var text = function (k) {
          var v = fd.get(k);
          return typeof v === "string" ? v.slice(0, 20000) : "";
        };
        var files = fd.getAll("files").filter(function (f) {
          return f && typeof f === "object" && typeof f.name === "string" && f.size > 0 && f.size <= 20 * 1024 * 1024;
        }).slice(0, 10);
        if (!files.length) {
          var q = new URLSearchParams();
          if (text("url")) q.set("url", text("url"));
          if (text("title")) q.set("title", text("title"));
          if (text("text")) q.set("text", text("text"));
          return Response.redirect("/clip?" + q.toString(), 303);
        }
        var id = randomId();
        return caches.open(SHARE_CACHE).then(function (c) {
          var meta = { at: Date.now(), title: text("title"), text: text("text"), url: text("url"), files: files.map(function (f) { return f.name; }) };
          return Promise.all(
            files.map(function (f, i) {
              return c.put("/__zv-share/" + id + "/" + i, new Response(f, { headers: { "content-type": f.type || "application/octet-stream", "x-name": encodeURIComponent(f.name) } }));
            })
          )
            .then(function () {
              return c.put("/__zv-share/" + id + "/meta", new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
            })
            .then(function () {
              return Response.redirect("/docs?share=" + id, 303);
            });
        });
      })
      .catch(function () {
        return Response.redirect("/clip", 303);
      });
  }

  sw.addEventListener("install", function (event) {
    event.waitUntil(
      caches
        .open(STATIC_CACHE)
        .then(function (c) {
          return c.addAll([OFFLINE_URL]);
        })
        .catch(function () {})
        .then(function () {
          return sw.skipWaiting();
        })
    );
  });

  sw.addEventListener("activate", function (event) {
    event.waitUntil(
      readScope()
        .then(function (scope) {
          return caches.keys().then(function (names) {
            return Promise.all(
              cachesToDrop(names, scope).map(function (n) {
                return caches.delete(n);
              })
            );
          });
        })
        .then(function () {
          return sw.clients.claim();
        })
    );
  });

  sw.addEventListener("fetch", function (event) {
    var req = event.request;
    var headers = {};
    ["rsc", "next-router-prefetch", "next-router-state-tree", "range"].forEach(function (k) {
      if (req.headers.has(k)) headers[k] = "1";
    });
    var kind = classify({ url: req.url, method: req.method, mode: req.mode, headers: headers, origin: sw.location.origin });
    if (kind === "page") event.respondWith(onPage(event));
    else if (kind === "static") event.respondWith(onStatic(event));
    else if (kind === "file") event.respondWith(onFile(event));
    else if (kind === "logout") event.respondWith(onLogout(event));
    else if (kind === "share") event.respondWith(onShare(event));
  });

  sw.addEventListener("message", function (event) {
    var d = event.data || {};
    if (event.origin && event.origin !== sw.location.origin) return;
    if (d.type === "scope") {
      // The page says who is signed in (null: nobody).
      var scope = typeof d.scope === "string" && SCOPE_RE.test(d.scope) ? d.scope : null;
      event.waitUntil(switchScope(scope));
    } else if (d.type === "warm" && Array.isArray(d.urls)) {
      // Files the page loaded before this worker controlled it.
      event.waitUntil(
        caches.open(STATIC_CACHE).then(function (c) {
          return Promise.all(
            d.urls.slice(0, 300).map(function (u) {
              if (classify({ url: u, method: "GET", origin: sw.location.origin }) !== "static") return null;
              return c.match(u).then(function (hit) {
                return hit ? null : c.add(u).catch(function () {});
              });
            })
          ).then(function () {
            return trim(c, STATIC_MAX);
          });
        })
      );
      if (typeof d.page === "string" && classify({ url: d.page, method: "GET", mode: "navigate", origin: sw.location.origin }) === "page") {
        event.waitUntil(
          fetch(d.page, { credentials: "same-origin" })
            .then(function (res) {
              return storable(res, "page") ? putPage(d.page, res) : null;
            })
            .catch(function () {})
        );
      }
    } else if (d.type === "signout") {
      event.waitUntil(switchScope(null));
    }
  });
})(typeof self !== "undefined" ? self : globalThis);
