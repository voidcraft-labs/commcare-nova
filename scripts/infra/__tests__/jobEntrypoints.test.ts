import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

let directory: string;
const migrationOrder = [
	"pool",
	"database",
	"schema",
	"indexes",
	"auth",
	"auth-app",
	"privileges",
	"runtime-probe",
	"close",
];

/** Replace only the CLI's service boundaries, then execute its real bundled
 * orchestration in a child process. SQL/lease/storage semantics are covered
 * by their real PostgreSQL and storage-adapter suites. */
beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "nova-job-entrypoints-"));
	const fixture = join(directory, "services.mjs");
	writeFileSync(
		fixture,
		[
			"import {appendFileSync} from 'node:fs';",
			"const mode = process.env.NOVA_TEST_MODE;",
			"const db = {}, pool = {};",
			"function event(name, ...args) {",
			" appendFileSync(process.env.NOVA_TEST_LOG, JSON.stringify({name,args})+'\\n');",
			" if(process.env.NOVA_TEST_FAIL === name) throw new Error('fixture failure: '+name);",
			"}",
			"export async function getCaseStorePool(){event('pool');return pool;}",
			"export async function getCaseStoreDatabase(){event('database');return db;}",
			"export async function closeCaseStoreDatabase(){event('close');if(process.env.NOVA_TEST_CLOSE_ERROR==='true') throw new Error('teardown failed');}",
			"export async function runCaseStoreMigrationsWithReport(value){if(value!==db)throw Error('wrong database');event('schema');}",
			"export async function withSchemaContext(){return {drainAllPendingIndexConvergence:async()=>event('indexes')};}",
			"export function authMigrateOptions(value){if(value!==pool)throw Error('wrong pool');return {pool};}",
			"export async function getMigrations(options){if(options.pool!==pool)throw Error('wrong auth config');return {runMigrations:async()=>event('auth')};}",
			"export async function runAuthAppMigrations(value){if(value!==db)throw Error('wrong database');event('auth-app');}",
			"export function readDatabasePrivilegeRoleConfig(){return mode==='local'?null:{runtimeRole:'runtime-fixture'};}",
			"export async function convergeDatabasePrivileges(value, roles){if(value!==db)throw Error('wrong database');event('privileges',roles);}",
			"export async function runCanonicalRuntimeDatabaseProbe(value, role){if(value!==db)throw Error('wrong database');event('runtime-probe',role);return {verified:true};}",
			"export async function withExclusiveCaptureCleanupWorker(work){event('lease');if(['already-running','capacity-saturated'].includes(mode))return {kind:mode};try{await work();return {kind:'ran'};}finally{event('lease-released');}}",
			"export async function runCaptureCleanupSchemaProbe(){event('cleanup-probe');return {verified:true};}",
			"let purges=0;",
			"export async function purgeExpiredFormAttachments(limit){event('purge',limit);purges++;return mode==='bounded'?{processed:100,transitioned:80,objects:[]}:purges===1?{processed:2,transitioned:1,objects:[{objectKey:'unversioned',objectGeneration:null},{objectKey:'versioned',objectGeneration:'123456'},{objectKey:'failed',objectGeneration:'654321'}]}:{processed:0,transitioned:0,objects:[]};}",
			"export async function deleteAsset(key){event('delete',key);}",
			"export async function deleteAssetGeneration(key,generation){event('delete-generation',key,generation);if(key==='failed')throw Error('object deletion failed');}",
			"export async function preparePendingFormAttachments(options){event('prepare',options);return mode==='bounded'?{prepared:70,discarded:10,failed:15,superseded:5}:{prepared:2,discarded:1,failed:1,superseded:3};}",
		].join("\n"),
	);
	const aliases = [
		"better-auth/db/migration",
		"@/lib/auth/migrate",
		"@/lib/auth-migrate-options",
		"@/lib/case-store",
		"@/lib/case-store/migrate",
		"@/lib/case-store/postgres/connection",
		"@/lib/db/privilegeConvergence",
		"@/lib/db/runtimeDatabaseProbe",
		"@/lib/db/captureCleanupLease",
		"@/lib/db/captureCleanupSchemaProbe",
		"@/lib/db/formAttachmentPreparation",
		"@/lib/db/formAttachments",
		"@/lib/storage/media",
	];
	await build({
		entryPoints: ["scripts/migrate.ts", "scripts/cleanup-form-attachments.ts"],
		bundle: true,
		platform: "node",
		format: "cjs",
		outdir: directory,
		outExtension: { ".js": ".cjs" },
		alias: Object.fromEntries(aliases.map((name) => [name, fixture])),
		logLevel: "silent",
	});
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(
	entry: "migrate" | "cleanup-form-attachments",
	options: {
		mode?: string;
		fail?: string;
		closeError?: boolean;
		args?: string[];
	} = {},
) {
	const log = join(directory, "events.jsonl");
	writeFileSync(log, "");
	const result = spawnSync(
		process.execPath,
		[join(directory, `${entry}.cjs`), ...(options.args ?? [])],
		{
			encoding: "utf8",
			timeout: 5000,
			cwd: directory,
			env: {
				...process.env,
				NOVA_TEST_LOG: log,
				NOVA_TEST_MODE: options.mode ?? "",
				NOVA_TEST_FAIL: options.fail ?? "",
				NOVA_TEST_CLOSE_ERROR: String(options.closeError ?? false),
			},
		},
	);
	const events = z
		.array(z.object({ name: z.string(), args: z.array(z.unknown()) }))
		.parse(
			readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		);
	const reports = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line): unknown => JSON.parse(line));
	return { result, events, names: events.map(({ name }) => name), reports };
}

