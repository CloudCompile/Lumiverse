import { deserialize, serialize } from "node:v8";

/** Binary framing retains undefined metadata deletions, blobs, and bigint. */
export function encodeSubprocessMessage(message: unknown): Buffer {
  const body = serialize(message);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
}

export async function readSubprocessMessages(
  stream: ReadableStream<Uint8Array>,
  receive: (message: unknown) => void,
): Promise<void> {
  const reader = stream.getReader();
  const header = Buffer.allocUnsafe(4);
  let headerOffset = 0;
  let body: Buffer | null = null;
  let bodyOffset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        if (!body) {
          const count = Math.min(4 - headerOffset, value.byteLength - offset);
          header.set(value.subarray(offset, offset + count), headerOffset);
          offset += count;
          headerOffset += count;
          if (headerOffset !== 4) continue;
          const length = header.readUInt32BE();
          if (length === 0 || length > 0x7fffffff) throw new Error("Invalid subprocess message length");
          body = Buffer.allocUnsafe(length);
          bodyOffset = 0;
        }
        const count = Math.min(body.byteLength - bodyOffset, value.byteLength - offset);
        body.set(value.subarray(offset, offset + count), bodyOffset);
        offset += count;
        bodyOffset += count;
        if (bodyOffset === body.byteLength) {
          const message = deserialize(body) as unknown;
          body = null;
          headerOffset = 0;
          receive(message);
        }
      }
    }
    if (headerOffset !== 0 || body) throw new Error("Subprocess message stream ended mid-frame");
  } finally {
    reader.releaseLock();
  }
}
