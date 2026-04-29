import { warnBunWorkerFallback, shouldUseBunWorkers } from "../../utils/bun-worker-guard";
import { runHeuristicAnalysis } from "./heuristic-analysis";
import type {
  HeuristicAnalysisInput,
  HeuristicAnalysisOutput,
  HeuristicWorkerRequest,
  HeuristicWorkerResponse,
} from "./heuristic-runtime";

interface PendingRequest {
  resolve: (value: HeuristicAnalysisOutput) => void;
  reject: (reason?: unknown) => void;
}

class HeuristicWorkerHost {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL("./heuristic-worker.ts", import.meta.url).href, {
      type: "module",
    });

    worker.onmessage = (event: MessageEvent<HeuristicWorkerResponse>) => {
      const msg = event.data;
      if (!msg) return;
      const pending = this.pending.get(msg.requestId);
      if (!pending) return;
      this.pending.delete(msg.requestId);

      if (msg.type === "result") pending.resolve(msg.result);
      else pending.reject(new Error(msg.error));
    };

    worker.onerror = (event) => {
      const error = event instanceof ErrorEvent
        ? event.error ?? new Error(event.message)
        : new Error("Heuristic worker crashed");
      this.failAll(error);
      this.worker = null;
      try { worker.terminate(); } catch { /* noop */ }
    };

    this.worker = worker;
    return worker;
  }

  private failAll(error: unknown): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  run(payload: HeuristicAnalysisInput): Promise<HeuristicAnalysisOutput> {
    if (!shouldUseBunWorkers()) {
      warnBunWorkerFallback("memory-cortex heuristics");
      return Promise.resolve(runHeuristicAnalysis(payload));
    }

    const requestId = crypto.randomUUID();
    const worker = this.ensureWorker();
    const request: HeuristicWorkerRequest = { type: "run", requestId, payload };

    return new Promise<HeuristicAnalysisOutput>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage(request);
    });
  }
}

const host = new HeuristicWorkerHost();

export function runHeuristicAnalysisInWorker(payload: HeuristicAnalysisInput): Promise<HeuristicAnalysisOutput> {
  return host.run(payload);
}
