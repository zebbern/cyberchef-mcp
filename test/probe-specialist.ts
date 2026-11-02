import { shutdownWorkers } from "../src/execute.ts";
import { specialist } from "../src/specialist.ts";

const plain = await specialist("aGk=", { maxAttempts: 2, depth: 0, crib: "hi" });
const prefixed = await specialist("dGVzdA==", {
  prefix: [{ op: "from base64" }],
  maxAttempts: 1,
  depth: 0,
  crib: "test",
});
const wrapped = await specialist("Njg2OQ==", {
  prefix: [{ op: "From Base64" }],
  maxAttempts: 4,
  depth: 0,
  crib: "hi",
});

console.log(JSON.stringify({
  plain: {
    hit: plain.hit,
    recipe: plain.recipe.map((step) => step.op),
    candidates: plain.candidates.map((candidate) => ({
      ops: candidate.recipe.map((step) => step.op),
      matched: candidate.matchedCrib,
      sample: candidate.output.slice(0, 80),
    })),
  },
  prefixed: {
    output: prefixed.output.slice(0, 600),
    recipe: prefixed.recipe.map((step) => step.op),
    hit: prefixed.hit,
    reason: prefixed.reason,
  },
  wrapped: {
    hit: wrapped.hit,
    reason: wrapped.reason,
    candidates: wrapped.candidates.map((candidate) => ({
      ops: candidate.recipe.map((step) => step.op),
      matched: candidate.matchedCrib,
      sample: candidate.output.slice(0, 160),
    })),
  },
}, null, 2));

await shutdownWorkers();
