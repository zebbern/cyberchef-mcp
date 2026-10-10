import { z, type ZodRawShape, type ZodTypeAny } from "zod";

export type ChefArg = {
  name?: string;
  type?: string;
  value?: unknown;
  defaultIndex?: number;
  toggleValues?: unknown;
  hint?: string;
};

function defaultText(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value);
    return text ?? "undefined";
  } catch {
    return String(value);
  }
}

function choiceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const choices: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (/^\[.*\]$/.test(item)) continue;
      choices.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; value?: unknown };
    if (typeof record.name === "string") choices.push(record.name);
    else if (typeof record.value === "string") choices.push(record.value);
  }
  return [...new Set(choices)];
}

function defaultChoice(arg: ChefArg): string | undefined {
  const choices = choiceList(arg.value);
  if (choices.length === 0) return undefined;
  const index = typeof arg.defaultIndex === "number" ? arg.defaultIndex : 0;
  return choices[index] ?? choices[0];
}

function hint(arg: ChefArg): string {
  return arg.hint?.trim() || arg.name || "Argument";
}

function unknownField(arg: ChefArg): ZodTypeAny {
  const scalar = typeof arg.value === "string" || typeof arg.value === "number" || typeof arg.value === "boolean"
    ? arg.value
    : defaultChoice(arg);
  const shown = scalar !== undefined ? JSON.stringify(scalar) : defaultText(arg.value);
  const description = `CyberChef type: ${arg.type ?? "unknown"}. Default: ${shown}`;
  if (typeof scalar === "string") return z.string().default(scalar).describe(description);
  return z.string().describe(description);
}

/** Map one CyberChef argument onto a JSON-schema field. Unknown types stay as strings. */
export function chefArgToZod(arg: ChefArg): ZodTypeAny {
  const type = arg.type ?? "unknown";
  try {
    switch (type) {
      case "string":
      case "binaryString": {
        const value = typeof arg.value === "string" ? arg.value : "";
        return z.string().default(value).describe(hint(arg));
      }
      case "number": {
        const schema = z.number().describe(hint(arg));
        return typeof arg.value === "number" ? schema.default(arg.value) : schema;
      }
      case "boolean":
        return z.boolean().default(Boolean(arg.value)).describe(hint(arg));
      case "option": {
        const choices = choiceList(arg.value);
        if (choices.length === 0) return unknownField({ ...arg, type: "option" });
        const selected = defaultChoice(arg);
        const schema = z.enum(choices as [string, ...string[]]).describe(hint(arg));
        return selected && choices.includes(selected) ? schema.default(selected) : schema;
      }
      case "editableOption": {
        const suggestions = choiceList(arg.value);
        const selected = defaultChoice(arg) ?? (typeof arg.value === "string" ? arg.value : "");
        const listed = suggestions.length > 0 ? ` Suggestions: ${suggestions.join(", ")}.` : "";
        return z.string().default(selected).describe(`${hint(arg)}.${listed} Default: ${JSON.stringify(selected)}`);
      }
      case "toggleString": {
        const toggles = choiceList(arg.toggleValues);
        const stringDefault = typeof arg.value === "string" ? arg.value : "";
        const optionDefault = toggles[0] ?? "";
        const optionSchema = toggles.length > 0
          ? z.enum(toggles as [string, ...string[]]).default(optionDefault)
          : z.string().default(optionDefault);
        return z.object({
          option: optionSchema.describe("Selected toggle"),
          string: z.string().default(stringDefault),
        }).default({ option: optionDefault, string: stringDefault }).describe(hint(arg));
      }
      default:
        return unknownField(arg);
    }
  } catch {
    return unknownField(arg);
  }
}

export function operationInputShape(args: unknown): ZodRawShape {
  const shape: ZodRawShape = {
    input: z.string().optional().describe("Data for this operation. Omit when inputPath is set."),
    inputEncoding: z.enum(["utf8", "base64", "hex"]).default("utf8").describe(
      "How to decode input. utf8 is the default. Ignored when inputPath is set.",
    ),
    inputPath: z.string().optional().describe("File or folder to open as input. A folder runs this operation on each file, including nested files."),
    outputPath: z.string().optional().describe("File or folder where the raw output is written."),
  };
  const used = new Set(Object.keys(shape));
  if (!Array.isArray(args)) return shape;
  for (const entry of args) {
    if (!entry || typeof entry !== "object") continue;
    const arg = entry as ChefArg;
    if (typeof arg.name !== "string" || arg.name.length === 0) continue;
    let key = arg.name;
    let suffix = 2;
    while (used.has(key)) {
      key = `${arg.name}_${suffix}`;
      suffix += 1;
    }
    used.add(key);
    shape[key] = chefArgToZod(arg);
  }
  return shape;
}
