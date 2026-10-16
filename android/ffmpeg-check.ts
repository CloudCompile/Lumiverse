import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpegBinary } from "../src/services/ffmpeg-binary.service";
import { muxSegments } from "../src/services/audio-mux.service";
import { normalizeVideoBuffer } from "../src/services/silent-video.service";

export async function checkAndroidFfmpeg(): Promise<string> {
  const binary = await resolveFfmpegBinary();
  assert.equal(binary, process.env.LUMIVERSE_FFMPEG_PATH, "Backend must resolve the APK's installed FFmpeg");
  assert.ok(binary);
  const probe = process.env.LUMIVERSE_FFPROBE_PATH;
  assert.ok(probe);
  const work = mkdtempSync(join(tmpdir(), "lumiverse-ffmpeg-check-"));
  async function run(executable: string, args: string[]) {
    const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      assert.equal(code, 0, `Android media process failed: ${stderr.slice(-2000)}`);
      return stdout;
    } finally { clearTimeout(timer); }
  }
  async function metadata(path: string) {
    return JSON.parse(await run(probe!, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path])) as {
      streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
      format: { duration: string };
    };
  }
  try {
    const version = (await run(binary, ["-version"])).split("\n")[0];
    for (const [codec, extension] of [["libmp3lame", "mp3"], ["aac", "m4a"], ["libopus", "ogg"], ["flac", "flac"]]) {
      const path = join(work, `audio.${extension}`);
      await run(binary, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.25",
        "-c:a", codec!, "-threads", "1", "-y", path]);
      const result = await metadata(path);
      assert.equal(result.streams[0]?.codec_type, "audio");
      assert.ok(Number(result.format.duration) > 0);
    }
    const mp3 = await Bun.file(join(work, "audio.mp3")).bytes();
    const muxed = await muxSegments([{ data: mp3, mime_type: "audio/mpeg" }, { data: mp3, mime_type: "audio/mpeg" }]);
    assert.equal(muxed.muxed_with_ffmpeg, true);
    assert.ok(muxed.data.length > mp3.length);
    const input = join(work, "input.mov");
    await run(binary, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=purple:s=64x64:r=10:d=0.3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-c:v", "mpeg4", "-c:a", "aac", "-threads", "1", "-shortest", "-y", input]);
    const normalized = await normalizeVideoBuffer(Buffer.from(await Bun.file(input).bytes()), "video/quicktime", "input.mov", { codec: "h264", stripAudio: true });
    assert.ok(normalized?.buffer.length, "Real video normalization must transcode the MOV");
    const output = join(work, "normalized.mp4"); await Bun.write(output, normalized.buffer);
    const result = await metadata(output);
    assert.deepEqual(result.streams.map(stream => stream.codec_name), ["h264"]);
    assert.equal(result.streams[0]?.width, 64);
    return `${version}: MP3/AAC/Opus/FLAC encoding, ffprobe, real TTS segment muxing, and silent H.264 video normalization passed.`;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
