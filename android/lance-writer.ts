import { connect } from "@lancedb/lancedb";
const [directory, writer] = process.argv.slice(2);
if (!directory || !writer || !process.send) throw new Error("Launch through the prototype's concurrency check");
const connection = await connect(directory);
try {
  const table = await connection.openTable("concurrent");
  const start = new Promise<void>(resolve => process.once("message", () => resolve()));
  process.send({ type: "writer-ready" });
  await start;
  for (let i = 0; i < 8; i++) await table.add([{ id: `${writer}-${i}`, vector: [1, 0], content: "concurrent commit" }]);
} finally { connection.close(); }
process.exit(0);
