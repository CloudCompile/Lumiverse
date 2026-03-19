import { useState, useEffect } from "react";

/**
 * Ticks once per second while active, forcing a re-render
 * for the uptime display in the header bar.
 */
export function useUptimeTicker(active: boolean): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;

    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [active]);

  return tick;
}
