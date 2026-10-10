export const INPUT_ENCODINGS = ["utf8", "base64", "hex"] as const;

export type InputEncoding = (typeof INPUT_ENCODINGS)[number];

export type EncodedOutput = {
  output: string;
  encoding: "utf8" | "base64";
  type: string;
};

export type RecipeStep = {
  op: string;
  args?: unknown;
};

export type WorkerJob = {
  id: number;
  kind: "bake" | "magic";
  input: string;
  inputEncoding: InputEncoding;
  recipe?: RecipeStep[];
  depth?: number;
  intensive?: boolean;
  languageSupport?: boolean;
  crib?: string;
};

export type WorkerResponse =
  | { id: number; ok: true; result: EncodedOutput }
  | { id: number; ok: false; message: string; errorName?: string };

export type WorkerControl =
  | { type: "ready" }
  | { type: "ready"; error: string };

export function isInputEncoding(value: unknown): value is InputEncoding {
  return value === "utf8" || value === "base64" || value === "hex";
}
