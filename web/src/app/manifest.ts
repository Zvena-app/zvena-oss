import type { MetadataRoute } from "next";

// The web app manifest: installable as an app (phones' "Add to Home Screen",
// desktop browsers' "Install"), opening on Home (My day). The square icons
// come from scripts/brand-icons.mjs; offline work comes from Documents'
// local-first store and the service worker (public/sw.js).
//
// Installed, zvena is a share target (a link or text → the /clip page; .md,
// .html and text files → imported into Documents by the service worker) and
// opens .md / .html files from the system (Documents' import).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/home",
    name: "zvena",
    short_name: "zvena",
    description: "The free workspace for docs, projects and design.",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    lang: "en",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "New page", short_name: "Page", url: "/docs#new" },
      { name: "New issue", short_name: "Issue", url: "/projects?create=issue" },
      { name: "Inbox", short_name: "Inbox", url: "/inbox" },
    ],
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "files", accept: ["text/markdown", ".md", ".markdown", "text/html", ".html", ".htm", "text/plain", ".txt"] }],
      },
    },
    file_handlers: [{ action: "/docs?import=launch", accept: { "text/markdown": [".md", ".markdown"], "text/html": [".html", ".htm"] } }],
  };
}
