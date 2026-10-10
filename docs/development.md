# Development

```bash
npm install
npm test
npm start
```

`npm install` downloads CyberChef 11.5.0 without running its Grunt postinstall, then applies the Node API patches. Do not install this package with `--ignore-scripts`.

`npm start` runs this checkout through `src/index.ts`. `npm test` is `node:test`. `node scripts/export-docs.mjs` rewrites [tools.json](tools.json) and [operations.json](operations.json).

To point a client at this folder before publish, use `node` as the command and `src/index.ts` in this folder as the argument. The published command is in [Install](install.md).

`npm run build` writes `dist/`. `npm publish` runs that build first. The published command is `dist/index.js`.
