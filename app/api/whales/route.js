import { getWhaleMonitor } from "../../../lib/engine/hl-monitor.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request) {
  const requested = Number(new URL(request.url).searchParams.get("min"));
  const min = Number.isFinite(requested) ? Math.min(1_000_000, Math.max(10_000, requested)) : 20_000;
  const monitor = getWhaleMonitor();
  const events = monitor.events.filter((event) => event.notional >= min);
  return Response.json(
    {
      events,
      status: { ...monitor.status, minUsd: min },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
