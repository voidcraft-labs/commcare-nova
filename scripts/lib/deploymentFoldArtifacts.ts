import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { DeploymentReferenceEvidence } from "@/lib/deployment/hqChanges/reference";
import {
	activePropertyRenamesSchema,
	displayedPropertyRenamesSchema,
} from "@/lib/deployment/hqChanges/referenceFold";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import * as currentReader from "./deploymentFoldReader";

const sourceResult = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("ok"),
		doc: z.record(z.string(), z.unknown()),
		published: z.record(z.string(), z.unknown()),
		identity: z.record(z.string(), z.unknown()),
		projectId: z.string().min(1),
		editorBefore: z.boolean(),
		actors: z.array(z.string().min(1)),
		renamesSince: displayedPropertyRenamesSchema,
		activeRenames: activePropertyRenamesSchema,
	}),
	z.strictObject({ kind: z.literal("app-moved") }),
	z.strictObject({ kind: z.literal("nova-updated") }),
]);

const admittedDialect = Symbol("deployment fold dialect");
export interface DeploymentFoldMigration {
	readonly [admittedDialect]: true;
	readonly provenance: string;
	readonly readHead: (text: string) => unknown;
	readonly readReference: (
		head: string,
		evidence: DeploymentReferenceEvidence,
	) => z.infer<typeof sourceResult>;
	readonly convert: (
		snapshot: unknown,
		app: { appId: string; projectId: string },
	) => unknown;
}

/** A repair in the currently served representation never converts a document. */
export const sameRepresentationFold: DeploymentFoldMigration = {
	[admittedDialect]: true,
	provenance: "same-representation-v2",
	readHead: currentReader.readHead,
	readReference(head, evidence) {
		return sourceResult.parse(currentReader.readReference(head, evidence));
	},
	convert(snapshot) {
		return snapshot;
	},
};

export interface ExactFoldArtifact {
	readonly path: string;
	readonly sha256: string;
}

export async function importExactArtifact(artifact: ExactFoldArtifact) {
	const bytes = await readFile(artifact.path);
	if (
		!/^[0-9a-f]{64}$/.test(artifact.sha256) ||
		createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
	)
		throw new Error(
			"The deployment conversion artifact differs from the selected SHA-256.",
		);
	// Import the actual bytes verified above. Reopening the path here would
	// allow a replacement between verification and module loading.
	return import(
		/* @vite-ignore */ `data:text/javascript;base64,${bytes.toString("base64")}`
	) as Promise<Record<string, unknown>>;
}

/** Both artifacts are immutable local ES modules supplied by the operator.
 * The reader declares the backend Git revision and source tree from which it
 * was bundled. Conversion settings (identity decisions included) are fixed
 * together with the two executable digests for both the scan and the writer. */
export async function openDeploymentFoldMigration(input: {
	readonly sourceRevision: string;
	readonly sourceTree: string;
	readonly sourceLockSha256: string;
	readonly reader: ExactFoldArtifact;
	readonly converter: ExactFoldArtifact;
	readonly settings: unknown;
}): Promise<DeploymentFoldMigration> {
	const { sourceRevision, sourceTree } = input;
	if (![sourceRevision, sourceTree].every((id) => /^[0-9a-f]{40}$/.test(id)))
		throw new Error(
			"The deployment conversion needs an exact source Git commit and tree.",
		);
	const reader = await importExactArtifact(input.reader);
	const converter = await importExactArtifact(input.converter);
	const { readHead, readReference } = reader,
		{ convert } = converter;
	if (
		!/^[a-f0-9]{64}$/.test(input.sourceLockSha256) ||
		reader.sourceLockSha256 !== input.sourceLockSha256 ||
		reader.sourceRevision !== sourceRevision ||
		reader.sourceTree !== sourceTree ||
		converter.sourceRevision !== sourceRevision ||
		typeof readHead !== "function" ||
		typeof readReference !== "function" ||
		typeof convert !== "function"
	)
		throw new Error(
			"The decoder and converter do not identify the selected deployment source revision.",
		);
	const settings = canonicalJsonText(z.json().parse(input.settings));
	return {
		[admittedDialect]: true,
		provenance: canonicalJsonDigest({
			sourceRevision,
			sourceTree,
			sourceLockSha256: input.sourceLockSha256,
			reader: input.reader.sha256,
			converter: input.converter.sha256,
			settings,
		}),
		readHead(text) {
			return readHead(text);
		},
		readReference(head, evidence) {
			return sourceResult.parse(readReference(head, evidence));
		},
		convert(snapshot, app) {
			return convert(snapshot, JSON.parse(settings), app);
		},
	};
}
