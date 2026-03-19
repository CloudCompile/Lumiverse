import { useState, useCallback, useRef } from "react";
import { CONFIRMATION_TIMEOUT_MS } from "../lib/constants.js";

export interface PendingConfirmation {
  type: string;
  target?: string;
}

export interface ConfirmationApi {
  pending: PendingConfirmation | null;
  /**
   * Request a confirmation. Returns `true` if this is the second press
   * (confirmed), `false` if this is the first press (now pending).
   */
  request: (type: string, target?: string) => boolean;
  cancel: () => void;
}

export function useConfirmation(
  timeoutMs: number = CONFIRMATION_TIMEOUT_MS,
  onTimeout?: (type: string) => void
): ConfirmationApi {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track pending in a ref so the timeout callback sees current value
  const pendingRef = useRef<PendingConfirmation | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    setPending(null);
  }, []);

  const request = useCallback(
    (type: string, target?: string): boolean => {
      const current = pendingRef.current;

      if (
        current?.type === type &&
        (!target || current.target === target)
      ) {
        // Second press — confirmed
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        pendingRef.current = null;
        setPending(null);
        return true;
      }

      // First press — start confirmation timer
      const newPending = { type, target };
      pendingRef.current = newPending;
      setPending(newPending);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const cancelledType = pendingRef.current?.type;
        pendingRef.current = null;
        setPending(null);
        if (cancelledType && onTimeout) onTimeout(cancelledType);
      }, timeoutMs);

      return false;
    },
    [timeoutMs, onTimeout]
  );

  return { pending, request, cancel };
}
