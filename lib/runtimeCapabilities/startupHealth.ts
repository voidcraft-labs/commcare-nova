import "server-only";

import { readFile } from "node:fs/promises";
import { getCaseStorePool } from "@/lib/case-store/postgres/connection";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";
import {
	RUNTIME_BUILD_ID_ENV_KEY,
	RUNTIME_BUILD_ID_FILE_PATH,
	requireRuntimeBuildId,
} from "@/lib/runtimeCapabilities/core.mts";
import { runtimeCapabilityEnvironment } from "@/lib/runtimeCapabilities/server";

/** Keep the DB wait below Cloud Run's ten-second per-attempt probe timeout. */
export const STARTUP_DATABASE_DEADLINE_MS = 8_000;

/** Bound the server-side query independently of the request deadline. */
export const STARTUP_DATABASE_QUERY_TIMEOUT_MS = 5_000;

interface StartupDatabaseRow {
	readonly ok: number;
}

interface StartupDatabaseQuery {
	readonly text: string;
	readonly query_timeout: number;
}

type DatabaseQuery = (
	query: StartupDatabaseQuery,
) => Promise<{ readonly rows: readonly StartupDatabaseRow[] }>;

export interface StartupHealthDependencies {
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly checkDatabase?: () => Promise<void>;
	readonly databaseDeadlineMs?: number;
	readonly readBakedBuildId?: () => Promise<string>;
}

/** Opaque by design: the probe response must not disclose env or DB details. */
export class StartupHealthCheckError extends Error {
	override readonly name = "StartupHealthCheckError";

	constructor() {
		super("Startup health check failed");
	}
}

function assertExactImageDeclaration(
	environment: Readonly<Record<string, string | undefined>>,
): string {
	const expected = runtimeCapabilityEnvironment(RUNTIME_CAPABILITIES);
	for (const [key, value] of Object.entries(expected)) {
		if (environment[key] !== value) {
			throw new Error("runtime capability declaration mismatch");
		}
	}
	return requireRuntimeBuildId(environment[RUNTIME_BUILD_ID_ENV_KEY]);
}

async function readBakedBuildId(): Promise<string> {
	return await readFile(RUNTIME_BUILD_ID_FILE_PATH, "utf8");
}

export async function checkStartupDatabaseConnectivity(
	query: DatabaseQuery = async (config) => {
		const pool = await getCaseStorePool();
		return await pool.query<StartupDatabaseRow>(config);
	},
): Promise<void> {
	const result = await query({
		text: "SELECT 1::integer AS ok",
		query_timeout: STARTUP_DATABASE_QUERY_TIMEOUT_MS,
	});
	if (result.rows.length !== 1 || result.rows[0]?.ok !== 1) {
		throw new Error("database connectivity check returned an invalid result");
	}
}

async function withinDeadline<T>(
	operation: () => Promise<T>,
	deadlineMs: number,
): Promise<T> {
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
		throw new Error("database deadline must be a positive integer");
	}
	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			settled = true;
			reject(new Error("database connectivity check timed out"));
		}, deadlineMs);
		timer.unref();

		let pending: Promise<T>;
		try {
			pending = operation();
		} catch (error) {
			settled = true;
			clearTimeout(timer);
			reject(error);
			return;
		}
		void pending.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Startup admission for a candidate instance. The image must prove that it
 * contains the exact checked-in capability declaration and one valid,
 * immutable Cloud Build identity before touching the database. `NODE_ENV` is
 * deliberately not a bypass: it is runtime environment and therefore mutable.
 * Every failure is collapsed to one opaque error for the HTTP surface.
 */
export async function assertRuntimeStartupHealth(
	dependencies: StartupHealthDependencies = {},
): Promise<void> {
	const environment = dependencies.environment ?? process.env;
	const checkDatabase =
		dependencies.checkDatabase ?? checkStartupDatabaseConnectivity;
	const databaseDeadlineMs =
		dependencies.databaseDeadlineMs ?? STARTUP_DATABASE_DEADLINE_MS;
	const readImageBuildId = dependencies.readBakedBuildId ?? readBakedBuildId;

	try {
		const environmentBuildId = assertExactImageDeclaration(environment);
		const imageBuildId = requireRuntimeBuildId(await readImageBuildId());
		if (imageBuildId !== environmentBuildId) {
			throw new Error("runtime build identity mismatch");
		}
		await withinDeadline(checkDatabase, databaseDeadlineMs);
	} catch {
		throw new StartupHealthCheckError();
	}
}
