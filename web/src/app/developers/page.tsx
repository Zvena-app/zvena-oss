import type { Metadata } from "next";
import { ContentPage } from "@/components/zvena/ContentPage";
import { config } from "@/lib/config";
import { pageMetadata } from "@/lib/meta";

export const metadata: Metadata = pageMetadata({
  title: "Docs API for developers",
  description:
    "The zvena Docs API: integrations, pages, databases, blocks, comments and webhooks. Notion-compatible requests and responses.",
  path: "/developers",
  previewTitle: "zvena Docs API",
});

// The developer reference of the public API (lib/notes/api, routes in app/api/v1),
// in English like the rest of the website.
// Shapes follow Notion's API (version 2022-06-28 by default; 2025-09-03 with data
// sources when a request names it), so existing clients mostly work with a
// different base URL.

const pre = {
  background: "var(--zv-card-2)",
  padding: "12px 14px",
  borderRadius: 6,
  overflowX: "auto" as const,
  fontSize: 13,
  lineHeight: 1.5,
};

const ENDPOINTS: [string, string, string][] = [
  ["GET", "/v1/users", "People and bots of the workspace"],
  ["GET", "/v1/users/me", "This integration's bot user"],
  ["GET", "/v1/users/{id}", "One user"],
  ["POST", "/v1/search", "Pages and databases by title"],
  ["POST", "/v1/pages", "A sub-page or a database row"],
  ["GET", "/v1/pages/{id}", "A page and its properties"],
  ["PATCH", "/v1/pages/{id}", "Properties, icon, cover, trash"],
  [
    "GET",
    "/v1/pages/{id}/properties/{property_id}",
    "One property (lists paginated)",
  ],
  ["POST", "/v1/databases", "A new database inside a page"],
  ["GET", "/v1/databases/{id}", "A database and its schema"],
  ["PATCH", "/v1/databases/{id}", "Title and schema properties"],
  [
    "POST",
    "/v1/databases/{id}/query",
    "Rows with filters and sorts (before 2025-09-03)",
  ],
  ["POST", "/v1/data_sources", "A new data source in a database (2025-09-03)"],
  ["GET", "/v1/data_sources/{id}", "A data source and its schema"],
  [
    "PATCH",
    "/v1/data_sources/{id}",
    "Title, properties, trash, move to another database",
  ],
  [
    "POST",
    "/v1/data_sources/{id}/query",
    "A data source's rows with filters and sorts",
  ],
  ["GET", "/v1/data_sources/{id}/templates", "A data source's page templates"],
  ["GET", "/v1/blocks/{id}", "A block"],
  ["PATCH", "/v1/blocks/{id}", "Update a block"],
  ["DELETE", "/v1/blocks/{id}", "Delete a block (a page goes to the trash)"],
  ["GET", "/v1/blocks/{id}/children", "A page's blocks or a block's children"],
  [
    "PATCH",
    "/v1/blocks/{id}/children",
    "Append blocks (at the end or after `after`)",
  ],
  ["GET", "/v1/comments?block_id=", "Discussions of a page or a block"],
  ["POST", "/v1/comments", "A comment or a reply"],
];

