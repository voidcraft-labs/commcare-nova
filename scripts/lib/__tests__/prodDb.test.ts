import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

let directory: string;
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "nova-prod-target-"));
	const executable = join(directory, "gcloud");
	writeFileSync(
		executable,
		`#!${process.execPath}
const {appendFileSync} = require('node:fs');
appendFileSync(process.env.NOVA_TEST_LOG, JSON.stringify(process.argv.slice(2))+'\\n');
if(process.env.NOVA_TEST_ACCOUNT === 'fail') process.exit(1);
process.stdout.write(process.env.NOVA_TEST_ACCOUNT);
`,
	);
	chmodSync(executable, 0o755);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(
	account: string,
	overrides: NodeJS.ProcessEnv = { NODE_ENV: "test" },
) {
	const log = join(directory, "gcloud.log");
	writeFileSync(log, "");
	const module = pathToFileURL(resolve("scripts/lib/prodDb.ts")).href;
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
import {targetProdDb} from ${JSON.stringify(module)};
targetProdDb();
console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('NOVA_DB_')))));
`,
		],
		{
			encoding: "utf8",
			timeout: 5000,
			env: {
				PATH: directory,
				NOVA_TEST_LOG: log,
				NOVA_TEST_ACCOUNT: account,
				NOVA_DB_LOCAL_URL: "postgres://local/fixture",
				NOVA_DB_WORKLOAD: "service",
				...overrides,
			},
		},
	);
	expect(result.error).toBeUndefined();
	return {
		...result,
		calls: readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	};
}

test("resolves the CLI account and authoritatively selects the operator workload", () => {
	const result = run("operator@dimagi.com\n");
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		NOVA_DB_WORKLOAD: "operator",
		NOVA_DB_IP_TYPE: "PUBLIC",
		NOVA_DB_NAME: "nova_cases",
		NOVA_DB_INSTANCE_CONNECTION_NAME: "commcare-nova:us-central1:nova-cases",
		NOVA_DB_USER: "operator@dimagi.com",
	});
	expect(result.calls).toEqual([["config", "get-value", "account"]]);
});

test("explicit identity and target overrides work without an active gcloud account", () => {
	const result = run("fail", {
		NODE_ENV: "test",
		NOVA_DB_USER: "explicit@dimagi.com",
		NOVA_DB_NAME: "chosen_database",
		NOVA_DB_INSTANCE_CONNECTION_NAME: "chosen:instance",
		NOVA_DB_IP_TYPE: "PRIVATE",
	});
	expect(result.status, result.stderr).toBe(0);
	expect(result.calls).toEqual([]);
	expect(JSON.parse(result.stdout)).toEqual({
		NOVA_DB_WORKLOAD: "operator",
		NOVA_DB_USER: "explicit@dimagi.com",
		NOVA_DB_NAME: "chosen_database",
		NOVA_DB_INSTANCE_CONNECTION_NAME: "chosen:instance",
		NOVA_DB_IP_TYPE: "PRIVATE",
	});
});

test.each(["", "(unset)\n", "fail"])(
	"missing account %j refuses with a usable next step",
	(account) => {
		const result = run(account);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Could not derive the IAM database user");
		expect(result.stderr).toContain("set NOVA_DB_USER");
		expect(result.calls).toHaveLength(1);
	},
);
