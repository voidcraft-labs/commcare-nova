import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
	entryPoints: {
		worker: `${root}lib/agent/office.worker.ts`,
		process: `${root}lib/agent/officeProcess.ts`,
	},
	outdir: `${root}runtime/office`,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node24",
	banner: {
		js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
	},
	tsconfig: `${root}tsconfig.json`,
	logLevel: "warning",
});
