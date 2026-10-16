import { handle } from "@/lib/calendar/api";

export const dynamic = "force-dynamic";

// zvena Calendar API (events, calendars, layers, scheduling links, feeds,
// CalDAV). The routes and their checks are in src/lib/calendar/api.ts.

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Ctx) {
  return handle(req, "GET", (await params).path);
}
export async function POST(req: Request, { params }: Ctx) {
  return handle(req, "POST", (await params).path);
}
export async function PATCH(req: Request, { params }: Ctx) {
  return handle(req, "PATCH", (await params).path);
}
export async function PUT(req: Request, { params }: Ctx) {
  return handle(req, "PUT", (await params).path);
}
export async function DELETE(req: Request, { params }: Ctx) {
  return handle(req, "DELETE", (await params).path);
}
