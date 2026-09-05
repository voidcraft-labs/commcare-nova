import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

async function runPhase(name, command, args, env = process.env) {
	const started = performance.now();
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			console.log(
				`NOVA_BUILD_PHASE ${JSON.stringify({ name, seconds: Number(((performance.now() - started) / 1000).toFixed(3)), code, signal })}`,
			);
			if (code === 0) resolve();
			else reject(new Error(`${name} failed (${signal || code})`));
		});
	});
}

async function removeSourceMaps(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) await removeSourceMaps(filename);
		else if (entry.isFile() && entry.name.endsWith(".map")) await rm(filename);
		else if (entry.isFile() && /\.(?:js|mjs|cjs|css)$/.test(entry.name)) {
			const source = await readFile(filename, "utf8");
			const stripped = source.replace(
				/\n?(?:\/\/[#@] sourceMappingURL=[^\n]+|\/\*[#@] sourceMappingURL=[^\n]+\*\/)$/,
				"",
			);
			if (stripped !== source) await writeFile(filename, stripped);
		}
	}
}

const hasSentryToken = Boolean(process.env.SENTRY_AUTH_TOKEN);
const release = process.env.NOVA_BUILD_ID;
const sentryEnvironment = {
	...process.env,
	NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "",
	SENTRY_ORG: "dimagi-1l",
	SENTRY_PROJECT: "nova",
};
// Match the Next SDK's manifest exclusions. These files have no source maps;
// the server-action manifest also carries private runtime configuration.
const sourceMapIgnores = [
	"**/page_client-reference-manifest.js",
	"**/server-reference-manifest.js",
	"**/next-font-manifest.js",
	"**/middleware-build-manifest.js",
	"**/interception-route-rewrite-manifest.js",
	"**/route_client-reference-manifest.js",
	"**/middleware-react-loadable-manifest.js",
];
const sentry = (name, args) =>
	runPhase(
		name,
		"sentry-cli",
		["--log-level", "warn", ...args],
		sentryEnvironment,
	);

// Native Turbopack debug IDs and maps are generated normally. Upload only
// after compilation and the independent native type check.
await runPhase("next", "next", ["build"], {
	...process.env,
	NEXT_TELEMETRY_DISABLED: "1",
	NOVA_DEFER_SENTRY_UPLOAD: "true",
	SENTRY_AUTH_TOKEN: "",
});
// Both are CPU-heavy on the default Cloud Build machine. Sequential execution
// avoids the measured contention penalty; the native checker persists its
// incremental state in the same private compiler cache.
await runPhase(
	"typecheck",
	"tsc",
	["--noEmit", "--project", "tsconfig.production.json"],
	{
		...process.env,
		SENTRY_AUTH_TOKEN: "",
		NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "",
	},
);
if (hasSentryToken) {
	if (!release) throw new Error("Sentry upload requires NOVA_BUILD_ID");
	await sentry("sentry-release", ["releases", "new", release]);
	// Native Turbopack maps already embed source content. Sentry's source-map
	// reader flattens indexed maps when symbolication needs it; doing so here
	// parses and re-encodes the entire source set a second time.
	await sentry("sentry-maps", [
		"sourcemaps",
		"upload",
		"--no-rewrite",
		"--release",
		release,
		...sourceMapIgnores.flatMap((pattern) => ["--ignore", pattern]),
		".next/server",
		".next/static",
	]);
	await sentry("sentry-finalize", ["releases", "finalize", release]);
}
// Never ship public source maps, including the standalone server copy made by
// Next before the upload. Keep compiler cache and dependency packages intact.
for (const directory of [
	".next/server",
	".next/static",
	".next/standalone/.next/server",
]) {
	await removeSourceMaps(directory);
}
