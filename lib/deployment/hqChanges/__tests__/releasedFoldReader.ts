import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { convert as convertReleasedConnect } from "@/lib/db/releasedConnectShape.mjs";
import type { DeploymentReferenceEvidence } from "@/lib/deployment/hqChanges/reference";
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
		const converter = join(folder, "identity.mjs");
		const identity = `export const sourceRevision="${sourceRevision}";export const convert=(doc)=>doc;\n`;
		await writeFile(converter, identity);
		const migration = await openDeploymentFoldMigration({
			sourceRevision,
			sourceTree,
			sourceLockSha256,
			reader: { path, sha256: readerSha256 },
			converter: {
				path: converter,
				sha256: createHash("sha256").update(identity).digest("hex"),
			},
			settings: {},
		});
		// The release also changes one stored shape: an app's Connect type
		// becomes its Connect roles, which the release's Connect conversion
		// writes. These rehearsals write their apps with today's code, so each
		// read goes through the released decoder in the released spelling and
		// comes back in the roles spelling, as the release composes the two.
		await run({
			...migration,
			readHead: (text) => rolesSpelling(migration.readHead(releasedText(text))),
			readReference(head, evidence) {
				const read = migration.readReference(
					releasedText(head),
					releasedEvidence(evidence),
				);
				return read.kind !== "ok"
					? read
					: {
							...read,
							doc: rolesSpelling(read.doc),
							published: rolesSpelling(read.published),
							identity: rolesSpelling(read.identity),
						};
			},
		});
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

/** A document of an app with no Connect role, as the released code spelled
 *  it, wherever one stands in a stored value. */
function releasedValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(releasedValue);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key !== "connectRoles") out[key] = releasedValue(child);
		else if (Array.isArray(child) && child.length === 0) out.connectType = null;
		else
			throw new Error(
				"A rehearsal app with a Connect role has no released spelling here.",
			);
	}
	return out;
}

function releasedText(text: string): string {
	return JSON.stringify(releasedValue(JSON.parse(text)));
}

function releasedEvidence(
	evidence: DeploymentReferenceEvidence,
): DeploymentReferenceEvidence {
	const { start } = evidence;
	return {
		...evidence,
		start:
			start.kind === "certificate"
				? {
						...start,
						stateText: releasedText(start.stateText),
						editorSnapshotText:
							start.editorSnapshotText === null
								? null
								: releasedText(start.editorSnapshotText),
					}
				: start.kind === "published"
					? {
							...start,
							canonical: {
								...start.canonical,
								baselineSnapshotText: releasedText(
									start.canonical.baselineSnapshotText,
								),
							},
						}
					: { ...start, snapshotText: releasedText(start.snapshotText) },
	};
}

/** A released document in the roles spelling. */
function rolesSpelling<T>(doc: T): T {
	if (doc === null || typeof doc !== "object" || !("connectType" in doc))
		return doc;
	const appId = (doc as { appId?: unknown }).appId;
	return convertReleasedConnect(doc, {}, { appId }) as T;
}
