import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const FILES = {
  "app.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
};

export async function GET(_request, context) {
  const params = await context.params;
  const type = FILES[params.name];
  if (!type) {
    return Response.json({ error: "没有这个文件" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const file = path.join(process.cwd(), "marketdesk", "static", params.name);
  const body = await readFile(file);
  return new Response(body, {
    headers: {
      "content-type": type,
      "cache-control": "no-store",
    },
  });
}
