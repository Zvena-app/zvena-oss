import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server for the Docker image (deploy/web.Dockerfile).
  output: "standalone",
  poweredByHeader: false,
  // A page the rail prefetched on hover (ds Shell RailLink) is used for 30 s,
  // not 5 minutes: Home's lists and Projects' bootstrap come from it.
  experimental: { staleTimes: { static: 30 } },
  // No AGENTS.md in this project (zvena has no AI tooling of its own).
  agentRules: false,
  async headers() {
    return [
      // Self-hosted fonts never change under the same name.
      { source: "/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
  // A published site on its custom domain (src/proxy.ts names the host in
  // x-zv-site-host, after dropping any such header a client sent): its root,
  // robots.txt and sitemap.xml are the site's (lib/enterprise/hosts.ts).
  async rewrites() {
    const site = [{ type: "header" as const, key: "x-zv-site-host" }];
    return {
      beforeFiles: [
        { source: "/", has: site, destination: "/n/_site" },
        { source: "/robots.txt", has: site, destination: "/api/sites/robots" },
        { source: "/sitemap.xml", has: site, destination: "/api/sites/sitemap" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async redirects() {
    // Addresses people guess, and the pages' earlier addresses.
    const signin = ["login", "register", "signup", "sign-in", "sign-up"].map((p) => ({ source: `/${p}`, destination: "/signin", permanent: false }));
    const moved: [string, string][] = [
      ["/legal/consent", "/legal/privacy"],
      ["/privacy", "/legal/privacy"],
      ["/terms", "/legal/terms"],
      ["/cookies", "/legal/cookies"],
    ];
    // Page links made before Documents moved to /docs (the #page part survives the redirect).
    return [...signin, ...moved.map(([source, destination]) => ({ source, destination, permanent: true })), { source: "/notes", destination: "/docs", permanent: false }];
  },
};

export default nextConfig;
