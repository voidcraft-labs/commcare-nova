import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

const script = resolve("scripts/build-app.mjs");
const stages = ["next", "tsc", "release", "upload", "finalize"];
const directories = [
	".next/server",
	".next/static",
	".next/standalone/.next/server",
];
const eventSchema = z.object({
	stage: z.string(),
	args: z.array(z.string()),
	event: z.enum(["start", "finish"]),
	hasSentry: z.boolean(),
	hasActionKey: z.boolean(),
	mapsPresent: z.boolean(),
});

// Run the production CLI. Stand-in external executables require the prior
// process's completed artifact, so parallelizing phases cannot pass by luck.
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "nova-build-application-"));
	const bin = join(directory, "bin");
	const log = join(directory, "phases.jsonl");
	mkdirSync(bin);
	for (const command of ["next", "tsc", "sentry-cli"]) {
		writeFileSync(
			join(bin, command),
			`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stage = name !== 'sentry-cli' ? name : args.includes('new') ? 'release' : args.includes('upload') ? 'upload' : 'finalize';
const stages = ['next', 'tsc', 'release', 'upload', 'finalize'];
const index = stages.indexOf(stage);
const append = (event) => fs.appendFileSync(process.env.NOVA_TEST_PHASE_LOG, JSON.stringify({stage, args, event, hasSentry: Boolean(process.env.SENTRY_AUTH_TOKEN), hasActionKey: Boolean(process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY), mapsPresent: fs.existsSync('.next/static/entry.js.map')})+'\\n');
append('start');
if (index > 0 && !fs.existsSync(stages[index - 1] + '.complete')) process.exit(8);
if (stage === 'next') {
 for (const directory of ['.next/server', '.next/static', '.next/standalone/.next/server', '.next/cache', '.next/standalone/node_modules/dependency']) {
  fs.mkdirSync(directory, {recursive: true});
  for (const extension of ['js', 'mjs', 'cjs', 'css']) {
   const content = extension === 'css' ? 'body { color: red; }' : 'globalThis.test = "sourceMappingURL=keep";';
   const marker = extension === 'css' ? '/*# sourceMappingURL=entry.css.map*/' : '//# sourceMappingURL=entry.' + extension + '.map';
   fs.writeFileSync(directory+'/entry.'+extension, content+'\\n'+marker+'\\n');
   fs.writeFileSync(directory+'/entry.'+extension+'.map', '{}');
  }
 }
}
if (stage === process.env.NOVA_TEST_FAIL_PHASE) process.exit(9);
fs.writeFileSync(stage + '.complete', 'complete');
append('finish');
`,
			{ mode: 0o700 },
		);
	}
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		NOVA_TEST_PHASE_LOG: log,
		NOVA_TEST_FAIL_PHASE: "",
		NOVA_BUILD_ID: "00000000-0000-0000-0000-000000000001",
		SENTRY_AUTH_TOKEN: "synthetic-token",
		NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "synthetic-action-key",
	};
	return {
		directory,
		env,
		run: (overrides: Partial<typeof env> = {}) =>
			spawnSync(process.execPath, [script], {
				cwd: directory,
				env: { ...env, ...overrides },
				encoding: "utf8",
				timeout: 10_000,
			}),
		events: () =>
			readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => eventSchema.parse(JSON.parse(line))),
		close: () => rmSync(directory, { recursive: true, force: true }),
	};
}

test("builds and typechecks before uploading and finalizing; then removes only shipped maps", () => {
	const f = fixture();
	try {
		const result = f.run();
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const events = f.events();
		expect(events.map(({ stage, event }) => `${stage}:${event}`)).toEqual(
			stages.flatMap((stage) => [`${stage}:start`, `${stage}:finish`]),
		);
		for (const event of events) {
			expect(event.hasSentry).toBe(!["next", "tsc"].includes(event.stage));
			expect(event.hasActionKey).toBe(event.stage === "next");
			if (event.stage !== "next") expect(event.mapsPresent).toBe(true);
		}
		const started = events.filter((event) => event.event === "start");
		expect(started[0].args).toEqual(["build"]);
		expect(started[1].args).toEqual([
			"--noEmit",
			"--project",
			"tsconfig.production.json",
		]);
		expect(started[2].args).toEqual([
			"--log-level",
			"warn",
			"releases",
			"new",
			f.env.NOVA_BUILD_ID,
		]);
		expect(started[3].args).toEqual(
			expect.arrayContaining([
				"sourcemaps",
				"upload",
				"--no-rewrite",
				"--release",
				f.env.NOVA_BUILD_ID,
				"**/server-reference-manifest.js",
				".next/server",
				".next/static",
			]),
		);
		expect(started[4].args).toEqual([
			"--log-level",
			"warn",
			"releases",
			"finalize",
			f.env.NOVA_BUILD_ID,
		]);
		for (const directory of directories) {
			for (const extension of ["js", "mjs", "cjs", "css"]) {
				expect(
					existsSync(join(f.directory, directory, `entry.${extension}.map`)),
				).toBe(false);
				expect(
					readFileSync(
						join(f.directory, directory, `entry.${extension}`),
						"utf8",
					).trim(),
				).toBe(
					extension === "css"
						? "body { color: red; }"
						: 'globalThis.test = "sourceMappingURL=keep";',
				);
			}
		}
		for (const directory of [
			".next/cache",
			".next/standalone/node_modules/dependency",
		]) {
			expect(existsSync(join(f.directory, directory, "entry.js.map"))).toBe(
				true,
			);
			expect(
				readFileSync(join(f.directory, directory, "entry.js"), "utf8"),
			).toContain("//# sourceMappingURL=entry.js.map");
		}
	} finally {
		f.close();
	}
});

test.each(stages)(
	"failure in %s stops subsequent phases and preserves maps",
	(stage) => {
		const f = fixture();
		try {
			const result = f.run({ NOVA_TEST_FAIL_PHASE: stage });
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(1);
			const expected = stages
				.slice(0, stages.indexOf(stage))
				.flatMap((name) => [`${name}:start`, `${name}:finish`]);
			expect(f.events().map(({ stage, event }) => `${stage}:${event}`)).toEqual(
				[...expected, `${stage}:start`],
			);
			for (const directory of directories)
				expect(existsSync(join(f.directory, directory, "entry.js.map"))).toBe(
					true,
				);
		} finally {
			f.close();
		}
	},
);

test("a local build without Sentry credentials still checks types and removes shipped maps", () => {
	const f = fixture();
	try {
		const result = f.run({ SENTRY_AUTH_TOKEN: "", NOVA_BUILD_ID: "" });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(
			f
				.events()
				.filter(({ event }) => event === "start")
				.map(({ stage }) => stage),
		).toEqual(["next", "tsc"]);
		for (const directory of directories)
			expect(existsSync(join(f.directory, directory, "entry.js.map"))).toBe(
				false,
			);
	} finally {
		f.close();
	}
});

test("upload without a release identity refuses before creating a release", () => {
	const f = fixture();
	try {
		const result = f.run({ NOVA_BUILD_ID: "" });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Sentry upload requires NOVA_BUILD_ID");
		expect(
			f
				.events()
				.filter(({ event }) => event === "start")
				.map(({ stage }) => stage),
		).toEqual(["next", "tsc"]);
		for (const directory of directories)
			expect(existsSync(join(f.directory, directory, "entry.js.map"))).toBe(
				true,
			);
	} finally {
		f.close();
	}
});
