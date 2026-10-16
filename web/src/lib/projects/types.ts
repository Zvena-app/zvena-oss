// Zvena Projects: shapes shared by the server (lib/projects/*) and the
// browser (components/projects/*). Pure: no server or React imports.

export type StatusCategory = "backlog" | "unstarted" | "started" | "completed" | "canceled";
export const STATUS_CATEGORIES: readonly StatusCategory[] = ["backlog", "unstarted", "started", "completed", "canceled"];
/** Order of status groups in lists: active work first, closed last. */
export const CATEGORY_RANK: Record<StatusCategory, number> = { started: 0, unstarted: 1, backlog: 2, completed: 3, canceled: 4 };
export const isClosed = (c: StatusCategory) => c === "completed" || c === "canceled";

/** 0 none, 1 urgent, 2 high, 3 medium, 4 low (the order of the picker). */
export type Priority = 0 | 1 | 2 | 3 | 4;
export const PRIORITIES: readonly Priority[] = [0, 1, 2, 3, 4];
export const isPriority = (v: unknown): v is Priority => v === 0 || v === 1 || v === 2 || v === 3 || v === 4;

export type ProjectState = "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";
export const PROJECT_STATES: readonly ProjectState[] = ["backlog", "planned", "started", "paused", "completed", "canceled"];
export type Health = "on_track" | "at_risk" | "off_track";
export const HEALTHS: readonly Health[] = ["on_track", "at_risk", "off_track"];

export type EstimateScale = "none" | "linear" | "fibonacci" | "exponential" | "tshirt";
export const ESTIMATE_SCALES: Record<EstimateScale, readonly number[]> = {
  none: [],
  linear: [1, 2, 3, 4, 5],
  fibonacci: [0, 1, 2, 3, 5, 8, 13],
  exponential: [0, 1, 2, 4, 8, 16],
  tshirt: [1, 2, 3, 5, 8],
};
const TSHIRT: Record<number, string> = { 1: "XS", 2: "S", 3: "M", 5: "L", 8: "XL" };
export function estimateLabel(scale: EstimateScale, v: number | null): string {
  if (v === null) return "";
  return scale === "tshirt" ? (TSHIRT[v] ?? String(v)) : String(v);
}

export type RelationType = "blocks" | "blocked_by" | "related" | "duplicate" | "duplicated_by";

export type WsRole = "owner" | "editor" | "commenter" | "viewer";

export interface Person {
  id: string;
  name: string;
  avatar: string | null;
  role: WsRole | null; // null: no longer a member of the workspace
}

export interface Team {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  icon: string | null;
  private: boolean;
  estimates: EstimateScale;
  cyclesEnabled: boolean;
  cycleWeeks: number;
  /** Triage on: issues from outside the team wait for someone to accept them. */
  triage: boolean;
  /** Issues waiting in triage that the viewer sees (snoozed ones not counted). */
  triageCount: number;
  members: { userId: string; role: "lead" | "member" }[];
  isMember: boolean;
  archivedAt: number | null;
}

export interface Status {
  id: string;
  teamId: string;
  name: string;
  category: StatusCategory;
  color: string;
  description: string;
  position: number;
}

export interface Label {
  id: string;
  teamId: string | null;
  parentId: string | null;
  isGroup: boolean;
  name: string;
  color: string;
  description: string;
}

export interface Progress {
  total: number;
  started: number;
  completed: number;
  /** Estimate points: total and completed (0 when nothing is estimated). */
  points: number;
  pointsDone: number;
}

export interface Milestone {
  id: string;
  name: string;
  targetDate: string | null;
  sortOrder: number;
}

export interface Project {
  id: string;
  name: string;
  summary: string;
  icon: string | null;
  color: string;
  state: ProjectState;
  priority: Priority;
  health: Health | null;
  leadId: string | null;
  startDate: string | null;
  targetDate: string | null;
  sortOrder: number;
  teamIds: string[];
  memberIds: string[];
  dependsOn: string[];
  milestones: Milestone[];
  progress: Progress;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  archivedAt: number | null;
}

export interface ProjectDetail extends Project {
  description: string;
  updates: ProjectUpdate[];
}

export interface ProjectUpdate {
  id: string;
  projectId: string;
  authorId: string | null;
  health: Health;
  body: string;
  /** Written by zvena: the last issue closed ('met') or work reopened ('reopened'); `body` is empty. */
  auto: "met" | "reopened" | null;
  createdAt: number;
  updatedAt: number;
}

