import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	type DeploymentFoldMigration,
	openDeploymentFoldMigration,
} from "@/scripts/lib/deploymentFoldArtifacts";

const exec = promisify(execFile);
const sourceRevision = "3e16e43f8cfa56e485860f3345c81f5f9a68aec9";
const sourceTree = "1ae87049c4fe9c9f29e18dd55eec55931ce9f976";
const sourceLockSha256 =
	"9f207de56881079f6a730d1fb936c72d9295fd11e9e8d00467e7b4276a5d0857";
const readerSha256 =
	"a99a1a298379b59ba66f482896df67e084b52b3dde5c9ac49d4a847a604b292c";

/** Rebuild the private decoder only for the shard exercising the release boundary.
 * A local replay can select the very same already-built bytes. */
export async function withReleasedFoldReader(
	run: (migration: DeploymentFoldMigration) => Promise<void>,
) {
	const folder = await mkdtemp(join(tmpdir(), "nova-released-comparison-"));
	try {
		const supplied = process.env.NOVA_DEPLOYMENT_FOLD_TEST_READER;
		const path = supplied ? resolve(supplied) : join(folder, "reader.mjs");
		if (!supplied)
			await exec(
				process.execPath,
				[
					"scripts/build-deployment-fold-reader.mjs",
					"--source",
					".",
					"--revision",
					sourceRevision,
					"--output",
					path,
				],
				{ timeout: 180_000, maxBuffer: 2 * 1024 * 1024 },
			);
		// The release changes one stored shape: an app's Connect type becomes
		// its Connect roles. The converter is the one the release selects.
		const converter = resolve("lib/db/releasedConnectShape.mjs");
		const migration = await openDeploymentFoldMigration({
			sourceRevision,
			sourceTree,
			sourceLockSha256,
			reader: { path, sha256: readerSha256 },
			converter: {
				path: converter,
				sha256: createHash("sha256")
					.update(await readFile(converter))
					.digest("hex"),
			},
			settings: {},
		});
		await run(migration);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}
