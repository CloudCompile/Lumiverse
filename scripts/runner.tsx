#!/usr/bin/env bun
/**
 * Lumiverse Visual Runner (Ink TUI)
 *
 * A terminal dashboard that spawns the backend as a child process and
 * provides real-time log viewing, status monitoring, and process control.
 *
 * Usage:
 *   bun run runner
 *   bun run scripts/runner.tsx [-- --dev]
 *
 * Keyboard:
 *   R - Restart server
 *   U - Update from GitHub (when available)
 *   B - Switch branch (main ↔ staging, confirmation required)
 *   T - Toggle remote/mobile access (TRUST_ANY_ORIGIN)
 *   V - Force reset LanceDB vector store (confirmation required)
 *   O - Open in browser
 *   C - Clear log
 *   Q / Ctrl+C - Quit
 */

import React from "react";
import { render } from "ink";
import { App } from "./runner/App.js";
import { killServerProcess } from "./runner/hooks/useServerProcess.js";

// ─── Parse args ──────────────────────────────────────────────────────────────

const isDev = process.argv.includes("--dev");

// ─── Alternate screen management ─────────────────────────────────────────────

function enterAltScreen(): void {
  // Clear main buffer scrollback — prevents macOS Terminal.app from
  // letting the user scroll up past the TUI into old shell history.
  process.stdout.write("\x1b[3J");
  // Switch to alternate screen buffer
  process.stdout.write("\x1b[?1049h");
  // Clear and park cursor
  process.stdout.write("\x1b[2J\x1b[H");
  // Hide cursor for the TUI
  process.stdout.write("\x1b[?25l");
}

function restoreTerminal(): void {
  // Reset scroll region (in case it was set)
  process.stdout.write("\x1b[r");
  // Show cursor
  process.stdout.write("\x1b[?25h");
  // Leave alt screen — restores the previous buffer
  process.stdout.write("\x1b[?1049l");
  // Ensure raw mode is off so the shell gets normal input back
  if (process.stdin.isTTY && process.stdin.isRaw) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // may already be restored
    }
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

enterAltScreen();

const app = render(
  React.createElement(App, { isDev, leaveAltScreen: restoreTerminal }),
  {
    patchConsole: false,
    exitOnCtrlC: false,
  }
);

// Wait for Ink to fully unmount (triggered by App calling exit()),
// then restore the terminal and exit cleanly.
app.waitUntilExit().then(() => {
  restoreTerminal();
  console.log("\nLumiverse stopped. Goodbye!");
  process.exit(0);
});

// ─── Signal handlers ─────────────────────────────────────────────────────────
// These fire when the process receives external signals (e.g. terminal close).
// Kill the server synchronously, unmount Ink, restore TTY, then exit.

function handleSignal(): void {
  killServerProcess();
  app.unmount();
  restoreTerminal();
  process.exit(0);
}

process.on("SIGTERM", handleSignal);
process.on("SIGINT", handleSignal);

// Ensure terminal is always restored on unexpected errors
process.on("uncaughtException", (err) => {
  killServerProcess();
  restoreTerminal();
  console.error("Runner crashed (uncaught):", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  killServerProcess();
  restoreTerminal();
  console.error("Runner crashed (unhandled rejection):", reason);
  process.exit(1);
});
