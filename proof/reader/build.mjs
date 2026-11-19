// Builds the reader bundle the proof lane's judges run:
//
//   node proof/reader/build.mjs --out DIR
//
// writes into DIR:
//
// - reader.mjs: `proof/reader/cli.ts` with everything it imports in one ESM
//   file for the image's Node, but sharp, the native addon Nova's media
//   validation judges a picture with (`lib/media/validate.ts`);
// - reader.json: { "sha256": <of reader.mjs>, "esbuild": <its version>,
//   "node": <.nvmrc> };
// - node_modules/: sharp's runtime as this checkout's install holds it, every
//   package sharp loads (its JavaScript, its dependencies, and the binding
//   and libvips npm installed for this platform), file for file, at the paths
//   they have under the checkout's node_modules/, so the bundle's
//   `require("sharp")` resolves to them beside it and a lane shard, which
//   mounts no node_modules, judges a file with the sharp and libvips
//   production's package-lock.json names;
// - runtime.json: { "platform": <sharp's name for this platform>,
//   "versions": <sharp.versions of the runtime loaded from DIR>, "packages":
//   { <path>: <version> }, "files": { <path>: <sha256> } }, every file of
//   node_modules/ by its path under DIR.
//
// reader.mjs and reader.json name no platform. The runtime is the one npm
// installed for the machine the build runs on, so node_modules/ and
// runtime.json differ between architectures, and `proof/ci/products.mjs`
// compares them by what they are (sharp's packages at one version each,
// libvips and its libraries at one version each) rather than by their bytes.
// Two builds of one checkout on one machine write the same bytes: nothing in
// the call names a path, a time or the machine, no source map or comment
// carries one, and the runtime is copied as the install holds it.
// CI's proof-corpus job runs it through `python3 -m proof.native.produce`,
// and the corpus carries DIR as `native/reader/`.

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MODULES = "node_modules";
/** The native addon the bundle leaves out and carries beside itself. */
const RUNTIME = "sharp";

function outDirectory(argv) {
	const [flag, out, ...rest] = argv;
	if (flag !== "--out" || out === undefined || rest.length > 0) {
		throw new Error(
			"build.mjs takes --out DIR, the directory reader.mjs and reader.json are written into.",
		);
	}
	return resolve(out);
}

/**
 * sharp is a native addon, and Nova's media validation imports it at the
 * top of its module (`lib/media/validate.ts`). In the bundle it is required
 * on its first call instead, through the banner's `require`, which resolves
 * it from the bundle's own directory: the runtime this build copies there.
 * So a reading that judges no picture never loads it.
 */
const sharpOnFirstCall = {
	name: "sharp-on-first-call",
	setup(builder) {
		// The stand-in's own `require("sharp")` stays a require of the package at
		// run time; every other import of sharp is the stand-in.
		builder.onResolve({ filter: /^sharp$/ }, (args) =>
			args.namespace === "sharp-on-first-call"
				? { path: "sharp", external: true }
				: { path: "sharp", namespace: "sharp-on-first-call" },
		);
		builder.onLoad({ filter: /.*/, namespace: "sharp-on-first-call" }, () => ({
			contents: [
				"let loaded;",
				"export default function sharp(...args) {",
				'\tloaded ??= require("sharp");',
				"\treturn loaded(...args);",
				"}",
			].join("\n"),
			loader: "js",
		}));
	},
};

/** `path` relative to `root`, in / form. */
function posix(root, path) {
	return relative(root, path).split(sep).join("/");
}

function packageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

/**
 * The directory of the package `name` as Node resolves it from `from`: the
 * nearest `node_modules/<name>` holding a package.json, from `from` up to
 * the checkout's root and no further; null where none does.
 */