export interface Cycle {
  id: string;
  teamId: string;
  number: number;
  name: string;
  description: string;
  startsOn: string;
  endsOn: string;
  completedAt: number | null;
  progress: Progress;
}

export interface CycleSummary {
  scope: number;
  completed: number;
  canceled: number;
  carriedOver: number;
  carriedTo: string | null;
  points: number;
  pointsDone: number;
  byAssignee: { userId: string | null; total: number; completed: number }[];
}

export interface IssueRef {
  id: string;
  identifier: string;
  title: string;
  statusId: string;
  teamId: string;
}

export interface Issue {
  id: string;
  identifier: string;
  teamId: string;
  number: number;
  title: string;
  statusId: string;
  priority: Priority;
  estimate: number | null;
  assigneeId: string | null;
  creatorId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  cycleId: string | null;
  parentId: string | null;
  dueDate: string | null;
  sortOrder: number;
  labelIds: string[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  canceledAt: number | null;
  archivedAt: number | null;
  /** Waiting in its team's triage (accepted issues: false). */
  triage: boolean;
  /** Snoozed in triage until then. */
  triageSnoozedUntil: number | null;
  subIssues: { total: number; done: number };
  comments: number;
  attachments: number;
  /** Open issues blocking this one. */
  blockedBy: number;
  /** Open issues this one blocks. */
  blocking: number;
}

export interface Relation {
  id: string;
  type: RelationType;
  issue: IssueRef;
}

export interface Comment {
  id: string;
  issueId: string;
  authorId: string | null;
  parentId: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  reactions: { emoji: string; userIds: string[] }[];
}

export interface Activity {
  id: number;
  actorId: string | null;
  /** Jev changed it on the person's behalf (autopilot). */
  via?: "jev";
  kind: string;
  from: unknown;
  to: unknown;
  createdAt: number;
}

export interface Attachment {
  id: string;
  name: string;
  bytes: number;
  ext: string;
  url: string;
  uploadedBy: string | null;
  createdAt: number;
  image: boolean;
}

export type FieldType = "text" | "number" | "date" | "select" | "checkbox" | "url";
export const FIELD_TYPES: readonly FieldType[] = ["text", "number", "date", "select", "checkbox", "url"];

export interface CustomField {
  id: string;
  teamId: string | null;
  name: string;
  type: FieldType;
  options: { id: string; name: string; color: string }[];
  sortOrder: number;
}

export interface IssueDetail extends Issue {
  description: string;
  parent: IssueRef | null;
  children: Issue[];
  relations: Relation[];
  comments_: Comment[];
  activity: Activity[];
  attachmentList: Attachment[];
  subscribed: boolean;
  subscriberIds: string[];
  fields: Record<string, string>;
  aliases: string[];
  /** Jev's suggestions and its recent automatic changes (with Undo). */
  suggestions?: Suggestion[];
}

export type NotificationKind = "assigned" | "unassigned" | "mentioned" | "comment" | "reply" | "status" | "priority" | "due_soon" | "overdue" | "project_update" | "blocked" | "unblocked" | "subscribed" | "duplicate" | "goal_met" | "triage" | "triaged";

// --- Jev's suggestions (autopilot) ---

export type SuggestionKind = "priority" | "label" | "project" | "assignee" | "duplicate" | "done";

export interface Suggestion {
  id: string;
  issueId: string;
  kind: SuggestionKind;
  /** priority: {priority}; label: {labelId}; project: {projectId}; assignee: {userId}; done: {statusId}; duplicate: {issueId, identifier, title}. */
  value: { priority?: Priority; labelId?: string; projectId?: string; userId?: string; statusId?: string; issueId?: string; identifier?: string; title?: string };
  confidence: number;
  model: string;
  /** open: waits for a person; applied: Jev filled an empty field (Undo possible). */
  state: "open" | "applied" | "accepted" | "dismissed" | "undone";
  createdAt: number;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  actorId: string | null;
  issue: (IssueRef & { priority: Priority }) | null;
  projectId: string | null;
  commentId: string | null;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  readAt: number | null;
  archivedAt: number | null;
  snoozedUntil: number | null;
}

export interface SavedView {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  color: string;
  shared: boolean;
  ownerId: string;
  teamId: string | null;
  projectId: string | null;
  filters: IssueFilter;
  display: Partial<IssueDisplay>;
  createdAt: number;
  updatedAt: number;
}

export interface Favorite {
  kind: "issue" | "project" | "view" | "cycle" | "team";
  targetId: string;
  sortOrder: number;
  /** For issues: their identifier and title (other kinds are in the bootstrap). */
  identifier?: string;
  title?: string;
}

/** Everything the app needs before its first screen (one request). */
export interface Bootstrap {
  ws: { id: string; name: string; role: WsRole; personal: boolean };
  me: { id: string; name: string };
  people: Person[];
  teams: Team[];
  statuses: Status[];
  labels: Label[];
  projects: Project[];
  cycles: Cycle[];
  views: SavedView[];
  fields: CustomField[];
  favorites: Favorite[];
  unread: number;
  seq: number;
  today: string;
  /** Jev for the assistant's triage: not set up on the server, off in this workspace, or on. */
  jev?: "unconfigured" | "off" | "on";
}

// --- Filters and display (shared by the URL, saved views and the server) ---

export type DueFilter = "overdue" | "today" | "week" | "month" | "none" | "any";
export type RecentFilter = "day" | "week" | "month";

export interface IssueFilter {
  q?: string;
  team?: string[];
  status?: string[];
  category?: StatusCategory[];
  /** User ids, "me" or "none" (unassigned). */
  assignee?: string[];
  creator?: string[];
  priority?: Priority[];
  label?: string[];
  labelMode?: "any" | "all";
  /** Project ids or "none". */
  project?: string[];
  /** Cycle ids, "none" or "current" (each team's active cycle). */
  cycle?: string[];
  due?: DueFilter;
  created?: RecentFilter;
  updated?: RecentFilter;
  /** Issues blocked by an open issue / blocking an open issue. */
  blocked?: boolean;
  blocking?: boolean;
  /** Only the sub-issues of this issue. */
  parent?: string;
  /** Issues the viewer is subscribed to. */
  subscribed?: boolean;
  archived?: boolean;
  /** Issues waiting in triage (else they are left out of every list); `snoozed`: also the snoozed ones. */
  triage?: boolean;
  snoozed?: boolean;
}

export type Layout = "list" | "board" | "calendar";
export const LAYOUTS: readonly Layout[] = ["list", "board", "calendar"];
export type Grouping = "status" | "assignee" | "priority" | "project" | "cycle" | "team" | "none";
export const GROUPINGS: readonly Grouping[] = ["status", "assignee", "priority", "project", "cycle", "team", "none"];
export type Ordering = "manual" | "priority" | "updated" | "created" | "due" | "title" | "estimate";
export const ORDERINGS: readonly Ordering[] = ["manual", "priority", "updated", "created", "due", "title", "estimate"];
export type CompletedRange = "all" | "week" | "month" | "none";
export const COMPLETED_RANGES: readonly CompletedRange[] = ["all", "week", "month", "none"];
export type DisplayProp = "id" | "status" | "priority" | "assignee" | "labels" | "project" | "cycle" | "due" | "estimate" | "milestone" | "created" | "updated" | "links";
export const DISPLAY_PROPS: readonly DisplayProp[] = ["id", "status", "priority", "assignee", "labels", "project", "cycle", "due", "estimate", "milestone", "created", "updated", "links"];

export interface IssueDisplay {
  layout: Layout;
  group: Grouping;
  order: Ordering;
  completed: CompletedRange;
  subIssues: boolean;
  emptyGroups: boolean;
  props: DisplayProp[];
}

export const DEFAULT_DISPLAY: IssueDisplay = {
  layout: "list",
  group: "status",
  order: "manual",
  completed: "all",
  subIssues: true,
  emptyGroups: false,
  props: ["id", "status", "priority", "assignee", "labels", "project", "cycle", "due", "estimate", "links"],
};

/** One group of an issue query (lists and boards load each group separately). */
export interface IssueGroup {
  key: string;
  count: number;
  items: Issue[];
  cursor: string | null;
}

export interface IssuePage {
  groups: IssueGroup[];
  total: number;
}

// --- Identifiers ---------------------------------------------------------------

export const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{0,6}$/;
export const IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]{0,6})-(\d{1,9})$/;
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Local calendar day as YYYY-MM-DD. */
export function dayOf(ts: number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/**
 * Palette for teams, labels and projects: zvena's label colors (--ui-label-*;
 * the browser draws them through the theme tokens, so they suit light and dark).
 */
export const PALETTE: readonly string[] = ["#337ea9", "#448361", "#d9730d", "#cb912f", "#d44c47", "#9065b0", "#c14c8a", "#9f6b53", "#787774"];
