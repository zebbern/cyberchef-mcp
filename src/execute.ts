import { Worker } from "node:worker_threads";
import { ChefInputError, ChefTimeoutError } from "./errors.ts";
import { assertRunnable } from "./catalog.ts";
import {
  isInputEncoding,
  type EncodedOutput,
  type InputEncoding,
  type RecipeStep,
  type WorkerControl,
  type WorkerJob,
  type WorkerResponse,
} from "./protocol.ts";

const LOAD_TIMEOUT_MS = 180_000;

type Pending = {
  id: number;
  timeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  resolve: (value: EncodedOutput) => void;
  reject: (error: Error) => void;
};

type Queued = {
  timeoutMs: number;
  pending: Pending;
  create: (id: number) => WorkerJob;
};

let worker: Worker | null = null;
let ready = false;
let pending: Pending | null = null;
let queue: Queued[] = [];
let seq = 0;
let loadTimer: ReturnType<typeof setTimeout> | null = null;
let lastExit: { threadId: number; code: number } | null = null;

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function bakeTimeoutMs(): number {
  return positiveEnv("CYBERCHEF_TIMEOUT_MS", 30_000);
}

export function magicTimeoutMs(): number {
  return positiveEnv("CYBERCHEF_MAGIC_TIMEOUT_MS", 60_000);
}

export function workerThreadId(): number | null {
  return worker?.threadId ?? null;
}

export function lastWorkerExit(): { threadId: number; code: number } | null {
  return lastExit;
}

function settleResolve(job: Pending, value: EncodedOutput) {
  if (job.settled) return;
  job.settled = true;
  if (job.timer) clearTimeout(job.timer);
  job.resolve(value);
}

function settleReject(job: Pending, error: Error) {
  if (job.settled) return;
  job.settled = true;
  if (job.timer) clearTimeout(job.timer);
  job.reject(error);
}

function failQueued(error: Error) {
  const jobs = queue.splice(0);
  for (const job of jobs) settleReject(job.pending, error);
  if (pending) {
    const current = pending;
    pending = null;
    settleReject(current, error);
  }
}

function clearLoadTimer() {
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
}

function onMessage(message: WorkerResponse | WorkerControl) {
  if (message && typeof message === "object" && "type" in message && message.type === "ready") {
    clearLoadTimer();
    if ("error" in message && message.error) {
      ready = false;
      failQueued(new Error(message.error));
      worker?.terminate();
      return;
    }
    ready = true;
    kick();
    return;
  }
  if (!message || typeof message !== "object" || !("id" in message) || !pending || message.id !== pending.id) return;
  const current = pending;
  pending = null;
  if (message.ok) settleResolve(current, message.result);
  else {
    const error = new Error(message.message);
    error.name = message.errorName ?? "Error";
    settleReject(current, error);
  }
  kick();
}

function onExit(exited: Worker, threadId: number, code: number) {
  lastExit = { threadId, code };
  clearLoadTimer();
  if (worker === exited) worker = null;
  ready = false;
  if (pending && !pending.settled) {
    const current = pending;
    pending = null;
    settleReject(current, new ChefTimeoutError(current.timeoutMs));
  }
  kick();
}

function spawn() {
  const created = new Worker(new URL("./worker.ts", import.meta.url));
  const threadId = created.threadId;
  created.unref();
  worker = created;
  ready = false;
  created.on("message", onMessage);
  created.on("error", (error) => {
    failQueued(error instanceof Error ? error : new Error(String(error)));
    ready = false;
    if (worker === created) worker = null;
    created.terminate();
  });
  created.on("exit", (code) => onExit(created, threadId, code));
  loadTimer = setTimeout(() => {
    failQueued(new Error("CyberChef worker did not finish loading."));
    created.terminate();
  }, LOAD_TIMEOUT_MS);
}

function kick() {
  if (pending || queue.length === 0) return;
  if (!worker) spawn();
  if (!ready || !worker) return;
  const job = queue.shift();
  if (!job || !worker) return;
  const id = ++seq;
  job.pending.id = id;
  pending = job.pending;
  job.pending.timer = setTimeout(() => {
    if (!pending || pending.id !== id || pending.settled) return;
    if (!worker) {
      const current = pending;
      pending = null;
      settleReject(current, new ChefTimeoutError(current.timeoutMs));
      return;
    }
    // Exit handler rejects the job after recording the terminated thread.
    worker.terminate();
  }, job.timeoutMs);
  worker.postMessage(job.create(id));
}

function enqueue(timeoutMs: number, create: (id: number) => WorkerJob): Promise<EncodedOutput> {
  return new Promise((resolve, reject) => {
    queue.push({
      timeoutMs,
      create,
      pending: { id: 0, timeoutMs, settled: false, resolve, reject },
    });
    kick();
  });
}

export function normaliseEncoding(value: unknown): InputEncoding {
  if (value === undefined) return "utf8";
  if (isInputEncoding(value)) return value;
  throw new ChefInputError('inputEncoding must be "utf8", "base64", or "hex".');
}

export async function runOperation(
  name: string,
  input: string,
  inputEncoding: InputEncoding = "utf8",
  args?: unknown,
  options?: { timeoutMs?: number },
): Promise<EncodedOutput> {
  const operation = assertRunnable(name);
  return enqueue(options?.timeoutMs ?? bakeTimeoutMs(), (id) => ({
    id,
    kind: "bake",
    input,
    inputEncoding,
    recipe: [{ op: operation.name, args }],
  }));
}

export async function bake(
  input: string,
  recipe: RecipeStep[],
  inputEncoding: InputEncoding = "utf8",
  options?: { timeoutMs?: number },
): Promise<EncodedOutput> {
  if (!Array.isArray(recipe)) {
    throw new ChefInputError("Recipe must be a list of { op, args } steps.");
  }
  const resolved = recipe.map((step) => {
    if (!step || typeof step.op !== "string") {
      throw new ChefInputError("Each recipe step needs an operation name.");
    }
    const operation = assertRunnable(step.op);
    return { op: operation.name, args: step.args };
  });
  return enqueue(options?.timeoutMs ?? bakeTimeoutMs(), (id) => ({
    id,
    kind: "bake",
    input,
    inputEncoding,
    recipe: resolved,
  }));
}

export async function magic(
  input: string,
  options?: {
    inputEncoding?: InputEncoding;
    depth?: number;
    intensive?: boolean;
    languageSupport?: boolean;
    crib?: string;
    timeoutMs?: number;
  },
): Promise<EncodedOutput> {
  return enqueue(options?.timeoutMs ?? magicTimeoutMs(), (id) => ({
    id,
    kind: "magic",
    input,
    inputEncoding: options?.inputEncoding ?? "utf8",
    depth: options?.depth ?? 3,
    intensive: options?.intensive ?? false,
    languageSupport: options?.languageSupport ?? false,
    crib: options?.crib ?? "",
  }));
}

export async function shutdownWorkers(): Promise<void> {
  queue = [];
  const current = worker;
  worker = null;
  ready = false;
  clearLoadTimer();
  if (pending) {
    const job = pending;
    pending = null;
    settleReject(job, new Error("CyberChef worker was shut down."));
  }
  if (current) await current.terminate();
}
