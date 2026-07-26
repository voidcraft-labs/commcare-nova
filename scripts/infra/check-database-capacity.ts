#!/usr/bin/env node

import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	readDatabaseCapacityRoleConfig,
	runDatabaseCapacityPreflight,
} from "./databaseCapacityPreflight";

const TEARDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
	const config = readDatabaseCapacityRoleConfig();
	const pool = await getCaseStorePool();
	const client = await pool.connect();
	try {
		const result = await runDatabaseCapacityPreflight(client, config, {
			onWait(runtimeSessions) {
				console.log(
					`[capacity] waiting for runtime sessions to drain: ${runtimeSessions}`,
				);
			},
		});
		console.log(
			JSON.stringify({
				severity: "INFO",
				message: "[capacity] database capacity contract verified",
				...result,
			}),
		);
	} finally {
		client.release();
	}
}

async function finish(code: number): Promise<never> {
	try {
		await Promise.race([
			closeCaseStoreDatabase(),
			new Promise((resolve) => setTimeout(resolve, TEARDOWN_TIMEOUT_MS)),
		]);
	} catch (error) {
		console.error("[capacity] teardown error (ignored):", error);
	}
	process.exit(code);
}

main().then(
	() => finish(0),
	(error: unknown) => {
		console.error("[capacity] database capacity preflight failed:", error);
		return finish(1);
	},
);
