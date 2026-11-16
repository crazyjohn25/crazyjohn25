import { assetView, BY_ID } from "../../../lib/engine/service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const url = new URL(request.url);
  const assetId = url.searchParams.get("id") || "";
  const horizon = url.searchParams.get("horizon") || "swing";
  if (!Object.prototype.hasOwnProperty.call(BY_ID, assetId) || (horizon !== "swing" && horizon !== "intraday")) {
    return Response.json({ error: "未知标的或周期" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  try {
    const payload = await assetView(assetId, horizon);
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[desk] asset", error instanceof Error ? error.message : "failed");
    return Response.json({ error: "上游数据或计算暂时失败" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
