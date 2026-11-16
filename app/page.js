import DeskClient from "./desk-client";
import { assetView, board } from "../lib/engine/service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function withBudget(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export default async function Page() {
  const [initialBoard, initialView] = await Promise.all([
    withBudget(board(), 3600),
    withBudget(assetView("btc", "1d"), 3600),
  ]);

  return <DeskClient initialBoard={initialBoard} initialView={initialView} />;
}
