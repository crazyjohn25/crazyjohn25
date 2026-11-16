import { board } from "../../../lib/engine/service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const payload = await board();
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[desk] board", error instanceof Error ? error.message : "failed");
    return Response.json({ error: "上游数据或计算暂时失败" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
