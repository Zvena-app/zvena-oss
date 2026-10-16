// The workspace whose documents are open (set by NotesApp): every Documents
// API call names it, and the server checks the person's role there.

let current = "";

export function setWorkspace(id: string): void {
  current = id;
}

export function currentWorkspace(): string {
  return current;
}

/** `url` with ?ws=<current workspace> (or &ws=…). */
export function withWs(url: string): string {
  if (!current) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ws=${encodeURIComponent(current)}`;
}
