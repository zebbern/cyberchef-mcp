# Configuration

Set these on the `env` object of the `cyberchef` entry in [Install](install.md). Unset means the default.

| Variable | Default | Effect |
| --- | --- | --- |
| `CYBERCHEF_ALLOW_NETWORK` | allowed | `false` keeps Networking operations in search and makes `run_operation` and `bake` refuse them. |
| `CYBERCHEF_TIMEOUT_MS` | `30000` | Time limit for `bake` and `run_operation`. The worker is terminated when it elapses. |
| `CYBERCHEF_MAGIC_TIMEOUT_MS` | `60000` | Time limit for `magic`. The worker is terminated when it elapses. |
| `CYBERCHEF_RECIPE_PATH` | `~/.cyberchef/recipes.json` | File used by `save_recipe`, `load_recipe`, `list_recipes`, and `delete_recipe`. |
