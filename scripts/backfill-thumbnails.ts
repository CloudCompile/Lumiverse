/**
 * Backfill missing WebP thumbnails for all images in the database.
 *
 * Usage:  bun run backfill-thumbnails
 *
 * Generates two thumbnail tiers per image:
 *   - _thumb_sm.webp  (small, default 300px — cards, avatars)
 *   - _thumb_lg.webp  (large, default 700px — portrait panel, editor)
 *
 * Reads tier sizes from the `thumbnailSettings` setting in the DB (if set),
 * otherwise uses the defaults. Runs concurrently in batches for speed.
 */

import sharp from "sharp";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR || "data";
const DB_PATH = join(DATA_DIR, "lumiverse.db");
const IMAGES_DIR = join(DATA_DIR, "images");
const BATCH_CONCURRENCY = 20;
const WEBP_QUALITY = 80;

const DEFAULT_SMALL = 300;
const DEFAULT_LARGE = 700;

if (!existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(1);
}

if (!existsSync(IMAGES_DIR)) {
  mkdirSync(IMAGES_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

// Read tier sizes from first user's thumbnailSettings, or use defaults
let smallSize = DEFAULT_SMALL;
let largeSize = DEFAULT_LARGE;
const settingRow = db
  .query("SELECT value FROM settings WHERE key = 'thumbnailSettings' LIMIT 1")
  .get() as any;
if (settingRow) {
  try {
    const parsed = JSON.parse(settingRow.value);
    smallSize = parsed.smallSize ?? DEFAULT_SMALL;
    largeSize = parsed.largeSize ?? DEFAULT_LARGE;
  } catch {}
}

console.log(`Thumbnail sizes: small=${smallSize}px, large=${largeSize}px`);

interface ImageRow {
  id: string;
  filename: string;
  has_thumbnail: number;
}

const tiers = [
  { suffix: "_thumb_sm.webp", size: smallSize },
  { suffix: "_thumb_lg.webp", size: largeSize },
] as const;

// Find images missing any tier file on disk
const allImages = db.query("SELECT id, filename, has_thumbnail FROM images").all() as ImageRow[];
const needsWork = allImages.filter((img) => {
  return tiers.some((t) => !existsSync(join(IMAGES_DIR, `${img.id}${t.suffix}`)));
});

if (needsWork.length === 0) {
  console.log("All images already have both thumbnail tiers. Nothing to do.");
  process.exit(0);
}

console.log(`Found ${needsWork.length} images needing thumbnail generation (out of ${allImages.length} total).\n`);

const updateStmt = db.prepare("UPDATE images SET has_thumbnail = 1 WHERE id = ?");
let generated = 0;
let skipped = 0;
let failed = 0;

async function processImage(img: ImageRow): Promise<void> {
  const originalPath = join(IMAGES_DIR, img.filename);

  if (!existsSync(originalPath)) {
    skipped++;
    return;
  }

  const buffer = readFileSync(originalPath);
  let anySuccess = false;

  for (const tier of tiers) {
    const outPath = join(IMAGES_DIR, `${img.id}${tier.suffix}`);
    if (existsSync(outPath)) continue;

    try {
      await sharp(buffer)
        .resize(tier.size, tier.size, { fit: "cover" })
        .webp({ quality: WEBP_QUALITY })
        .toFile(outPath);
      anySuccess = true;
    } catch {
      failed++;
    }
  }

  if (anySuccess) {
    updateStmt.run(img.id);
    generated++;
  }
}

// Process in batches
const start = performance.now();
for (let i = 0; i < needsWork.length; i += BATCH_CONCURRENCY) {
  const batch = needsWork.slice(i, i + BATCH_CONCURRENCY);
  await Promise.all(batch.map(processImage));
  const progress = Math.min(i + BATCH_CONCURRENCY, needsWork.length);
  process.stdout.write(`\r  Processing... ${progress}/${needsWork.length}`);
}
const elapsed = (performance.now() - start).toFixed(0);

console.log(`\n\nDone in ${elapsed}ms:`);
console.log(`  Generated: ${generated}`);
if (skipped > 0) console.log(`  Skipped (missing original): ${skipped}`);
if (failed > 0) console.log(`  Failed: ${failed}`);

db.close();