export default async function DevelopersPage() {
  const base = `${config.appUrl}/api`;
  return (
    <ContentPage
      eyebrow="Developers"
      title="zvena Docs API"
      lead="Read and change pages, databases and comments from your own code. Requests and responses follow Notion's API, so many existing clients work after changing the base URL."
    >
      <h2 id="start">{"Getting started"}</h2>
      <ol>
        <li>
          {
            "Docs → Settings → Connections → “New integration”. Pick its capabilities and copy the secret: it is shown once."
          }
        </li>
        <li>
          {
            "Open a page → “•••” → “Connections” and connect the integration. It sees that page and everything under it, nothing else."
          }
        </li>
        <li>{"Send the secret in the Authorization header."}</li>
      </ol>
      <pre style={pre} tabIndex={0}>{`curl ${base}/v1/users/me \\
  -H "Authorization: Bearer zv_secret_…" \\
  -H "Zvena-Version: 2022-06-28"`}</pre>

      <h2 id="rules">{"Rules"}</h2>
      <ul>
        <li>
          {
            "JSON only, bodies up to 1 MB, at most 100 blocks per request, 2 levels of nesting."
          }
        </li>
        <li>
          {
            "About 3 requests a second per integration; over it you get 429 with Retry-After."
          }
        </li>
        <li>
          {
            "Ids are accepted with or without dashes. Lists are paginated: start_cursor, page_size (up to 100), next_cursor, has_more."
          }
        </li>
        <li>
          {
            'Errors: { object: "error", status, code, message } — unauthorized, restricted_resource, object_not_found, validation_error, invalid_json, rate_limited, conflict_error.'
          }
        </li>
        <li>
          {
            "An integration's changes reach everyone at once, land in the version history and carry its name (“Last edited by”). The workspace owner's storage quota applies."
          }
        </li>
      </ul>

      <h2 id="versions">{"Versions and data sources"}</h2>
      <p>
        {
          'A database can hold several data sources, each with its own properties, rows and templates. With a Notion-Version (or Zvena-Version) header of 2025-09-03 or later the API speaks as Notion does: a database lists its data_sources, schemas and rows are read through /v1/data_sources, a row\'s parent is { type: "data_source_id", data_source_id, database_id }, and search returns data sources (filter value "data_source"). With an older version (2022-06-28 by default) nothing changes: each data source reads as a database with its own id, and the first one is the database itself.'
        }
      </p>

      <h2 id="endpoints">{"Endpoints"}</h2>
      <div
        style={{ overflowX: "auto" }}
        tabIndex={0}
        role="region"
        aria-label="Endpoints"
      >
        <table>
          <tbody>
            {ENDPOINTS.map(([m, path, what]) => (
              <tr key={`${m} ${path}`}>
                <td>
                  <code>{m}</code>
                </td>
                <td>
                  <code>{path}</code>
                </td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="objects">{"Objects"}</h2>
      <ul>
        <li>
          {
            "Blocks: paragraph, heading_1–3 (is_toggleable), bulleted_list_item, numbered_list_item, to_do, toggle, quote, callout, code, divider, equation, image, video, audio, file, pdf, bookmark, embed, table and table_row, column_list and column, child_page, child_database, link_to_page, synced_block, table_of_contents, breadcrumb."
          }
        </li>
        <li>
          {
            "Text: rich_text with annotations (bold, italic, strikethrough, underline, code, color), links and mentions of pages, dates and people."
          }
        </li>
        <li>
          {
            "Properties: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, files, people, relation, and read-only formula, rollup, created_time, created_by, last_edited_time, last_edited_by, unique_id, button. Place (our extension): { name, address, lat, lon }."
          }
        </li>
        <li>
          {
            'Files can be set as https external links only; files uploaded to zvena come back as type: "file" with a permanent URL.'
          }
        </li>
      </ul>
      <pre style={pre} tabIndex={0}>{`POST ${base}/v1/databases/{id}/query
{
  "filter": { "and": [
    { "property": "Status", "status": { "equals": "Done" } },
    { "property": "Due", "date": { "past_week": {} } }
  ] },
  "sorts": [{ "property": "Points", "direction": "descending" }]
}`}</pre>

      <h2 id="webhooks">{"Webhooks"}</h2>
      <p>
        {
          "Set an https endpoint and events in the integration's settings: page.created, page.content_updated, page.properties_updated, page.deleted, database.created, database.schema_updated, database.deleted, data_source.created, data_source.schema_updated, data_source.deleted, comment.created. Only events of connected pages arrive, never the integration's own changes."
        }
      </p>
      <p>
        {
          "Every request is signed: X-Zvena-Signature: sha256=<HMAC-SHA256 of the body with the signing secret>. The signing secret is shown once when you save the URL. Failed deliveries are retried after 1 s, 10 s and 1 min; private addresses are never called."
        }
      </p>
      <pre style={pre} tabIndex={0}>{`{
  "id": "…", "timestamp": "2026-10-14T12:00:00.000Z",
  "type": "page.properties_updated",
  "workspace_id": "…", "integration_id": "…",
  "entity": { "id": "…", "type": "page" },
  "authors": [{ "id": "…", "type": "person" }],
  "data": { "parent": { "id": "…" } },
  "attempt_number": 1
}`}</pre>
    </ContentPage>
  );
}
