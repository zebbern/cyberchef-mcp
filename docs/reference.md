# Reference

Argument schemas for the 15 always-on tools are in [tools.json](tools.json). Every CyberChef operation, including argument names and types, is in [operations.json](operations.json). `node scripts/export-docs.mjs` rewrites both files from the server.

CyberChef 11.5.0, stdio. These tools stay registered for the whole session.

| Tool | Role |
| --- | --- |
| `list_categories` | Category names and operation counts. Matching ignores case, so `Data Format` matches `Data format`. |
| `search_operations` | Full catalog, including Networking and operations the Node API cannot run. Each hit has `name`, `category`, `description`, and `available`. |
| `describe_operation` | Description, input type, output type, and arguments. Unavailable operations are still described. |
| `run_operation` | One operation by name. `args` is a positional list or a named object. Omit `args` to use CyberChef's defaults. |
| `bake` | A `{ op, args }` recipe, including a list from `load_recipe` or a clean-JSON recipe saved in the web app. |
| `magic` | Magic. See below. |
| `specialist` | A short decode ladder. See below. |
| `save_recipe` / `load_recipe` | Store a named recipe and return it later. The name match ignores case. Saving the same name replaces the steps. |
| `list_recipes` / `delete_recipe` | List saved names and step counts, or remove one. |
| `enable_category` / `disable_category` | Mount or unmount every operation in a category as its own tool. |
| `enable_operations` / `disable_operations` | Mount or unmount an explicit name list. |

Mounted tools are named `cc_` plus a slug of the operation name. Disabling removes only those tools.

## Input and output

`run_operation`, `bake`, `magic`, `specialist`, and mounted tools take one of these:

- `input` plus `inputEncoding`: `utf8` (default), `base64`, or `hex`.
- `inputPath`: a file, or a folder. A folder runs the same operation or recipe on each file, including nested files, up to 200 files. File bytes are used as-is, so `inputEncoding` is ignored. A folder stops at `CYBERCHEF_FOLDER_TIMEOUT_MS`; the result keeps what ran, with `truncated: true` and `remainingFiles`.

Pass `input` or `inputPath`, not both.

`outputPath` writes the raw bytes. For one input it is a file path. For a folder it is a folder, and each result keeps its relative name. Binary results such as Gzip are written as bytes, not as the base64 text shown in the tool result.

The tool result is JSON. Valid UTF-8 is `encoding: "utf8"`. Anything else is `encoding: "base64"`. There is no clipboard. This process has no window.

## Recipes

`save_recipe` stores the same `{ op, args }` list that `bake` accepts. `load_recipe` returns that list. `bake` does not read the file itself. Pass the loaded `recipe` array on the later `bake` call. The input can change.

The default file is `~/.cyberchef/recipes.json`. A different path is [Configuration](configuration.md).

A name is a non-empty string without path separators.

## Magic

`depth` is how many decode steps Magic may chain. The default is `3`. The minimum is `0`.

`intensive` is Intensive mode. The default is `false`. It brute-forces more encodings and is slower.

`languageSupport` is extensive language support. The default is `false`.

`crib` is known plaintext or a regular expression used to keep matching results. The default is empty. A crib regex is matched against the first 10,000 characters of a candidate and stops after 250 ms.

## Specialist

`specialist` runs a short ladder and returns every attempt that produced output. With no prefix, the first attempt is Magic. Each later attempt bakes one undo operation, then runs Magic. The undo operations are From Base64, From Base32, From Base58, From Hex, URL Decode, From Quoted Printable, Gunzip, Zlib Inflate, and Raw Inflate. XOR Brute Force and ROT13 Brute Force run after those, without a following Magic step. Each one already returns a report of many keys.

A prefix is a recipe. It is baked once and stays on every attempt. The first attempt is that prefix, then Magic. An undo operation that is already the last prefix step is skipped. An unknown prefix operation fails the call. A later decoder that throws is skipped.

`maxAttempts` limits how many attempts run. Omit it to run the full ladder. `depth`, `intensive`, `languageSupport`, and `crib` are passed to every Magic call. The same crib is passed to the brute-force operations. A crib match stops the ladder. Magic returning a result is not itself a match. `hit` is true only when a candidate contains the crib.

The top-level `output`, `encoding`, and `type` are the winning candidate, so `outputPath` writes those bytes. `candidates` lists `rank`, `recipe`, `output`, `encoding`, `type`, and `matchedCrib`. `reason` is `crib` when a candidate matched the crib, otherwise `local`.

Local order puts a crib match first, then UTF-8 output that differs from the input, then the attempt order.

The ladder stops at `CYBERCHEF_SPECIALIST_TIMEOUT_MS`. The default is `180000`. Each Magic call uses the remaining time, capped by `CYBERCHEF_MAGIC_TIMEOUT_MS`. A folder runs the ladder on each file, up to 200 files.

Magic is a flow-control operation, so a candidate recipe that contains Magic cannot be passed to `bake`. Replay the earlier steps with `bake`, then call `magic`.

## Limits

Search still lists operations the Node API will not run. `available` is `false`, and `bake` or `run_operation` returns an error.

Flow control: Fork, Merge, Jump, Conditional Jump, Label, and Comment. A straight recipe does not need them. Fork splits input and runs the following steps on each piece. Merge joins those pieces. Label, Jump, and Conditional Jump move through the recipe. Comment does not change the data. Call `bake` once per piece instead of putting the branch inside the recipe.

Also unavailable: JavaScript Beautify, JavaScript Minify, JavaScript Parser, and Syntax highlighter.

Networking operations stay runnable unless [Configuration](configuration.md) turns them off. When they are off, search still returns them with `available: false`.
