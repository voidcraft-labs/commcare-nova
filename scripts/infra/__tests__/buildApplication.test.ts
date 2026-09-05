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

const script = resolve("scripts/build-app.mjs");

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
const append = (event) => fs.appendFileSync(process.env.NOVA_TEST_PHASE_LOG, JSON.stringify({name, args, event, hasSentry: Boolean(process.env.SENTRY_AUTH_TOKEN), hasActionKey: Boolean(process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)})+'\\n');
append('start');
if (name === 'next') {
 for (const directory of ['.next/server', '.next/static', '.next/standalone/.next/server']) {
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(directory+'/entry.js', 'globalThis.test = true;\\n//# sourceMappingURL=entry.js.map');
  fs.writeFileSync(directory+'/entry.js.map', '{}');
 }
}
setTimeout(() => {
 append('finish');
 if (name === process.env.NOVA_TEST_FAIL_PHASE && (name !== 'sentry-cli' || args.includes('upload'))) process.exit(9);
}, name === 'tsc' ? 150 : 5);
`,
			{ mode: 0o700 },
		);
	}
	return {
		directory,
		log,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			NOVA_TEST_PHASE_LOG: log,
			NOVA_BUILD_ID: "00000000-0000-0000-0000-000000000001",
			SENTRY_AUTH_TOKEN: "synthetic-token",
			NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "synthetic-action-key",
		},
	};
}

test("source-map upload follows the type check and maps leave the image only after success", () => {
	const f = fixture();
	try {
		const result = spawnSync(process.execPath, [script], {
			cwd: f.directory,
			env: f.env,
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		const events = readFileSync(f.log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const index = (name: string, event: string) =>
			events.findIndex((item) => item.name === name && item.event === event);
		expect(index("next", "finish")).toBeLessThan(index("tsc", "start"));
		expect(index("tsc", "finish")).toBeLessThan(index("sentry-cli", "start"));
		expect(events.find((item) => item.name === "next")).toMatchObject({
			hasSentry: false,
			hasActionKey: true,
		});
		expect(events.find((item) => item.name === "tsc")).toMatchObject({
			hasSentry: false,
			hasActionKey: false,
		});
		expect(events.find((item) => item.name === "sentry-cli")).toMatchObject({
			hasSentry: true,
			hasActionKey: false,
		});
		const upload = events.find((item) => item.args.includes("upload"));
		expect(upload.args).toContain("**/server-reference-manifest.js");
		expect(upload.args).toContain("--no-rewrite");
		for (const directory of [
			".next/server",
			".next/static",
			".next/standalone/.next/server",
		]) {
			expect(existsSync(join(f.directory, directory, "entry.js.map"))).toBe(
				false,
			);
			expect(
				readFileSync(join(f.directory, directory, "entry.js"), "utf8"),
			).not.toContain("sourceMappingURL");
		}
	} finally {
		rmSync(f.directory, { recursive: true, force: true });
	}
});

test.each(["tsc", "sentry-cli"])(
	"a failed %s phase refuses the artifact without finalizing the release",
	(phase) => {
		const f = fixture();
		try {
			const result = spawnSync(process.execPath, [script], {
				cwd: f.directory,
				env: { ...f.env, NOVA_TEST_FAIL_PHASE: phase },
				encoding: "utf8",
			});
			expect(result.status).not.toBe(0);
			expect(existsSync(join(f.directory, ".next/static/entry.js.map"))).toBe(
				true,
			);
			const events = readFileSync(f.log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(
				events.some((item) => item.name === "tsc" && item.event === "finish"),
			).toBe(true);
			expect(events.some((item) => item.args.includes("finalize"))).toBe(false);
		} finally {
			rmSync(f.directory, { recursive: true, force: true });
		}
	},
);
