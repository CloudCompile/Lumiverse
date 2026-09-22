// ── Transpiler cache pinning ────────────────────────────────────────────────
// Bun mmap's its transpiler cache files. If the cache lives in /tmp and gets
// cleaned by systemd-tmpfiles / tmpwatch while the process is running, the
// stale mmap triggers SIGBUS. Tmux can also freeze the environment so the
// cache path inherits a stale or empty value. Pin it to a deterministic
// project-local directory before any other code runs.
import { resolve as _resolve } from "path";
if (!("BUN_RUNTIME_TRANSPILER_CACHE_PATH" in process.env)) {
  process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = _resolve(
    import.meta.dir,
    "..",
    "data",
    ".bun-transpiler-cache",
  );
}

// ── Bun version gate ────────────────────────────────────────────────────────
// Bun 1.4 includes package-install, runtime, and Windows IPC fixes required by
// Lumiverse, along with the production memory and stream improvements we rely on.
const [_bunMaj = 0, _bunMin = 0, _bunPat = 0] = Bun.version
  .split(".")
  .map((part) => Number.parseInt(part, 10) || 0);
const _bunMinimum: readonly [number, number, number] = [1, 4, 0];
const [_requiredBunMaj, _requiredBunMin, _requiredBunPat] = _bunMinimum;
const _bunTooOld = _bunMaj < _requiredBunMaj
  || (_bunMaj === _requiredBunMaj
    && (_bunMin < _requiredBunMin || (_bunMin === _requiredBunMin && _bunPat < _requiredBunPat)));
if (_bunTooOld) {
  console.error(`[startup] Bun ${Bun.version} is too old — Lumiverse requires Bun >= ${_bunMinimum.join(".")} on this platform.`);
  console.error(`[startup] Update with ${process.platform === "win32" ? ".\\start.ps1" : "./start.sh"}.`);
  process.exit(1);
}

// ── Native Dependency Pre-flight ────────────────────────────────────────────
// Must run BEFORE any application code is imported so that environment variables
// take precedence when NAPI-RS resolves bindings via `require()`.
import { configureLanceDbNativeOverride } from "./lancedb-preflight";
await configureLanceDbNativeOverride();

// ── Application Boot ────────────────────────────────────────────────────────
await import("./main");
