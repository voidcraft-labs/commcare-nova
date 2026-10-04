// Rebuilds artifact.bundle.mjs: @actions/artifact at the version this
// directory's package-lock.json pins (the client upload-artifact@v7 and
// download-artifact@v8 run), with every dependency it loads, bundled into one
// ES module by the esbuild the same lock pins. The proof lane's CI scripts
// (proof/ci) import it, so a shard reaches the artifact service without an
// npm install.
//
// Usage, from the repository root (it needs node, npm and the npm registry,
// not Nova's node_modules):
//   node proof/ci/vendor/build.mjs           write the bundle
//   node proof/ci/vendor/build.mjs --check   rebuild it and compare it with the committed one
//
// It installs the locked packages (npm ci, no install scripts) into a
// temporary directory, so the result depends on the lock alone, and a bump
// of Nova's own esbuild leaves the bundle as it is; it removes that
// directory however the build ends. CI's quality job runs --check.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "artifact.bundle.mjs");
// What the CI scripts use (proof/ci/artifacts.mjs): the client.
const ENTRY = 'export { DefaultArtifactClient } from "@actions/artifact";\n';
// The bundle is an ES module; its CommonJS dependencies reach Node's built-ins through require.
const BANNER =
	'import { createRequire as __vendorCreateRequire } from "node:module";\n' +
	"const require = __vendorCreateRequire(import.meta.url);\n";

function run(command, args, cwd) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) resolveRun();
			else
				reject(
					new Error(
						`${command} ${args.join(" ")} exited ${code ?? signal} in ${cwd}; its output above says why.`,
					),
				);
		});
	});
}

async function build() {
	const scratch = await mkdtemp(join(tmpdir(), "proof-ci-vendor-"));
	let esbuild;
	try {
		await copyFile(join(here, "package.json"), join(scratch, "package.json"));
		await copyFile(
			join(here, "package-lock.json"),
			join(scratch, "package-lock.json"),
		);
		await run(
			"npm",
			["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
			scratch,
		);
		esbuild = createRequire(join(scratch, "package.json"))("esbuild");
		const result = await esbuild.build({
			stdin: {
				contents: ENTRY,
				resolveDir: scratch,
				sourcefile: "entry.mjs",
				loader: "js",
			},
			absWorkingDir: scratch,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node20",
			minify: true,
			legalComments: "eof",
			banner: { js: BANNER },
			write: false,
			logLevel: "warning",
		});
		return {
			bytes: Buffer.from(result.outputFiles[0].contents),
			esbuild: esbuild.version,
		};
	} finally {
		// esbuild's service runs from the scratch directory's binary: stop it before removing that.
		await esbuild?.stop();
		await rm(scratch, { recursive: true, force: true });
	}
}

const { bytes, esbuild } = await build();
const digest = createHash("sha256").update(bytes).digest("hex");
if (process.argv.includes("--check")) {
	const committed = await readFile(BUNDLE).catch(() => Buffer.alloc(0));
	if (!committed.equals(bytes)) {
		console.error(
			`The committed ${BUNDLE} is not what the lock and esbuild ${esbuild} build (sha256 ${digest}).\n` +
				"Rebuild it with `node proof/ci/vendor/build.mjs` and commit the result; it is generated and never edited.",
		);
		process.exit(1);
	}
	console.error(
		`The committed bundle is what the lock builds (esbuild ${esbuild}, sha256 ${digest}).`,
	);
} else {
	await writeFile(BUNDLE, bytes);
	console.error(
		`Wrote ${BUNDLE}: ${bytes.length} bytes, sha256 ${digest}, esbuild ${esbuild}.`,
	);
}
