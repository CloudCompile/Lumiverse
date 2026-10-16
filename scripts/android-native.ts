import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const androidSystemLibraries = new Set(["libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libz.so",
  "libmediandk.so", "libvulkan.so", "libOpenSLES.so", "libEGL.so", "libGLESv2.so"]);
export const nativeSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function androidNdkLlvm(ndk: string) {
  if (!existsSync(join(ndk, "source.properties")) || !/^Pkg.Revision = 28\.2\.13676358$/m.test(readFileSync(join(ndk, "source.properties"), "utf8")))
    throw new Error("Set ANDROID_NDK_HOME to Android NDK r28c (28.2.13676358).");
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Native build scripts currently support macOS and Linux hosts.");
  return join(ndk, "toolchains/llvm/prebuilt", process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64", "bin");
}

/** Android only extracts APK native entries ending in .so. Preserve string-table offsets. */
export function androidLibraryName(name: string): string {
  return name.replace(/\.so\.([\d.]+)$/, (_, version: string) => `_${version.replaceAll(".", "_")}.so`);
}

export function readAndroidElf(input: Uint8Array, options: { executable?: boolean } = {}) {
  const bytes = Buffer.from(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 64 || bytes.readUInt32LE(0) !== 0x464c457f || bytes[4] !== 2 || bytes[5] !== 1 ||
      view.getUint16(18, true) !== 183 || view.getUint16(16, true) !== 3)
    throw new Error("Expected an ARM64 ELF shared library for Android.");
  function integer(offset: number) {
    const value = Number(view.getBigUint64(offset, true));
    if (!Number.isSafeInteger(value)) throw new Error("ELF integer exceeds supported range.");
    return value;
  }
  const phoff = integer(32), phsize = view.getUint16(54, true), phcount = view.getUint16(56, true);
  const loads: Array<{ offset: number; address: number; size: number; alignment: number }> = [];
  let dynamic: { offset: number; size: number } | undefined;
  for (let i = 0; i < phcount; i++) {
    const at = phoff + i * phsize;
    const type = view.getUint32(at, true), offset = integer(at + 8), address = integer(at + 16), size = integer(at + 32);
    if (offset + size > bytes.length) throw new Error("Truncated ELF segment.");
    if (type === 1) loads.push({ offset, address, size, alignment: integer(at + 48) });
    if (type === 2) dynamic = { offset, size };
    if (type === 3) {
      const interpreter = bytes.toString("utf8", offset, offset + size).replace(/\0$/, "");
      if (!options.executable || interpreter !== "/system/bin/linker64")
        throw new Error("Expected an Android executable interpreter only for packaged CLI tools.");
    }
  }
  if (!dynamic || !loads.length) throw new Error("Missing ELF dynamic/load segments.");
  const tags: Array<{ tag: number; value: number }> = [];
  for (let at = dynamic.offset; at < dynamic.offset + dynamic.size; at += 16) {
    const tag = integer(at);
    if (!tag) break;
    tags.push({ tag, value: integer(at + 8) });
  }
  const address = tags.find(entry => entry.tag === 5)?.value;
  const stringSize = tags.find(entry => entry.tag === 10)?.value;
  const load = loads.find(segment => address !== undefined && address >= segment.address && address < segment.address + segment.size);
  if (address === undefined || stringSize === undefined || !load) throw new Error("Missing ELF string table.");
  const stringOffset = load.offset + address - load.address;
  if (stringOffset + stringSize > bytes.length) throw new Error("Truncated ELF string table.");
  const tableSize = stringSize;
  function stringAt(offset: number) {
    const start = stringOffset + offset, end = bytes.indexOf(0, start);
    if (offset >= tableSize || end < start || end >= stringOffset + tableSize) throw new Error("Invalid ELF string.");
    return bytes.toString("utf8", start, end);
  }
  return {
    bytes, stringOffset, stringSize, loads,
    needed: tags.filter(entry => entry.tag === 1).map(entry => stringAt(entry.value)),
    soname: tags.find(entry => entry.tag === 14) ? stringAt(tags.find(entry => entry.tag === 14)!.value) : undefined,
    paths: tags.filter(entry => entry.tag === 15 || entry.tag === 29).map(entry => ({ offset: entry.value, text: stringAt(entry.value) })),
  };
}

/** Change dependency filenames, including GNU version records that share .dynstr entries. */
export function relocateAndroidElf(input: Uint8Array, options: { executable?: boolean } = {}): Buffer {
  const elf = readAndroidElf(input, options);
  const output = Buffer.from(input);
  const names = new Set([...elf.needed, ...(elf.soname ? [elf.soname] : [])]);
  for (const name of names) {
    const replacement = androidLibraryName(name);
    if (replacement === name) continue;
    if (Buffer.byteLength(replacement) !== Buffer.byteLength(name)) throw new Error(`Cannot relocate ${name} in place.`);
    const search = Buffer.from(name + "\0");
    let at = elf.stringOffset;
    while ((at = output.indexOf(search, at)) !== -1 && at < elf.stringOffset + elf.stringSize) {
      output.write(replacement, at, "utf8"); at += search.length;
    }
  }
  for (const path of elf.paths) {
    if (path.text !== "$ORIGIN" && !path.text.startsWith("/data/data/com.termux/files/usr/lib"))
      throw new Error(`Unexpected native search path: ${path.text}`);
    if (path.text.length < 7) throw new Error("Native search path cannot hold $ORIGIN.");
    output.fill(0, elf.stringOffset + path.offset, elf.stringOffset + path.offset + path.text.length);
    output.write("$ORIGIN", elf.stringOffset + path.offset, "utf8");
  }
  return output;
}

export type AndroidLibrary = { name: string; bytes: Buffer; source: string; sourceSha256: string; sha256: string; needed: string[] };
/** Git's compiled shell path must resolve inside an ordinary Android app. */
export function relocateAndroidGitShell(input: Uint8Array): Buffer {
  const output = Buffer.from(input);
  const original = Buffer.from("/data/data/com.termux/files/usr/bin/sh\0");
  const replacement = Buffer.from("/system/bin/sh\0");
  let at = 0;
  while ((at = output.indexOf(original, at)) !== -1) {
    output.fill(0, at, at + original.length);
    replacement.copy(output, at);
    at += original.length;
  }
  return output;
}

export function collectAndroidLibraries(entries: Array<{ name: string; path: string; executable?: boolean }>, searchDirectory: string): AndroidLibrary[] {
  const files = new Map<string, AndroidLibrary>();
  const pending = [...entries];
  while (pending.length) {
    const entry = pending.shift()!;
    const name = androidLibraryName(entry.name);
    if (files.has(name)) continue;
    if (!/^lib[^/]+\.so$/.test(name)) throw new Error(`APK cannot install native library ${name}.`);
    const source = realpathSync(entry.path), original = readFileSync(source);
    const options = { executable: entry.executable };
    const bytes = relocateAndroidElf(original, options), elf = readAndroidElf(bytes, options);
    if (elf.loads.some(segment => segment.alignment < 16384 || (segment.offset - segment.address) % 16384 !== 0))
      throw new Error(`Library is not aligned for Android 16 KiB pages: ${name}`);
    files.set(name, { name, bytes, source, sourceSha256: nativeSha256(original), sha256: nativeSha256(bytes), needed: elf.needed });
    for (const dependency of readAndroidElf(original, options).needed) {
      if (androidSystemLibraries.has(dependency)) continue;
      const path = join(searchDirectory, dependency);
      if (!existsSync(path)) throw new Error(`Missing native dependency ${dependency} required by ${name}`);
      pending.push({ name: dependency, path });
    }
  }
  for (const library of files.values()) for (const dependency of library.needed)
    if (!androidSystemLibraries.has(dependency) && !files.has(dependency)) throw new Error(`Unresolved APK dependency ${dependency}`);
  return [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Headers, executables, and unused codecs from the build sysroot never enter the APK. */
export function sharpAndroidLibraries(out: string, prefix: string) {
  return collectAndroidLibraries([
    { name: "libsharp.so", path: join(out, "libsharp.so") },
    ...["heif", "jxl"].map(codec => ({ name: `libvips-${codec}.so`, path: join(prefix, `lib/vips-modules-8.18/vips-${codec}.so`) })),
  ], join(prefix, "lib"));
}

export function walkNativeNotices(path: string, prefix = ""): Array<{ name: string; path: string }> {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name, file = join(path, entry.name);
    return entry.isDirectory() ? walkNativeNotices(file, name + "/") :
      entry.isFile() && /(?:license|licence|copying|copyright|patents)/i.test(entry.name) ? [{ name, path: file }] : [];
  });
}