function packageDirectory(name, from) {
	for (let at = from; ; at = dirname(at)) {
		const candidate = join(at, MODULES, name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (resolve(at) === resolve(ROOT)) return null;
	}
}

/**
 * Every package sharp loads, as this checkout's install holds it: sharp, and
 * each dependency it and they name, each resolved as Node resolves it from
 * the package that names it. An optional dependency npm did not install
 * here (another platform's binding) is not one. Sorted by path.
 */
function runtimePackages() {
	const start = packageDirectory(RUNTIME, ROOT);
	if (start === null)
		throw new Error(
			`The reader bundle carries ${RUNTIME}, Nova's image reader, beside itself, and this checkout's node_modules holds no ${RUNTIME}. Run npm ci, then build again.`,
		);
	const found = new Map();
	const pending = [start];
	while (pending.length > 0) {
		const directory = pending.shift();
		if (found.has(directory)) continue;
		const manifest = packageJson(directory);
		found.set(directory, manifest);
		const named = [
			...Object.keys(manifest.dependencies ?? {}).map((name) => [name, true]),
			...Object.keys(manifest.optionalDependencies ?? {}).map((name) => [
				name,
				false,
			]),
		];
		for (const [name, required] of named) {
			const dependency = packageDirectory(name, directory);
			if (dependency !== null) pending.push(dependency);
			else if (required)
				throw new Error(
					`${manifest.name} needs ${name}, and this checkout's node_modules holds none where Node would find it from ${posix(ROOT, directory)}. Run npm ci, then build again.`,
				);
		}
	}
	return [...found]
		.map(([directory, manifest]) => ({
			path: posix(ROOT, directory),
			directory,
			version: manifest.version,
		}))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Every file of the package in `directory`, as [its path under the
 * checkout's root, its absolute path], sorted. A nested node_modules is
 * another package's, which `runtimePackages` names where sharp loads it.
 */
function packageFiles(directory) {
	const files = [];
	const walk = (at) => {
		for (const name of readdirSync(at).sort()) {
			const path = join(at, name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				if (name !== MODULES) walk(path);
			} else if (stat.isFile()) {
				files.push([posix(ROOT, path), path]);
			} else {
				throw new Error(
					`${posix(ROOT, path)} is neither a file nor a directory, and the reader bundle copies sharp's runtime file for file. Reinstall the package (npm ci), then build again.`,
				);
			}
		}
	};
	walk(directory);
	return files;
}

/** Copies sharp's runtime into `out` (see the header) and returns runtime.json's content. */
async function copyRuntime(out) {
	const packages = runtimePackages();
	const files = {};
	for (const one of packages) {
		for (const [path, source] of packageFiles(one.directory)) {
			const bytes = readFileSync(source);
			const target = join(out, path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, bytes);
			files[path] = createHash("sha256").update(bytes).digest("hex");
		}
	}
	// The runtime as the bundle loads it: from beside reader.mjs, so a copy that
	// lacks a file the binding links against fails here, by name, and not in a
	// shard at the first picture it judges.
	const fromOut = createRequire(join(out, "reader.mjs"));
	const loaded = fromOut.resolve(RUNTIME);
	if (!loaded.startsWith(`${realpathSync(out)}${sep}`))
		throw new Error(
			`${RUNTIME} resolves to ${loaded} from the reader bundle's directory, which is not the copy beside it.`,
		);
	let sharp;
	try {
		sharp = fromOut(RUNTIME);
	} catch (error) {
		throw new Error(
			`The copy of ${RUNTIME} beside the reader bundle does not load (${error instanceof Error ? error.message : String(error)}). Every package it loads is copied from this checkout's node_modules; look at what npm installed for this platform.`,
		);
	}
	const platform = fromOut(
		join(out, MODULES, RUNTIME, "dist", "libvips.cjs"),
	).runtimePlatformArch();
	const versions = Object.fromEntries(
		Object.entries(sharp.versions).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		),
	);
	return {
		platform,
		versions,
		packages: Object.fromEntries(
			packages.map((one) => [one.path, one.version]),
		),
		files,
	};
}

const out = outDirectory(process.argv.slice(2));
await mkdir(out, { recursive: true });
// A runtime an earlier build left would stand beside this one's.
await rm(join(out, MODULES), { recursive: true, force: true });
await rm(join(out, "runtime.json"), { force: true });
const outfile = join(out, "reader.mjs");

await build({
	entryPoints: ["proof/reader/cli.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	// `server-only` resolves to its empty module, as a server-side script needs.
	conditions: ["react-server"],
	tsconfig: "tsconfig.json",
	legalComments: "none",
	sourcemap: false,
	minify: false,
	charset: "utf8",
	absWorkingDir: ROOT,
	outfile,
	// An ESM bundle has no `require`, `__filename` or `__dirname`; the CommonJS
	// modules it carries read them while they load.
	banner: {
		js: [
			'import { createRequire as __readerCreateRequire } from "node:module";',
			'import { dirname as __readerDirname } from "node:path";',
			'import { fileURLToPath as __readerFileURLToPath } from "node:url";',
			"const require = __readerCreateRequire(import.meta.url);",
			"const __filename = __readerFileURLToPath(import.meta.url);",
			"const __dirname = __readerDirname(__filename);",
		].join("\n"),
	},
	plugins: [sharpOnFirstCall],
	logLevel: "warning",
});

const bytes = await readFile(outfile);
const node = (await readFile(join(ROOT, ".nvmrc"), "utf8")).trim();
await writeFile(
	join(out, "reader.json"),
	`${JSON.stringify(
		{
			sha256: createHash("sha256").update(bytes).digest("hex"),
			esbuild: version,
			node,
		},
		null,
		"\t",
	)}\n`,
);
await writeFile(
	join(out, "runtime.json"),
	`${JSON.stringify(await copyRuntime(out), null, "\t")}\n`,
);
