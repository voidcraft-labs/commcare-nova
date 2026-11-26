// Prepare the code-only named BuildKit context for the final HQ round trip.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { sourceRevision } from "../lib/db/releasedConnectShape.mjs";

const { values } = parseArgs({
	options: {
		source: { type: "string" },
		output: { type: "string" },
		reader: { type: "string" },
		"reader-sha256": { type: "string" },
	},
});
if (
	!values.source ||
	!values.output ||
	Boolean(values.reader) !== Boolean(values["reader-sha256"])
)
	throw new Error(
		"Use --source <released checkout> --output <new private directory>. To reuse a verified reader, give its --reader and --reader-sha256.",
	);
const checkout = resolve(values.source);
const directory = resolve(values.output);
const reader = join(directory, "released.mjs");
const converter = join(directory, "convert.mjs");
const git = (...args) =>
	execFileSync("git", ["-C", checkout, ...args], {
		maxBuffer: 16 * 1024 * 1024,
	});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

await mkdir(directory, { mode: 0o700 });
try {
	const sourceTree = git("rev-parse", `${sourceRevision}^{tree}`)
		.toString()
		.trim();
	const sourceLockSha256 = sha(
		git("show", `${sourceRevision}:package-lock.json`),
	);
	if (values.reader) {
		const bytes = await readFile(values.reader);
		if (sha(bytes) !== values["reader-sha256"])
			throw new Error("The supplied decoder differs from its verified digest.");
		await writeFile(reader, bytes, { flag: "wx", mode: 0o600 });
	} else {
		execFileSync(
			process.execPath,
			[
				fileURLToPath(
					new URL("./build-deployment-fold-reader.mjs", import.meta.url),
				),
				"--source",
				checkout,
				"--revision",
				sourceRevision,
				"--private-workspaces",
				"--output",
				reader,
			],
			{ stdio: "inherit" },
		);
	}
	const entry = fileURLToPath(
		new URL("./migrations/step7-completion.ts", import.meta.url),
	);
	const bundle = await build({
		absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		target: "node24",
		format: "esm",
		write: false,
	});
	await writeFile(converter, bundle.outputFiles[0].contents, {
		flag: "wx",
		mode: 0o600,
	});
	const bytes = await readFile(reader);
	const released = await import(
		`data:text/javascript;base64,${bytes.toString("base64")}`
	);
	if (
		released.sourceRevision !== sourceRevision ||
		released.sourceTree !== sourceTree ||
		released.sourceLockSha256 !== sourceLockSha256 ||
		![
			"readHead",
			"readReference",
			"releasedLookups",
			"privateBase",
			"privateStep",
			"privateOverlay",
		].every((name) => typeof released[name] === "function")
	)
		throw new Error(
			"The selected decoder does not attest the released source and private authoring dialect.",
		);
	const manifest = {
		sourceRevision,
		sourceTree,
		sourceLockSha256,
		reader: { path: "released.mjs", sha256: sha(bytes) },
		converter: { path: "convert.mjs", sha256: sha(await readFile(converter)) },
	};
	await writeFile(
		join(directory, "artifacts.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	console.log(JSON.stringify(manifest));
} catch (error) {
	await rm(directory, { recursive: true, force: true });
	throw error;
}
