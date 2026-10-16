"use client";

// Notion's Feed view: the database's pages as stacked posts — who wrote it
// and when, the title, the properties the view shows, the page content
// (folded past a few lines, "Read more" opens the page) and its comments
// under it. "Show page content" and "Show comments" are view options.

import { useMemo, useState } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { CardProps, RowIcon } from "./views";
import { Comments } from "../Comments";
import { StaticBlocks } from "../StaticBlocks";
import { blocksText, displayTitle } from "@/lib/notes/model";
import { relativeTime } from "@/lib/notes/i18n";
import { personName } from "@/lib/notes/people";
import type { Note } from "@/lib/notes/types";

/** Posts newest first unless the view sorts them. */
export function feedOrder(rows: readonly Note[], sorted: boolean): Note[] {
  return sorted ? [...rows] : [...rows].sort((a, b) => b.createdAt - a.createdAt);
}

function Post({ ctl, row }: { ctl: DbCtl; row: Note }) {
  const { t, locale, canComment } = ctl.api;
  const view = ctl.view;
  const [commenting, setCommenting] = useState(false);
  const author = personName(row.createdBy, { unknown: "", form: t("db.form") });
  const hasBody = blocksText(row.content, 0, 1).length > 0 || row.content.length > 1;
  const comments = (row.comments ?? []).filter((c) => !c.thread);
  const showComments = !view?.feed?.hideComments;
  return (
    <article className="nt-feed-post">
      <header className="nt-feed-head">
        {author && <span className="nt-cm-avatar">{author.trim().charAt(0).toUpperCase()}</span>}
        <span className="nt-feed-meta">{author ? t("feed.by", { name: author, when: relativeTime(t, locale, row.createdAt) }) : relativeTime(t, locale, row.createdAt)}</span>
      </header>
      <button type="button" className="nt-feed-title nt-btn-reset" onClick={() => ctl.openRow(row.id)}>
        {!view?.hideIcons && row.icon && <RowIcon row={row} />}
        <span>{displayTitle(row, t("page.untitled"))}</span>
      </button>
      <CardProps ctl={ctl} row={row} />
      {!view?.feed?.hideContent && hasBody && (
        <div className="nt-feed-body">
          <div className="nt-feed-content nt-editor">
            <StaticBlocks content={row.content} />
          </div>
          <button type="button" className="nt-feed-more nt-btn-reset" onClick={() => ctl.openRow(row.id)}>
            {t("feed.readMore")}
          </button>
        </div>
      )}
      {showComments && (
        <footer className="nt-feed-foot">
          {canComment && !commenting && comments.length === 0 && (
            <button type="button" className="nt-feed-comment nt-btn-reset" onClick={() => setCommenting(true)}>
              <MessageSquare />
              {t("comments.placeholder")}
            </button>
          )}
          {(comments.length > 0 || commenting) && canComment && <Comments note={row} active={commenting} onActive={setCommenting} />}
          {!canComment && comments.length > 0 && (
            <div className="nt-feed-count">
              <MessageSquare />
              {comments.length}
            </div>
          )}
        </footer>
      )}
    </article>
  );
}

export function FeedView({ ctl }: { ctl: DbCtl }) {
  const { t } = ctl.api;
  const posts = useMemo(() => feedOrder(ctl.rows, Boolean(ctl.view?.sorts.length)), [ctl.rows, ctl.view?.sorts.length]);
  const limit: number = ctl.view?.limit ?? 25;
  const [shown, setShown] = useState<number>(limit);
  if (posts.length === 0) return ctl.allRows.length === 0 ? <div className="nt-panel-empty">{t("feed.empty")}</div> : <div className="nt-panel-empty">{t("db.noResults")}</div>;
  return (
    <div className="nt-feed">
      {posts.slice(0, shown).map((r) => (
        <Post key={r.id} ctl={ctl} row={r} />
      ))}
      {posts.length > shown && (
        <button type="button" className="nt-load-more nt-btn-reset" onClick={() => setShown((n) => n + limit)}>
          <ChevronDown size={14} />
          {t("db.loadMoreN", { n: posts.length - shown })}
        </button>
      )}
    </div>
  );
}
