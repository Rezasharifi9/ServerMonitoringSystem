import { publicStatus } from "@/server/public-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await publicStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "دریافت وضعیت ممکن نیست." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
