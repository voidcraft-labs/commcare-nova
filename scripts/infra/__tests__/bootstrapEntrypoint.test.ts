import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, test } from "vitest";

let directory: string;
beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "nova-bootstrap-cli-"));
	const fixture = join(directory, "services.cjs");
	writeFileSync(
		fixture,
		`
const {appendFileSync} = require('node:fs');
function event(name) { appendFileSync(process.env.NOVA_TEST_LOG, name+'\\n'); }
exports.AuthTypes = { PASSWORD: 'password' };
exports.IpAddressTypes = { PUBLIC: 'public' };
exports.Connector = class {
  constructor() { event('connector'); }
  async getOptions() {
    event('options');
    if (process.env.NOVA_TEST_FAILURE === 'options') throw Error('options failure');
    return {};
  }
  close() { event('connector-close'); }
};
exports.Client = class {
  constructor() { event('client'); }
  async connect() { event('connect'); throw Error('connect failure'); }
  async end() { event('client-end'); throw Error('end failure'); }
};
`,
	);
	await build({
		entryPoints: ["scripts/infra/bootstrap-database-owner.ts"],
		outfile: join(directory, "bootstrap.cjs"),
		bundle: true,
		platform: "node",
		format: "cjs",
		alias: { "@google-cloud/cloud-sql-connector": fixture, pg: fixture },
	});
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test.each([
	{
		name: "help",
		args: ["--help"],
		user: "",
		password: "",
		failure: "",
		status: 0,
		error: "",
		events: [],
	},
	{
		name: "unknown argument",
		args: ["--oops"],
		user: "",
		password: "",
		failure: "",
		status: 1,
		error: "Unknown option",
		events: [],
	},
	{
		name: "missing user",
		args: [],
		user: "",
		password: "fake-password",
		failure: "",
		status: 1,
		error: "NOVA_DB_BOOTSTRAP_USER is missing",
		events: [],
	},
	{
		name: "missing password",
		args: [],
		user: "fake-user",
		password: "",
		failure: "",
		status: 1,
		error: "NOVA_DB_BOOTSTRAP_PASSWORD is missing",
		events: [],
	},
	{
		name: "connector failure",
		args: [],
		user: "fake-user",
		password: "fake-password",
		failure: "options",
		status: 1,
		error: "options failure",
		events: ["connector", "options", "connector-close"],
	},
	{
		name: "connection failure and teardown failure",
		args: ["--apply"],
		user: "fake-user",
		password: "fake-password",
		failure: "",
		status: 1,
		error: "connect failure",
		events: [
			"connector",
			"options",
			"client",
			"connect",
			"client-end",
			"connector-close",
		],
	},
])(
	"$name owns every created resource and validates local input first",
	({ args, user, password, failure, status, error, events }) => {
		const log = join(directory, "events.log");
		writeFileSync(log, "");
		const result = spawnSync(
			process.execPath,
			[join(directory, "bootstrap.cjs"), ...args],
			{
				encoding: "utf8",
				timeout: 5_000,
				env: {
					NODE_ENV: "test",
					PATH: process.env.PATH,
					NOVA_DB_BOOTSTRAP_USER: user,
					NOVA_DB_BOOTSTRAP_PASSWORD: password,
					NOVA_TEST_LOG: log,
					NOVA_TEST_FAILURE: failure,
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(status);
		expect(result.stderr).toContain(error);
		expect(result.stderr).not.toContain("fake-password");
		expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(
			events,
		);
	},
);
