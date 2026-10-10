# CyberChef

Local [stdio](https://modelcontextprotocol.io) MCP server for [CyberChef](https://gchq.github.io/CyberChef) 11.5.0. Every operation stays callable through `run_operation` and `bake`. The default tool list stays small. A category, or a named list of operations, can be mounted as individual tools for the rest of the session.

## Requirements

- Node.js `>=24 <27`

## Cursor

Node.js 24 or 25 is required. Add this to `.cursor/mcp.json` or the user MCP config:

```json
{
  "mcpServers": {
    "cyberchef": {
      "command": "npx",
      "args": ["-y", "@zebbern/cyberchef"]
    }
  }
}
```

Leave the environment unset and CyberChef's Networking operations stay available. Set `CYBERCHEF_ALLOW_NETWORK` to `false` to keep them listed while refusing to run them. `CYBERCHEF_TIMEOUT_MS`, `CYBERCHEF_MAGIC_TIMEOUT_MS`, and `CYBERCHEF_RECIPE_PATH` go in the same `env` object when you want a value other than the default.

```json
{
  "mcpServers": {
    "cyberchef": {
      "command": "npx",
      "args": ["-y", "@zebbern/cyberchef"],
      "env": {
        "CYBERCHEF_ALLOW_NETWORK": "false"
      }
    }
  }
}
```

## Development

```bash
npm install
npm test
npm start
```

`npm install` downloads CyberChef 11.5.0 without running its Grunt postinstall, then applies the Node API patches. Do not install this package with `--ignore-scripts`.

To run this checkout from Cursor before it is published, point `command` at Node and `args` at `src/index.ts` in this folder.

## Tools

These tools are registered at startup and are never removed:

| Tool | Purpose |
| --- | --- |
| `list_categories` | Category names and operation counts. Names match without case sensitivity. |
| `search_operations` | Full catalog, including Networking and Node API exclusions. Each hit has `name`, `category`, `description`, and `available`. |
| `describe_operation` | CyberChef help record: description, input type, output type, and arguments. |
| `run_operation` | Run one operation by name with `args`. |
| `bake` | Run a `{ op, args }` recipe, including a recipe returned by `load_recipe` or saved from the web app. |
| `save_recipe` / `load_recipe` | Store a named recipe on disk and return it later. Loading ignores case. Pass the loaded `recipe` array to `bake`. |
| `list_recipes` / `delete_recipe` | List saved names, or remove one. |
| `magic` | Magic, with depth, intensive mode, extensive language support, and a crib. |
| `enable_category` / `disable_category` | Mount or unmount every operation in a category. |
| `enable_operations` / `disable_operations` | Mount or unmount an explicit name list. |

Mounted tools are named `cc_` plus a slug of the operation name. The description includes the category. Disabling a category removes only those mounted tools. `run_operation` and `bake` still accept the same operation names.

`run_operation`, `bake`, and `magic` take either `input` plus `inputEncoding` (`utf8`, `base64`, or `hex`), or `inputPath`. `inputPath` may be a file or a folder. A folder runs the same recipe on each file inside it, including nested files, up to 200 files. `outputPath` writes the raw bytes: a file path when the input is one value, or a folder when the input is a folder. The copy-to-clipboard button in the CyberChef web app has no server equivalent. The tool result is the raw output.

## Saved recipes

`save_recipe` writes `~/.cyberchef/recipes.json`. Set `CYBERCHEF_RECIPE_PATH` to use a different file. `load_recipe` returns the stored `{ op, args }` list. `bake` runs that list; it does not read the file itself.

## Timeouts

Execution runs in a worker thread. The timeout terminates that worker.

- `CYBERCHEF_TIMEOUT_MS` for `bake` and `run_operation` (default `30000`)
- `CYBERCHEF_MAGIC_TIMEOUT_MS` for `magic` (default `60000`)

## Tests

```bash
npm test
```

## License

Apache-2.0. CyberChef is Crown copyright and is also Apache-2.0.
