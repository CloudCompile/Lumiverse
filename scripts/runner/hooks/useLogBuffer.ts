import { useState, useCallback, useRef } from "react";
import { MAX_LOG_LINES, LOG_BATCH_INTERVAL_MS } from "../lib/constants.js";

export type LogSource = "stdout" | "stderr" | "system";

export interface LogEntry {
  timestamp: string;
  source: LogSource;
  text: string;
}

function formatTimestamp(date: Date): string {
  return (
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0") +
    ":" +
    String(date.getSeconds()).padStart(2, "0")
  );
}

export interface LogBufferApi {
  logs: LogEntry[];
  scrollOffset: number;
  addLog: (text: string, source?: LogSource) => void;
  clearLogs: () => void;
  scrollUp: (amount?: number) => void;
  scrollDown: (amount?: number) => void;
  pageUp: (pageSize: number) => void;
  pageDown: (pageSize: number) => void;
  scrollToTop: () => void;
  scrollToEnd: () => void;
}

export function useLogBuffer(maxLines: number = MAX_LOG_LINES): LogBufferApi {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Track log count in a ref so scroll callbacks stay stable
  const logCountRef = useRef(0);
  logCountRef.current = logs.length;

  // Batching: accumulate log entries, flush on a timer
  const pendingRef = useRef<LogEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPending = useCallback(() => {
    timerRef.current = null;
    const batch = pendingRef.current;
    if (batch.length === 0) return;
    pendingRef.current = [];

    setLogs((prev) => {
      const updated = [...prev, ...batch];
      return updated.length > maxLines ? updated.slice(-maxLines) : updated;
    });
  }, [maxLines]);

  const addLog = useCallback(
    (text: string, source: LogSource = "stdout") => {
      const timestamp = formatTimestamp(new Date());
      const lines = text.split("\n");

      for (const line of lines) {
        if (line.trim() === "") continue;
        pendingRef.current.push({ timestamp, source, text: line });
      }

      if (!timerRef.current) {
        timerRef.current = setTimeout(flushPending, LOG_BATCH_INTERVAL_MS);
      }
    },
    [flushPending]
  );

  const clearLogs = useCallback(() => {
    pendingRef.current = [];
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setLogs([]);
    setScrollOffset(0);
  }, []);

  const scrollUp = useCallback(
    (amount: number = 1) => {
      setScrollOffset((prev) =>
        Math.min(prev + amount, Math.max(0, logCountRef.current - 1))
      );
    },
    []
  );

  const scrollDown = useCallback((amount: number = 1) => {
    setScrollOffset((prev) => Math.max(0, prev - amount));
  }, []);

  const pageUp = useCallback(
    (pageSize: number) => {
      setScrollOffset((prev) =>
        Math.min(prev + pageSize, Math.max(0, logCountRef.current - 1))
      );
    },
    []
  );

  const pageDown = useCallback((pageSize: number) => {
    setScrollOffset((prev) => Math.max(0, prev - pageSize));
  }, []);

  const scrollToTop = useCallback(() => {
    setScrollOffset(Math.max(0, logCountRef.current - 1));
  }, []);

  const scrollToEnd = useCallback(() => {
    setScrollOffset(0);
  }, []);

  return {
    logs,
    scrollOffset,
    addLog,
    clearLogs,
    scrollUp,
    scrollDown,
    pageUp,
    pageDown,
    scrollToTop,
    scrollToEnd,
  };
}
