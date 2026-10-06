import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

async function cpuMicroseconds() {
	for (const [file, divisor] of [
		["/sys/fs/cgroup/cpu.stat", 1],
		["/sys/fs/cgroup/cpuacct/cpuacct.usage", 1000],
		["/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage", 1000],
	]) {
		try {
			const value = await readFile(file, "utf8");
			const usage = file.endsWith("cpu.stat")
				? value.match(/^usage_usec (\d+)$/m)?.[1]
				: value.trim();
			if (usage) return Number(usage) / divisor;
		} catch {
			/* Local builds may not have Linux cgroup accounting. */
		}
	}
	return null;
}

async function runPhase(name, command, args, env = process.env) {
	const started = performance.now();
	const cpuStarted = await cpuMicroseconds();
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", async (code, signal) => {
			const cpuFinished = await cpuMicroseconds();
			const cpuSeconds =
				cpuStarted === null || cpuFinished === null
					? undefined
					: Number(((cpuFinished - cpuStarted) / 1_000_000).toFixed(3));
			console.log(
				`NOVA_BUILD_PHASE ${JSON.stringify({ name, seconds: Number(((performance.now() - started) / 1000).toFixed(3)), cpuSeconds, code, signal })}`,
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
				/\n?(?:\/\/[#@] sourceMappingURL=[^\n]+|\/\*[#@] sourceMappingURL=[^\n]+\*\/)[\r\n]*$/,
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
	SENTRY_LOG_LEVEL: "warn",
	// A build reports to Sentry only what it uploads on purpose.
	SENTRY_CLI_NO_TELEMETRY: "1",
	SENTRY_CLI_NO_UPDATE_CHECK: "1",
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
// `sentry` is the CLI the Sentry SDK depends on, reached by name from the
// package scripts' path. Nova declares no copy of its own, so the CLI moves
// with the SDK.
const sentry = (name, args) =>
	runPhase(name, "sentry", args, sentryEnvironment);

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
	// The command reads the project from its own flag, not the environment.
	await sentry("sentry-release", [
		"release",
		"create",
		release,
		"--project",
		sentryEnvironment.SENTRY_PROJECT,
	]);
	// Native Turbopack maps already embed source content and debug IDs. The
	// upload reads each file's ID to key its map, and leaves a file that has
	// one untouched; `--no-rewrite` would skip that read and upload maps no
	// event can be matched to. The command takes one directory per upload.
	for (const directory of [".next/server", ".next/static"]) {
		await sentry("sentry-maps", [
			"sourcemap",
			"upload",
			directory,
			"--release",
			release,
			"--ignore",
			sourceMapIgnores.join(","),
		]);
	}
	await sentry("sentry-finalize", ["release", "finalize", release]);
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
