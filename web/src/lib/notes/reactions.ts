// Server-only: loads every after-push reaction of Documents (lib/notes/after-push.ts).
// Routes that write notes import this file once for its side effects; each
// feature registers itself in its own module and is listed here by one line.

import "./notify-people";
import "./reminders-server";
import "./automations-server";
// Page history: versions, events (lib/notes/versions.ts).
import "./versions";
// Integrations' webhooks (lib/notes/api/webhooks.ts).
import "./api/webhooks";
// Co-editing: a page deleted forever drops its Yjs state.
import "./collab";
