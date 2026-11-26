/** Logical backup and restore of the generated fleet in the same isolated
 * Postgres release container. No production, database proxy, or cloud state. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { type Kysely, sql } from "kysely";
import { buildIsolatedDb } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { AppDatabase } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { CompletionMigration } from "../lib/completionWorkspaces";
import { scanCompletion } from "../lib/hqRoundTripCompletion";
import { step7CompletionStorage } from "../lib/step7CompletionStorage";

const run = promisify(execFile);
const image =
	"imresamu/postgis:18-3.6.1-alpine3.23@sha256:8990ecd2e7d5744904830ea8b0e4ee90981ad65f08c331cf060da43c46712bac";

async function docker(...args: string[]) {
	return (
		await run("docker", args, { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })
	).stdout.trim();
}

async function sourceContainer(url: URL) {
	const pinned = await docker("image", "inspect", "--format", "{{.Id}}", image);
	const containers = (
		await docker(
			"ps",
			"--filter",
			"label=org.testcontainers=true",
			"--format",
			"{{.ID}}",
		)
	)
		.split(/\s+/)
		.filter(Boolean);
	for (const id of containers) {
		if ((await docker("inspect", "--format", "{{.Image}}", id)) !== pinned)
			continue;
		const ports = JSON.parse(
			await docker(
				"inspect",
				"--format",
				"{{json .NetworkSettings.Ports}}",
				id,
			),
		);
		if (
			ports["5432/tcp"]?.some(
				(port: { HostPort: string }) => port.HostPort === url.port,
			)
		)
			return id;
	}
	throw new Error(
		"The synthetic database is not in the exact test Postgres container.",
	);
}

export async function preservedSourceEvidence(db: Kysely<AppDatabase>) {
	const receipts =
		await sql`SELECT change_set_id, request_id, input_digest, receipt::text
		FROM authoring_requests ORDER BY change_set_id, request_id`.execute(db);
	const history = await sql`SELECT app_id, seq, snapshot_digest
		FROM app_change_fold_baselines ORDER BY app_id, seq`.execute(db);
	const grants = await sql`SELECT n.nspname, c.relname, c.relowner, c.relacl
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r','v','S') ORDER BY c.relname`.execute(
		db,
	);
	return canonicalJsonDigest({
		receipts: receipts.rows,
		history: history.rows,
		grants: grants.rows,
	});
}

export async function backupScaleSource(
	uri: string,
	db: Kysely<AppDatabase>,
	planDigest: string,
	evidenceDigest: string,
	migration: CompletionMigration,
) {
	const url = new URL(uri);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		!/^\/completion_scale_[a-z0-9]+$/.test(url.pathname) ||
		!url.port ||
		url.port === "5432"
	)
		throw new Error(
			"The backup requires its own ephemeral synthetic Postgres database.",
		);
	const source = await sourceContainer(url);
	const user = decodeURIComponent(url.username);
	const name = `step7_scale_restore_${randomUUID().replaceAll("-", "")}`;
	const path = `/tmp/${name}.dump`;
	const started = performance.now();
	await docker(
		"exec",
		source,
		"pg_dump",
		"--format=custom",
		"--file",
		path,
		"--username",
		user,
		"--host",
		"/var/run/postgresql",
		"--dbname",
		url.pathname.slice(1),
	);
	const backupMs = Math.round(performance.now() - started);
	const { dumpSha256, bytes } = {
		dumpSha256: (await docker("exec", source, "sha256sum", path)).split(
			/\s+/,
		)[0],
		bytes: Number(await docker("exec", source, "stat", "-c", "%s", path)),
	};
	return {
		async restore() {
			const start = performance.now();
			await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(db);
			const target = new URL(uri);
			target.pathname = `/${name}`;
			const restored = buildIsolatedDb<AppDatabase>(target.href);
			try {
				await docker(
					"exec",
					source,
					"pg_restore",
					"--single-transaction",
					"--exit-on-error",
					"--username",
					user,
					"--host",
					"/var/run/postgresql",
					"--dbname",
					name,
					path,
				);
				const restoredAt = performance.now();
				const plan = await scanCompletion(
					restored.db,
					migration,
					step7CompletionStorage,
				);
				const evidence = await preservedSourceEvidence(restored.db);
				if (
					canonicalJsonDigest(plan) !== planDigest ||
					evidence !== evidenceDigest
				)
					throw new Error(
						"The logical restore differs from the exact source plan or its historical receipts.",
					);
				return {
					format: "postgres-custom",
					bytes,
					dumpSha256,
					backupMs,
					restoreMs: Math.round(restoredAt - start),
					restoreVerificationMs: Math.round(performance.now() - restoredAt),
				};
			} finally {
				try {
					await restored.destroy();
				} finally {
					await sql`DROP DATABASE ${sql.id(name)}`.execute(db);
				}
			}
		},
		async clean() {
			await docker("exec", source, "rm", "--", path);
		},
	};
}
