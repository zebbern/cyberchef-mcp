# Install

Node.js 24 or 25.

**Claude Code:**

```bash
claude mcp add cyberchef -- npx -y @zebbern/cyberchef
```

**Codex CLI:**

```bash
codex mcp add cyberchef -- npx -y @zebbern/cyberchef
```

**Any MCP client** (Claude Desktop, Cursor, Kimi, and others). Paste this next to the servers already in the file:

```json
"cyberchef": {
  "command": "npx",
  "args": ["-y", "@zebbern/cyberchef"]
}
```

This entry sets every variable. `CYBERCHEF_ALLOW_NETWORK` set to `false` keeps Networking operations listed and refuses to run them. The other three values are the defaults.

```json
"cyberchef": {
  "command": "npx",
  "args": ["-y", "@zebbern/cyberchef"],
  "env": {
    "CYBERCHEF_ALLOW_NETWORK": "false",
    "CYBERCHEF_TIMEOUT_MS": "30000",
    "CYBERCHEF_MAGIC_TIMEOUT_MS": "60000",
    "CYBERCHEF_RECIPE_PATH": "~/.cyberchef/recipes.json"
  }
}
```
