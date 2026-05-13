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
// requires `cloudsqlsuperuser` on production, and atlas runs as the
// IAM runtime SA which lacks superuser; the harness mirrors the
// production split (extensions installed at provisioning under a
// superuser; schema migrations applied under the runtime SA via atlas).
// `applyMigrationsViaAtlas` shells out to atlas to apply
// `lib/case-store/migrations/`, the same directory production runs at
// Cloud Run startup. No harness-only schema shape that could mask a
// migration bug.

import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { applyMigrationsViaAtlas } from "./applyMigrationsViaAtlas";

// `inject()` is typed against `ProvidedContext`; the augmentation
// here keeps the publisher and consumer contracts single-source.
declare module "vitest" {
	export interface ProvidedContext {
		postgresTestUrl: string;
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

/** Boot the container, install extensions, apply migrations, publish the URI for workers. */
export async function setup(project: TestProject): Promise<void> {
	const container = await new PostgreSqlContainer(IMAGE_TAG)
		.withDatabase(DATABASE_NAME)
		.start();

	runningContainer = container;
	const connectionString = container.getConnectionUri();

	// The container's default postgres user is a superuser, so
	// `CREATE EXTENSION` succeeds without IAM auth.
	const extClient = new Client({ connectionString });
	await extClient.connect();
	try {
		for (const extension of REQUIRED_EXTENSIONS) {
			await extClient.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
		}
	} finally {
		await extClient.end();
	}

	applyMigrationsViaAtlas(connectionString);

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
