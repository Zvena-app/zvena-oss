// A small XML reader for WebDAV / CalDAV answers (multistatus). Pure.
// Names are matched by their local part (DAV:, CalDAV, Apple's and
// CalendarServer's namespaces never clash on the names used here). No DTDs,
// no external entities: only the five XML entities and character references
// are read, so nothing a server sends can make it fetch or expand anything.

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    if (e[0] !== "#") return ENT[e];
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&${({ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" } as Record<string, string>)[c]};`);
}

const local = (n: string) => n.slice(n.indexOf(":") + 1);

/** The tree of a document, or null when it is not XML at all. Bounded: deep or huge documents stop being read. */
export function parseXml(xml: string, maxNodes = 200_000): XNode | null {
  const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  let i = 0;
  let nodes = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) stack[stack.length - 1].text += decodeXml(xml.slice(i, textEnd));
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      stack[stack.length - 1].text += xml.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const e = xml.indexOf(">", lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) break;
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) {
      const name = local(raw.slice(1).trim());
      // Close up to the matching element (tolerates sloppy servers).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const self = raw.endsWith("/");
    const body = self ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body.trim());
    if (!m) continue;
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = decodeXml(a[3] ?? a[4] ?? "");
    const node: XNode = { name: local(m[1]), attrs, children: [], text: "" };
    if (++nodes > maxNodes || stack.length > 64) return root;
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return root.children.length ? root : null;
}

export function find(node: XNode | null | undefined, name: string): XNode | null {
  if (!node) return null;
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return null;
}

export function findAll(node: XNode | null | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

export interface DavResponse {
  href: string;
  /** Properties with a 200 status, by local name. */
  props: Map<string, XNode>;
}

/** The responses of a 207 Multi-Status body. */
export function multistatus(xml: string): DavResponse[] {
  const doc = parseXml(xml);
  const out: DavResponse[] = [];
  for (const r of findAll(doc, "response")) {
    const href = r.children.find((c) => c.name === "href")?.text.trim() ?? "";
    if (!href) continue;
    const props = new Map<string, XNode>();
    for (const ps of r.children.filter((c) => c.name === "propstat")) {
      const status = ps.children.find((c) => c.name === "status")?.text ?? "";
      if (!/\s2\d\d\s/.test(` ${status} `)) continue;
      const prop = ps.children.find((c) => c.name === "prop");
      for (const p of prop?.children ?? []) props.set(p.name, p);
    }
    out.push({ href, props });
  }
  return out;
}
