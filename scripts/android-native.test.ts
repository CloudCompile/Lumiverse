import { describe, expect, test } from "bun:test";
import { androidLibraryName, readAndroidElf, relocateAndroidElf, relocateAndroidGitShell } from "./android-native";

// Minimal ELF64 fixture with a shared dependency/version filename string, symbol,
// SONAME, and RUNPATH. Mutation must preserve the rest of the binary exactly.
function fixture() {
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt32LE(0x464c457f); bytes[4] = 2; bytes[5] = 1;
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(183, 18);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(2, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(1024n, 96); bytes.writeBigUInt64LE(16384n, 112);
  bytes.writeUInt32LE(2, 120); bytes.writeBigUInt64LE(192n, 128); bytes.writeBigUInt64LE(96n, 152);
  const strings = Buffer.from("\0libvips.so.42\0libsharp.so\0/data/data/com.termux/files/usr/lib\0vips_init\0");
  strings.copy(bytes, 512);
  const name = strings.indexOf("libvips.so.42"), soname = strings.indexOf("libsharp.so"), path = strings.indexOf("/data/data/");
  for (const [i, [tag, value]] of [[5, 512], [10, strings.length], [1, name], [14, soname], [29, path]].entries()) {
    bytes.writeBigUInt64LE(BigInt(tag), 192 + i * 16); bytes.writeBigUInt64LE(BigInt(value), 200 + i * 16);
  }
  // GNU version file reference retains its string-table offset after relocation.
  bytes.writeUInt32LE(name, 400);
  return bytes;
}
describe("Android native ELF packaging", () => {
  test("Git uses Android's shell without changing binary offsets or other paths", () => {
    const source = Buffer.from("before\0/data/data/com.termux/files/usr/bin/sh\0after\0/data/data/com.termux/files/usr/bin/sha256sum\0");
    const patched = relocateAndroidGitShell(source);
    expect(patched.length).toBe(source.length);
    expect(patched.includes(Buffer.from("/system/bin/sh\0"))).toBe(true);
    expect(patched.indexOf("after")).toBe(source.indexOf("after"));
    expect(patched.includes(Buffer.from("/data/data/com.termux/files/usr/bin/sha256sum\0"))).toBe(true);
    expect(source.includes(Buffer.from("/system/bin/sh\0"))).toBe(false);
  });
  test("versioned library names fit APK extraction without growing ELF strings", () => {
    for (const name of ["libvips.so.42", "libglib-2.0.so.0", "libexample.so.1.2.3"]) {
      expect(androidLibraryName(name)).toMatch(/^lib.+\.so$/);
      expect(androidLibraryName(name).length).toBe(name.length);
    }
    expect(androidLibraryName("libc++_shared.so")).toBe("libc++_shared.so");
  });
  test("relocation retains version references and symbols while removing the Termux prefix", () => {
    const original = fixture(), patched = relocateAndroidElf(original), elf = readAndroidElf(patched);
    expect(elf.needed).toEqual(["libvips_42.so"]);
    expect(elf.soname).toBe("libsharp.so");
    expect(elf.paths[0]?.text).toBe("$ORIGIN");
    expect(patched.readUInt32LE(400)).toBe(original.readUInt32LE(400));
    const versionName = 512 + patched.readUInt32LE(400);
    expect(patched.subarray(versionName, patched.indexOf(0, versionName)).toString()).toBe("libvips_42.so");
    expect(patched.includes(Buffer.from("vips_init\0"))).toBe(true);
    expect(readAndroidElf(original).needed).toEqual(["libvips.so.42"]);
    expect(patched.subarray(0, 512)).toEqual(original.subarray(0, 512));
    expect(patched.length).toBe(original.length);
  });
  test("rejects host binaries and unrecognized native search paths", () => {
    expect(() => readAndroidElf(Buffer.alloc(64))).toThrow("ARM64 ELF");
    const bytes = fixture(); bytes.writeUInt16LE(62, 18);
    expect(() => readAndroidElf(bytes)).toThrow("ARM64 ELF");
    const path = fixture(); path.write("/usr/local/host/lib", 537);
    expect(() => relocateAndroidElf(path)).toThrow("Unexpected native search path");
  });
  test("only explicitly selected executables may use Android's program interpreter", () => {
    const bytes = fixture(); bytes.copy(bytes, 768, 64, 176);
    bytes.writeBigUInt64LE(768n, 32); bytes.writeUInt16LE(3, 56);
    bytes.writeUInt32LE(3, 880); bytes.writeBigUInt64LE(700n, 888);
    bytes.writeBigUInt64LE(21n, 912);
    bytes.write('/system/bin/linker64\0', 700);
    expect(() => readAndroidElf(bytes)).toThrow();
    expect(readAndroidElf(bytes, { executable: true }).needed).toEqual(['libvips.so.42']);
    bytes.write('/lib/ld-linux-aarch64.so.1\0', 700); bytes.writeBigUInt64LE(26n, 912);
    expect(() => readAndroidElf(bytes, { executable: true })).toThrow();
  });
});
