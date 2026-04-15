import { Hono } from "hono";
import * as svc from "../services/images.service";
import { env } from "../env";

const app = new Hono();

// Maximum image upload size: 50 MB
const MAX_IMAGE_SIZE = 50 * 1024 * 1024;

app.post("/", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "image file is required" }, 400);
  // H-22: enforce upload size limit before processing
  if (file.size > MAX_IMAGE_SIZE) {
    return c.json({ error: `Image too large. Maximum size is ${MAX_IMAGE_SIZE / 1024 / 1024} MB` }, 413);
  }

  const image = await svc.uploadImage(userId, file);
  return c.json(image, 201);
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const sizeParam = c.req.query("size") as svc.ThumbTier | undefined;
  const tier = sizeParam === "sm" || sizeParam === "lg" ? sizeParam : undefined;

  const filepath = await svc.getImageFilePath(userId, id, tier);
  if (!filepath) return c.json({ error: "Not found" }, 404);

  const response = new Response(Bun.file(filepath));
  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  // H-20: Prevent browser from sniffing content type and rendering uploaded
  // HTML/SVG files as active web content (stored XSS mitigation).
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  return response;
});

app.post("/rebuild-thumbnails", async (c) => {
  const userId = c.get("userId");
  const wantsStream = c.req.header("accept")?.includes("text/event-stream");

  if (wantsStream) {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: any) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        send("progress", { total: 0, current: 0, generated: 0, skipped: 0, failed: 0 });

        try {
          const result = await svc.rebuildAllThumbnails(userId, {
            onProgress: (p) => send("progress", p),
          });
          send("done", { success: true, ...result });
        } catch (err: any) {
          send("error", { error: err.message || "Rebuild failed" });
        }
        controller.close();
      },
    });

    const origin = c.req.header("origin") || "";
    const corsHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    // C-13: Only reflect origins that are in the configured trusted origins list.
    // Reflecting arbitrary Origin values with credentials:true bypasses CORS entirely.
    if (origin && (env.trustAnyOrigin || env.trustedOriginsSet.has(origin))) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
      corsHeaders["Access-Control-Allow-Credentials"] = "true";
    }

    return new Response(stream, { headers: corsHeaders });
  }

  const result = await svc.rebuildAllThumbnails(userId);
  return c.json({ success: true, ...result });
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteImage(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as imagesRoutes };
