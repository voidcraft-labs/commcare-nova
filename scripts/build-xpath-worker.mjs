import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = fileURLToPath(
	new URL("../public/xpath-worker/", import.meta.url),
);
const workerBuildId = process.env.NEXT_PUBLIC_NOVA_BUILD_ID?.trim() || "local";

/* This directory is generated exclusively by this script. Rebuild it as one
 * asset family so the stable entry never refers to a stale hashed
 * character-name chunk from a prior checkout. */
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
	entryPoints: {
		"xpath-worker": `${repositoryRoot}lib/preview/xpath/xpath.worker.ts`,
	},
	outdir: outputDirectory,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	minify: true,
	treeShaking: true,
	legalComments: "eof",
	/* Next inlines this public build identity in the host graph. The Worker is
	 * bundled by esbuild instead, so define the exact same value explicitly and
	 * let the runtime handshake detect a rolling-deploy mismatch. */
	define: {
		"process.env.NEXT_PUBLIC_NOVA_BUILD_ID": JSON.stringify(workerBuildId),
	},
	tsconfig: `${repositoryRoot}tsconfig.json`,
	entryNames: "[name]",
	chunkNames: "chunks/[name]-[hash]",
	logLevel: "silent",
});

const entryPath = `${outputDirectory}xpath-worker.js`;
const entrySource = await readFile(entryPath, "utf8");
const entryBytes = Buffer.byteLength(entrySource);
if (entryBytes > 450_000) {
	throw new Error(
		`XPath worker entry exceeds the 450 KB source cap: ${entryBytes}`,
	);
}
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(entrySource)) {
	throw new Error("XPath worker bundle violates Nova's CSP boundary.");
}

const chunkDirectory = `${outputDirectory}chunks`;
const chunks = await readdir(chunkDirectory);
for (const filename of chunks) {
	const info = await stat(`${chunkDirectory}/${filename}`);
	if (!info.isFile() || info.size > 500_000) {
		throw new Error(
			`XPath worker chunk is invalid: ${filename} (${info.size})`,
		);
	}
}

const digest = createHash("sha256").update(entrySource).digest("hex");
console.log(
	`xpath-worker sha256=${digest} bytes=${entryBytes} chunks=${chunks.length}`,
);
