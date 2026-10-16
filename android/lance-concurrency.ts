import assert from "node:assert/strict";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";

/** Verify commit conflicts across independent processes, not just one connection's locks. */
export async function checkLanceConcurrency(directory: string) {
  const initial = await connect(directory);
  try { await initial.createTable("concurrent", [{ id: "seed", vector: [1, 0], content: "initial" }]); }
  finally { initial.close(); }
  const writers = ["a", "b"].map(id => {
    let ready!: () => void;
    const received = new Promise<void>(resolve => { ready = resolve; });
    const child = Bun.spawn([process.execPath, "--no-env-file", "--smol", join(import.meta.dir, "lance-writer.ts"), directory, id], {
      cwd: process.cwd(), env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      ipc(message) { if (message?.type === "writer-ready") ready(); },
    });
    const output = new Response(child.stderr).text();
    return { child, output, ready: Promise.race([received, child.exited.then(async code => {
      throw new Error(`Lance writer exited before readiness (${code}): ${await output}`);
    })]) };
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(writers.map(writer => writer.ready)), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Lance writer readiness timed out")), 15000);
    })]);
    clearTimeout(timeout);
    for (const writer of writers) writer.child.send({ type: "start" });
    await Promise.race([Promise.all(writers.map(async writer => {
      const code = await writer.child.exited;
      assert.equal(code, 0, `Lance concurrent writer failed: ${await writer.output}`);
    })), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Lance concurrent writes timed out")), 45000);
    })]);
  } finally { clearTimeout(timeout); for (const writer of writers) writer.child.kill(); }
  const reopened = await connect(directory);
  try {
    const table = await reopened.openTable("concurrent");
    assert.equal(await table.countRows(), 17, "Concurrent commits must retain every row");
    const rows = await table.query().toArray();
    assert.deepEqual(rows.map(row => row.id).sort(), ["seed", ...["a", "b"].flatMap(id => Array.from({ length: 8 }, (_, i) => `${id}-${i}`))].sort());
    await reopened.dropTable("concurrent");
  } finally { reopened.close(); }
}
