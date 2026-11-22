// Produce a self-contained source decoder in release preparation, before the
// writer fence. The content-addressed artifact runs against raw rows only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFile,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { verifyStep6Reader } from "./lib/deployment-fold/step6-probe.mjs";

const { values } = parseArgs({
	options: {
		source: { type: "string" },
		revision: { type: "string" },
		output: { type: "string" },
	},
});
if (
	!values.source ||
	!/^[a-f0-9]{40}$/.test(values.revision ?? "") ||
	!values.output
)
	throw new Error(
		"Use --source <git checkout> --revision <full deployed commit> --output <private reader.mjs>.",
	);
const checkout = resolve(values.source),
	sourceRevision = values.revision,
	output = resolve(values.output);
const git = (args) =>
	execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
const sourceTree = git(["rev-parse", "--verify", `${sourceRevision}^{tree}`]);
const prefix = "scripts/lib/deploymentFoldReader.ts";
const bootstrap = sourceRevision === "3e16e43f8cfa56e485860f3345c81f5f9a68aec9";
const source = await mkdtemp(join(tmpdir(), "nova-fold-reader-"));
try {
	const tar = join(source, "source.tar");
	// Every module in this build comes from the selected Git object or its
	// checked-in npm lock. The state of the operator's checkout is immaterial.
	git([
		"archive",
		"--format=tar",
		"--output",
		tar,
		sourceRevision,
		"lib",
		"scripts",
		"config",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		".npmrc",
	]);
	execFileSync("tar", ["-xf", tar, "-C", source]);
	await rm(tar);
	const sourceLockSha256 = createHash("sha256")
		.update(await readFile(join(source, "package-lock.json")))
		.digest("hex");
	if (
		bootstrap &&
		sourceLockSha256 !==
			"9f207de56881079f6a730d1fb936c72d9295fd11e9e8d00467e7b4276a5d0857"
	)
		throw new Error(
			"Unexpected dependency lock for the pre-certificate source decoder.",
		);
	execFileSync(
		"npm",
		["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"],
		{ cwd: source, stdio: "inherit" },
	);
	let entry = join(source, prefix);
	if (bootstrap) {
		const referencePath = join(source, "lib/deployment/hqChanges/reference.ts");
		const { parse } = createRequire(join(source, "package.json"))(
			"@babel/parser",
		);
		const contents = await readFile(referencePath, "utf8");
		const file = parse(contents, {
			sourceType: "module",
			plugins: ["typescript"],
		});
		const removed = file.program.body.filter(
			(node) =>
				node.type === "ExportNamedDeclaration" &&
				node.declaration?.type === "FunctionDeclaration" &&
				["loadReferenceDocument", "usablePair"].includes(
					node.declaration.id?.name,
				),
		);
		if (removed.length !== 2)
			throw new Error(
				"Unexpected source layout in the pre-certificate decoder.",
			);
		let pure = contents;
		for (const node of removed.reverse())
			pure = pure.slice(0, node.start) + pure.slice(node.end);
		await writeFile(referencePath, pure);
		await appendFile(
			referencePath,
			"\nexport { actorsOf, foldServerRows, netRenames, withoutSecondOfASlug };\n",
		);
		entry = join(source, "scripts/lib/step6-reader.mjs");
		await copyFile(
			fileURLToPath(
				new URL("./lib/deployment-fold/step6-reader.mjs", import.meta.url),
			),
			entry,
		);
	}
	const { build } = createRequire(join(source, "package.json"))("esbuild");
	const result = await build({
		absWorkingDir: source,
		stdin: {
			contents: `export {readHead,readReference} from ${JSON.stringify(entry)};export const sourceRevision=${JSON.stringify(sourceRevision)},sourceTree=${JSON.stringify(sourceTree)},sourceLockSha256=${JSON.stringify(sourceLockSha256)};`,
			resolveDir: source,
			loader: "ts",
		},
		alias: { "@": source },
		tsconfig: join(source, "tsconfig.json"),
		bundle: true,
		platform: "node",
		target: "node24",
		format: "esm",
		conditions: ["react-server"],
		write: false,
		banner: {
			js: 'import {createRequire as __foldRequire} from "node:module"; const require=__foldRequire(process.execPath);',
		},
	});
	const bytes = result.outputFiles[0].contents;
	const reader = await import(
		`data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`
	);
	if (
		reader.sourceRevision !== sourceRevision ||
		reader.sourceTree !== sourceTree ||
		reader.sourceLockSha256 !== sourceLockSha256 ||
		typeof reader.readHead !== "function" ||
		typeof reader.readReference !== "function"
	)
		throw new Error("The bundled decoder does not match the selected source.");
	const probe = bootstrap ? verifyStep6Reader(reader) : undefined;
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
	console.log(
		JSON.stringify({
			sourceRevision,
			sourceTree,
			probe,
			reader: {
				path: output,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			sourceLockSha256,
		}),
	);
} finally {
	await rm(source, { recursive: true, force: true });
}
