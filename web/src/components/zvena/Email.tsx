// An e-mail address that Cloudflare's "Email Address Obfuscation" leaves
// alone (<!--email_off--> … <!--email_on-->). The obfuscation swaps addresses
// for a decoding script that our Content-Security-Policy rightly refuses, so
// visitors would see "[email protected]" and a dead link. Works in server and
// client components; with link (default) it is a mailto: link.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function Email({ address, label, link = true }: { address: string; label?: string; link?: boolean }) {
  const text = esc(label ?? address);
  const inner = link ? `<a href="mailto:${esc(address)}">${text}</a>` : text;
  return <span dangerouslySetInnerHTML={{ __html: `<!--email_off-->${inner}<!--email_on-->` }} />;
}
