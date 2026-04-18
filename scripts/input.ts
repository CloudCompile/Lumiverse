/**
 * Shared input helpers for CLI scripts (setup wizard, password reset, etc.).
 *
 * Built on a single long-lived `readline.Interface` whose output is piped
 * through a `mute-stream`.  This pattern (used by inquirer / prompts /
 * enquirer) sidesteps two Bun-on-Windows bugs that broke the previous
 * raw-mode byte reader on PowerShell 5 / classic conhost:
 *
 *   - oven-sh/bun#9853, #25663 — `setRawMode(true)` returns and `isRaw`
 *     reads `true`, but the underlying console mode never actually
 *     switches.  Cooked-mode echo prints the password before the data
 *     handler fires.
 *   - oven-sh/bun#8693 — `stdin.pause()` + `removeListener` doesn't
 *     release fd 0 on Windows, so the next prompt's `data` listener
 *     never fires (re-prompt after validation rejection hangs).
 *
 * Keeping ONE readline interface for the whole script means stdin
 * ownership never changes hands — the second bug can't trigger.  Mask
 * rendering is a per-character `*` replacement applied by mute-stream
 * while muted, so we don't depend on any VT escape code support.
 */

import readline from "node:readline";
import MuteStream from "mute-stream";
import { theme, promptLabel, inputHint } from "./ui";

export interface AskTextOptions {
  defaultValue?: string;
  /** Return an error message to re-prompt, or null to accept the value. */
  validate?: (value: string) => string | null;
}

/**
 * Prompt for plain text input with visible echo.
 * Loops on validation failure so callers don't need to reconstruct the prompt.
 */
export async function askText(question: string, options: AskTextOptions = {}): Promise<string> {
  const { defaultValue, validate } = options;
  for (;;) {
    const raw = await prompt(question, { masked: false, defaultValue });
    const value = raw.trim() || defaultValue || "";
    if (validate) {
      const error = validate(value);
      if (error) {
        console.log(`    ${theme.warning}${error}${theme.reset}`);
        continue;
      }
    }
    return value;
  }
}

/**
 * Prompt for secret input with masked echo (one `*` per typed character).
 * NFC-normalized so identical visual passwords always compare equal.
 */
export function askSecret(question: string): Promise<string> {
  return prompt(question, { masked: true });
}

/**
 * Close the cached readline interface so the script can exit.  Without this
 * call, the readline keeps stdin readable and Node/Bun will keep the event
 * loop alive even after the wizard's `main()` resolves.
 */
export function closeInput(): void {
  if (cachedRl) {
    cachedOutput?.unmute();
    cachedRl.close();
    cachedRl = null;
    cachedOutput = null;
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

let cachedRl: readline.Interface | null = null;
let cachedOutput: MuteStream | null = null;

function getReadline(): { rl: readline.Interface; output: MuteStream } {
  if (cachedRl && cachedOutput) return { rl: cachedRl, output: cachedOutput };

  const output = new MuteStream();
  output.pipe(process.stdout);

  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
    historySize: 0,
  });

  // Ctrl+C → exit cleanly (unmute first so the next shell prompt isn't
  // hidden behind a still-muted output stream).
  rl.on("SIGINT", () => {
    output.unmute();
    process.stdout.write("\n");
    rl.close();
    process.exit(1);
  });

  cachedRl = rl;
  cachedOutput = output;
  return { rl, output };
}

interface PromptOptions {
  masked: boolean;
  defaultValue?: string;
}

function prompt(question: string, opts: PromptOptions): Promise<string> {
  const { rl, output } = getReadline();
  const hint = !opts.masked && opts.defaultValue ? ` ${inputHint(`(${opts.defaultValue})`)}` : "";
  const prefix = `${promptLabel(question)}${hint} `;

  return new Promise<string>((resolve) => {
    if (opts.masked) {
      // Write the visible prefix BEFORE muting so mute-stream doesn't
      // replace the prompt itself with `*`s.  Then mute and let
      // mute-stream substitute one `*` per echoed keystroke.
      output.write(prefix);
      output.mute();
      output.replace = "*";
      rl.question("", (answer) => {
        output.unmute();
        output.replace = "";
        process.stdout.write("\n"); // the Enter keystroke was muted
        resolve(answer.normalize("NFC"));
      });
    } else {
      rl.question(prefix, (answer) => {
        resolve(answer.normalize("NFC"));
      });
    }
  });
}
