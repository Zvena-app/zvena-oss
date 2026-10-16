"use client";
/* eslint-disable @next/next/no-img-element -- custom emoji are the workspace's own uploaded images, shown as they are */

// zvena Documents: a custom emoji inside text (the editor's inline content;
// the picker and the hook are custom-emoji.tsx).

import { createReactInlineContentSpec } from "@blocknote/react";
import { EMOJI_FILE_RE } from "@/lib/notes/emoji";

export const CustomEmojiInline = createReactInlineContentSpec(
  { type: "customEmoji", propSchema: { name: { default: "" }, url: { default: "" } }, content: "none" },
  {
    render: function CustomEmojiRender(props) {
      const { name, url } = props.inlineContent.props;
      // Only images uploaded to Documents; anything else reads as :name:.
      if (!EMOJI_FILE_RE.test(url)) return <span className="nt-cemoji-text">{`:${name}:`}</span>;
      return <img className="nt-cemoji" src={url} alt={`:${name}:`} title={`:${name}:`} draggable={false} />;
    },
  }
);
