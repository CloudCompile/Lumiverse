import { resolve, join } from "path";

export const PROJECT_ROOT = resolve(import.meta.dir, "../../..");
export const ENTRY = join(PROJECT_ROOT, "src/index.ts");
export const ENV_FILE = join(PROJECT_ROOT, ".env");

export const MAX_LOG_LINES = 2000;
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const AVAILABLE_BRANCHES = ["main", "staging"] as const;
export const CONFIRMATION_TIMEOUT_MS = 10_000;
export const SELF_RESTART_DEBOUNCE_MS = 500;
export const STARTUP_DETECT_TIMEOUT_MS = 2000;
export const STOP_FORCE_KILL_MS = 5000;
export const LOG_BATCH_INTERVAL_MS = 100; // ~10fps batch window (plenty for a log viewer)
