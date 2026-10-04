// The proof lane's one way to GitHub's artifact service from a run step or
// the lane's container (proof/ci/claim.mjs, proof/ci/wait.mjs): the client
// upload-artifact@v7 and download-artifact@v8 run (@actions/artifact, bundled
// in proof/ci/vendor), over the job's runtime token, which
// .github/actions/proof-runtime exports to the steps after it.
//
// Everything here names an artifact of the current workflow run. The claims
// CI makes rest on one property of the service: a listing taken after an
// artifact is finalized includes it. The service may refuse a second
// creation of a name the run already holds (409 Conflict, which
// upload-artifact's `overwrite: false` reports), but shards creating one name
// at once each get an artifact of it (proof/ci/claim.mjs).
// proof-claim-race.yml races claims on the service to measure both.

import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Exit statuses the lane's fork server reads (proof/lane/serve.py). */
export const EXIT = Object.freeze({
	claimed: 0,
	taken: 1,
	failed: 2,
	emissionFailed: 3,
	deadline: 4,
	notYet: 5,
});

/** The runtime variables the client reads, and where a run step gets them. */
const RUNTIME = ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL"];

export class ArtifactServiceError extends Error {
	constructor(message, { status, cause } = {}) {
		super(message, { cause });
		this.name = "ArtifactServiceError";
		this.status = status;
	}
}

/**
 * Keeps standard output for the script's own record: the client's progress
 * lines (which @actions/core writes to standard output) go to standard error
 * from here on. Returns the writer of records, one JSON line each, resolved
 * once the line is written.
 */
export function recordsOnStdout() {
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk, ...rest) =>
		process.stderr.write(chunk, ...rest);
	return (record) =>
		new Promise((resolve) => write(`${JSON.stringify(record)}\n`, resolve));
}

let loaded;

/** The vendored client, loaded on first use (it is 1.7 MB of JavaScript). */
export async function client() {
	const missing = RUNTIME.filter((name) => !process.env[name]);
	if (missing.length > 0) {
		throw new ArtifactServiceError(
			`${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set, so this process cannot reach the run's artifact service.\n` +
				"A workflow step gets them from .github/actions/proof-runtime, which exports them to the steps after it, and the lane's server hands them to its claim and wait commands only (node proof/run.mjs --lane --command-env ACTIONS_RUNTIME_TOKEN,ACTIONS_RESULTS_URL).",
		);
	}
	loaded ??= import("./vendor/artifact.bundle.mjs").then(
		(module) => new module.DefaultArtifactClient(),
	);
	return loaded;
}

/** The HTTP status in an error the vendored client raised, or undefined. */
export function statusOf(error) {
	// The client reports a refused request as "Failed request: (<status>) <reason>: <message>"
	// (internal/shared/artifact-twirp-client.js, ArtifactHttpClient.retryableRequest).
	const match = /Failed request: \((\d{3})\)/.exec(
		String(error?.message ?? ""),
	);
	return match ? Number(match[1]) : undefined;
}

/**
 * Every artifact the run holds, as [{name, id, size, digest, createdAt}],
 * duplicates of a name included; createdAt is when the service created it,
 * in milliseconds since 1970 by the service's clock (undefined when the
 * listing gives none).
 */
export async function listAll() {
	const artifacts = await (await client()).listArtifacts();
	return artifacts.artifacts.map(({ name, id, size, digest, createdAt }) => ({
		name,
		id,
		size,
		digest,
		createdAt: createdAt instanceof Date ? createdAt.getTime() : undefined,
	}));
}

/**
 * Creates the artifact `name` holding `content` as one file of that name (not
 * zipped), kept for `retentionDays`. Resolves its id, or rejects with an
 * ArtifactServiceError whose `status` is 409 when the run already holds an
 * artifact of that name.
 */
export async function create(name, content, { retentionDays = 1 } = {}) {
	const artifacts = await client();
	const directory = await mkdtemp(join(tmpdir(), "proof-artifact-"));
	try {
		const file = join(directory, name);
		await writeFile(file, content);
		const { id } = await artifacts.uploadArtifact(name, [file], directory, {
			skipArchive: true,
			retentionDays,
		});
		return id;
	} catch (error) {
		const status = statusOf(error);
		throw new ArtifactServiceError(
			status === 409
				? `The run already holds an artifact named ${name}, so the service refused to create another.`
				: `Creating the artifact ${name} failed: ${error?.message ?? error}`,
			{ status, cause: error },
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/**
 * Downloads the artifact `artifact` ({id, name, digest}, from a listing) into
 * a directory of its own and resolves the one file in it, after holding its
 * bytes to the digest the listing gave.
 */
export async function download(artifact) {
	const artifacts = await client();
	const directory = await mkdtemp(join(tmpdir(), "proof-download-"));
	try {
		const { digestMismatch } = await artifacts.downloadArtifact(artifact.id, {
			path: directory,
			skipDecompress: true,
			expectedHash: artifact.digest,
		});
		if (digestMismatch) {
			throw new ArtifactServiceError(
				`The artifact ${artifact.name} (id ${artifact.id}) downloaded with bytes whose sha256 is not the ${artifact.digest} the service lists for it, so it was not used.`,
			);
		}
		const files = await readdir(directory);
		if (files.length !== 1) {
			throw new ArtifactServiceError(
				`The artifact ${artifact.name} downloaded as ${files.length} files (${files.join(", ")}), and the lane uploads each as one file.`,
			);
		}
		return { directory, file: join(directory, files[0]) };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/** The shard (1..n) that owns `name` when claims are by ownership: a digest of the name, so every shard computes the same. */
export function ownerOf(name, total) {
	const digest = createHash("sha256").update(name).digest("hex");
	return 1 + Number(BigInt(`0x${digest.slice(0, 13)}`) % BigInt(total));
}
