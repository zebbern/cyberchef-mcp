import { parentPort } from "node:worker_threads";
import { Buffer } from "node:buffer";
import type { EncodedOutput, WorkerJob } from "./protocol.ts";

if (!parentPort) {
  throw new Error("CyberChef worker must be started as a worker thread.");
}

const port = parentPort;

type Dish = {
  type: number;
  get: (type: string) => unknown;
};

type Chef = {
  bake: (input: Buffer, recipe: unknown) => Promise<Dish>;
  magic: (input: Buffer, args: unknown) => Promise<Dish>;
  Dish: { enumLookup: (type: number) => string };
};

let chefPromise: Promise<Chef> | null = null;

function loadChef(): Promise<Chef> {
  if (!chefPromise) {
    chefPromise = (async () => {
      try {
        const log = await import("loglevel");
        log.default.setLevel("silent");
      } catch {
        // Silence is best-effort.
      }
      const imported = await import("cyberchef");
      return imported.default as Chef;
    })();
  }
  return chefPromise;
}

function decodeInput(input: string, encoding: WorkerJob["inputEncoding"]): Buffer {
  if (encoding === "base64") return Buffer.from(input, "base64");
  if (encoding === "hex") {
    const cleaned = input.replace(/\s+/g, "");
    if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) {
      throw new Error("input is not valid hex.");
    }
    return Buffer.from(cleaned, "hex");
  }
  return Buffer.from(input, "utf8");
}

function present(dish: Dish, lookup: (type: number) => string): EncodedOutput {
  let type = "unknown";
  try {
    type = lookup(dish.type);
  } catch {
    type = "unknown";
  }
  try {
    const raw = dish.get("ArrayBuffer");
    const bytes = Buffer.from(raw as ArrayBuffer);
    try {
      const output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { output, encoding: "utf8", type };
    } catch {
      return { output: bytes.toString("base64"), encoding: "base64", type };
    }
  } catch {
    try {
      const output = JSON.stringify(dish.get("JSON"));
      return { output, encoding: "utf8", type };
    } catch {
      return { output: "", encoding: "base64", type };
    }
  }
}

loadChef()
  .then(() => port.postMessage({ type: "ready" }))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: "ready", error: message });
  });

port.on("message", (message: WorkerJob) => {
  void (async () => {
    try {
      const chef = await loadChef();
      const bytes = decodeInput(message.input, message.inputEncoding);
      const dish = message.kind === "magic"
        ? await chef.magic(bytes, [
          message.depth ?? 3,
          message.intensive ?? false,
          message.languageSupport ?? false,
          message.crib ?? "",
        ])
        : await chef.bake(bytes, message.recipe ?? []);
      port.postMessage({ id: message.id, ok: true, result: present(dish, (type) => chef.Dish.enumLookup(type)) });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      port.postMessage({ id: message.id, ok: false, message: err.message, errorName: err.name });
    }
  })();
});
