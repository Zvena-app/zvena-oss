"use client";

// Notion's link mention: a pasted link shown as a chip with the site's icon
// and the page's title ("Paste as → Mention"). The title and icon come from
// the server's link preview (/api/notes/unfurl, signed-in people only);
// until then, or without it, the chip shows the site's name.

import { createReactInlineContentSpec } from "@blocknote/react";
import { Globe } from "lucide-react";

const safeHttp = (u: string) => /^https?:\/\//i.test(u);

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const LinkMentionInline = createReactInlineContentSpec(
  { type: "linkMention", propSchema: { url: { default: "" }, title: { default: "" }, icon: { default: "" } }, content: "none" },
  {
    render: function LinkMentionRender(props) {
      const { url, title, icon } = props.inlineContent.props;
      if (!safeHttp(url)) return <span className="nt-link-mention">{title || url}</span>;
      return (
        <a className="nt-link-mention" href={url} target="_blank" rel="noopener noreferrer nofollow" contentEditable={false} title={url}>
          {safeHttp(icon) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={icon} alt="" width={14} height={14} referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />
          ) : (
            <Globe size={14} />
          )}
          <span>{title || hostOf(url)}</span>
        </a>
      );
    },
  }
);

/** The page's title and icon for a mention (empty when there is no preview). */
export async function linkPreview(url: string): Promise<{ title: string; icon: string }> {
  try {
    const r = await fetch(`/api/notes/unfurl?url=${encodeURIComponent(url)}`, { credentials: "same-origin" });
    if (!r.ok) return { title: "", icon: "" };
    const j = (await r.json()) as { title?: string; icon?: string };
    return { title: (j.title ?? "").slice(0, 200), icon: j.icon && safeHttp(j.icon) ? j.icon : "" };
  } catch {
    return { title: "", icon: "" };
  }
}
