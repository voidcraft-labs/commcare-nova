// lib/case-store/sql/__tests__/globalSetup.ts
//
// Vitest globalSetup — boots one Postgres container per `vitest
// run`. Per-test isolation is the worker's job (BEGIN/ROLLBACK in
// `setup.ts`); per-file containers would cost 5-15 s each and
// make the watch loop unusable.
//
// Hard-kill cleanup goes through testcontainers' Ryuk sidecar;
// `teardown` below covers the clean-exit path. Together they
// handle every termination mode without a manual signal handler.
//
// ## Image choice
//
// `imresamu/postgis:18-3.6.1-alpine3.23` is the community
// multi-arch rebuild of `postgis/postgis`, maintained by Imre
// Samu (@postgis org member). FROM `postgres:18-alpine3.23` plus
// a PostGIS layer, so the Postgres binary set is upstream-official
// and `linux/arm64` manifests publish alongside `linux/amd64`.
//
// Why not the official `postgis/postgis`: amd64-only at every
// major (verified for v16-v18 on Docker Hub). Apple Silicon dev
// machines would run it under emulation. Why not bare
// `postgres:18-alpine3.23`: it doesn't ship PostGIS, and `apk
// add` at container init re-pays the install cost on every cold
// start.
//
// Image is digest-pinned via `IMAGE_TAG` — a compromised
// upstream account can't push malicious content into our test
// runs without a conscious digest bump.
//
// ## Schema seeding
//
// Extensions install via the container's superuser. `CREATE EXTENSION`
// requires `cloudsqlsuperuser` on production, and the runtime IAM SA the
// migrate Job runs as lacks superuser; the harness mirrors the production
// split (extensions installed at provisioning under a superuser; schema
// migrations applied under the runtime SA). `applyMigrations` runs the same
// `runCaseStoreMigrations` (Kysely's `Migrator`) production runs against
// `lib/case-store/migrations/`. No harness-only schema shape that could mask a
// migration bug.

import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { applyMigrations } from "./applyMigrations";

// `inject()` is typed against `ProvidedContext`; the augmentation
// here keeps the publisher and consumer contracts single-source.
declare module "vitest" {
	export interface ProvidedContext {
		postgresTestUrl: string;
		postgresExtensionsTemplate: string;
		postgresMigratedTemplate: string;
	}
}

/**
 * Digest-pinned `<repo>:<tag>@sha256:<digest>`. Docker pulls
 * verify against the digest; the tag is a human-readable
 * navigation aid.
 *
 * Bumping: pull the new tag's MULTI-ARCH manifest-index digest
 * (`https://hub.docker.com/v2/repositories/imresamu/postgis/tags/<tag>`'s
 * top-level `digest` field — NOT per-arch `images[].digest`,
 * which would lock to one architecture). Replace both tag and
 * digest in lockstep so the navigation aid stays accurate.
 */
const IMAGE_TAG =
	"imresamu/postgis:18-3.6.1-alpine3.23@sha256:8990ecd2e7d5744904830ea8b0e4ee90981ad65f08c331cf060da43c46712bac";

const DATABASE_NAME = "case_store_test";

/** `pg_trgm` (fuzzy match), `fuzzystrmatch` (phonetic), `postgis` (within-distance). */
const REQUIRED_EXTENSIONS = ["pg_trgm", "fuzzystrmatch", "postgis"] as const;

/**
 * Module-scope handoff between Vitest's `setup` / `teardown`
 * named exports.
 */
let runningContainer: StartedPostgreSqlContainer | null = null;

/**
 * Boot the container, retrying past a registry that answered badly.
 *
 * Starting a container pulls `IMAGE_TAG` when it isn't already in the local
 * store, so this call reaches Docker Hub — which intermittently answers with a
 * 500 or lets the connection time out. Thrown from `globalSetup`, that arrives
 * as a vitest unhandled error with no test output at all, which reads like a
 * broken build rather than someone else's registry having a bad minute.
 *
 * CI pre-pulls the image (`.github/actions/pull-test-image`), so these retries
 * are for the paths that don't: a developer's first run on a clean machine, and
 * any job added without that step.
 *
 * Three attempts, because the failures worth surviving are brief. A wrong
 * digest or an unreachable daemon fails the same way three times and reports
 * the last error verbatim rather than being classified by matching on its
 * message.
 */
async function startContainer(): Promise<StartedPostgreSqlContainer> {
	const attempts = 3;
	let lastError: unknown;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await new PostgreSqlContainer(IMAGE_TAG)
				.withDatabase(DATABASE_NAME)
				.start();
		} catch (error) {
			lastError = error;
			if (attempt < attempts) {
				await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
			}
		}
	}

	const detail =
		lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(
		`Could not start the Postgres test container after ${attempts} attempts.\n` +
			`Image: ${IMAGE_TAG}\n` +
			`Last error: ${detail}\n\n` +
			"If that mentions registry-1.docker.io, Docker Hub was unreachable — check https://status.docker.com and run again.\n" +
			"Otherwise check that Docker is running (`docker info`), since the selected Postgres tests need an isolated database.",
	);
}

/** Boot the container, install extensions, apply migrations, publish the URI for workers. */
export async function setup(project: TestProject): Promise<void> {
	const container = await startContainer();

	runningContainer = container;
	try {
		await prepareDatabases(project, container);
	} catch (error) {
		// Vitest cannot register a teardown returned by a setup that throws.
		// Close our container even when provisioning or migration fails.
		await teardown();
		throw error;
	}
}

async function prepareDatabases(
	project: TestProject,
	container: StartedPostgreSqlContainer,
): Promise<void> {
	const connectionString = container.getConnectionUri();

	// The container's default postgres user is a superuser, so
	// `CREATE EXTENSION` succeeds without IAM auth.
	const extClient = new Client({ connectionString });
	try {
		await extClient.connect();
		for (const extension of REQUIRED_EXTENSIONS) {
			await extClient.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
		}
	} finally {
		await extClient.end();
	}

	// Snapshot extensions separately so migration tests still start without tables.
	// Connect to the administration database: cloning requires no open sessions
	// on the source, including our own. Templates never accept test connections.
	const adminUri = new URL(connectionString);
	adminUri.pathname = "/postgres";
	const admin = new Client({ connectionString: adminUri.toString() });
	try {
		await admin.connect();
		await admin.query(
			`CREATE DATABASE nova_extensions TEMPLATE ${DATABASE_NAME}`,
		);
		await admin.query("ALTER DATABASE nova_extensions ALLOW_CONNECTIONS false");
		await applyMigrations(connectionString);
		await admin.query(
			`CREATE DATABASE nova_migrated TEMPLATE ${DATABASE_NAME}`,
		);
		await admin.query("ALTER DATABASE nova_migrated ALLOW_CONNECTIONS false");
	} finally {
		await admin.end();
	}
	project.provide("postgresExtensionsTemplate", "nova_extensions");
	project.provide("postgresMigratedTemplate", "nova_migrated");

	// `project.provide` is the typed channel for cross-process
	// state in Vitest 4. Env vars would lose the type augmentation
	// on the consumer side.
	project.provide("postgresTestUrl", connectionString);
}

export async function teardown(): Promise<void> {
	if (runningContainer !== null) {
		await runningContainer.stop();
		runningContainer = null;
	}
}