describe("migration process admission", () => {
	test("converges every schema owner before privileges and the runtime probe", () => {
		const { result, names, events, reports } = run("migrate");
		expect(result.status, result.stderr).toBe(0);
		expect(names).toEqual(migrationOrder);
		expect(events.find(({ name }) => name === "runtime-probe")?.args).toEqual([
			"runtime-fixture",
		]);
		expect(reports).toEqual([
			expect.objectContaining({ severity: "INFO", verified: true }),
		]);
	});

	test.each(migrationOrder.slice(0, -1))(
		"failure in %s stops subsequent phases and exits unsuccessfully",
		(fail) => {
			const { result, names } = run("migrate", { fail });
			expect(result.status, result.stderr).toBe(1);
			expect(result.stderr).toContain(`fixture failure: ${fail}`);
			expect(names).toEqual([
				...migrationOrder.slice(0, migrationOrder.indexOf(fail) + 1),
				"close",
			]);
		},
	);

	test("an explicit local database skips production authority checks after schema migration", () => {
		const { result, names } = run("migrate", { mode: "local" });
		expect(result.status, result.stderr).toBe(0);
		expect(names).toEqual([
			"pool",
			"database",
			"schema",
			"indexes",
			"auth",
			"auth-app",
			"close",
		]);
	});

	test.each([undefined, "schema"])(
		"teardown errors preserve the decided migration outcome (%s)",
		(fail) => {
			const { result, names } = run("migrate", { fail, closeError: true });
			expect(result.status).toBe(fail ? 1 : 0);
			expect(result.stderr).toContain("teardown failed");
			expect(names.at(-1)).toBe("close");
		},
	);

	test("unknown arguments refuse before opening the database", () => {
		const { result, names } = run("migrate", { args: ["--unknown"] });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Unknown migration argument");
		expect(names).toEqual(["close"]);
	});
});

describe("recurring capture worker process", () => {
	test("schema admission occurs under the lease and failure prevents all maintenance", () => {
		const { result, names } = run("cleanup-form-attachments", {
			fail: "cleanup-probe",
		});
		expect(result.status).toBe(1);
		expect(names).toEqual([
			"lease",
			"cleanup-probe",
			"lease-released",
			"close",
		]);
	});

	test.each(["already-running", "capacity-saturated"])(
		"a skipped lease never probes or mutates (%s)",
		(mode) => {
			const { result, names, reports } = run("cleanup-form-attachments", {
				mode,
			});
			expect(result.status, result.stderr).toBe(0);
			expect(names).toEqual(["lease", "close"]);
			expect(reports).toEqual([
				expect.objectContaining({
					severity: "INFO",
					message: expect.stringContaining("skipped"),
				}),
			]);
		},
	);

	test("deletes exact generations and reports settled failures without abandoning preparation", () => {
		const { result, names, events, reports } = run("cleanup-form-attachments");
		expect(result.status, result.stderr).toBe(0);
		expect(names).toEqual([
			"lease",
			"cleanup-probe",
			"purge",
			"delete",
			"delete-generation",
			"delete-generation",
			"prepare",
			"lease-released",
			"close",
		]);
		expect(events.filter(({ name }) => name.startsWith("delete"))).toEqual([
			{ name: "delete", args: ["unversioned"] },
			{ name: "delete-generation", args: ["versioned", "123456"] },
			{ name: "delete-generation", args: ["failed", "654321"] },
		]);
		expect(reports).toEqual([
			expect.objectContaining({
				severity: "WARNING",
				expiredRows: 2,
				transitionedExpiredRows: 1,
				objectDeleteFailures: 1,
				prepared: 2,
				discarded: 1,
				preparationFailures: 1,
				supersededPreparations: 3,
			}),
		]);
	});

	test("each maintenance phase stops after ten full batches", () => {
		const { result, events, reports } = run("cleanup-form-attachments", {
			mode: "bounded",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(
			events.filter(({ name }) => name === "purge").map(({ args }) => args),
		).toEqual(Array.from({ length: 10 }, () => [100]));
		expect(
			events.filter(({ name }) => name === "prepare").map(({ args }) => args),
		).toEqual(Array.from({ length: 10 }, () => [{ limit: 100 }]));
		expect(reports).toEqual([
			expect.objectContaining({
				expiredRows: 1000,
				transitionedExpiredRows: 800,
				objectDeleteFailures: 0,
				prepared: 700,
				discarded: 100,
				preparationFailures: 150,
				supersededPreparations: 50,
				severity: "WARNING",
			}),
		]);
	});

	test.each(["purge", "prepare"])(
		"unhandled %s failure releases the lease and fails the Job",
		(fail) => {
			const { result, names, reports } = run("cleanup-form-attachments", {
				fail,
				closeError: true,
			});
			expect(result.status).toBe(1);
			expect(names.slice(-2)).toEqual(["lease-released", "close"]);
			expect(result.stderr).toContain(`fixture failure: ${fail}`);
			expect(reports).toEqual([]);
			if (fail === "purge") expect(names).not.toContain("prepare");
		},
	);
});
