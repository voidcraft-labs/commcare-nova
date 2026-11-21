// A live harness can replace directory entries. Open just one flat entry under the host-owned mount,
// read from that handle under a byte bound, and upload from the host's private copy.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "./artifacts.mjs";

const hex = /^[0-9a-f]{64}$/;
const blob = /^sha256:[0-9a-f]{64}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const atomBound = 32 * 1024 * 1024;
const jobBound = 256 * 1024 * 1024;
const jobCount = 128;
const interval = 300_000;

export async function plainBytes(path, bound) {
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size > bound)
			throw new Error("invalid checkpoint file");
		const bytes = Buffer.alloc(info.size + 1);
		let read = 0;
		while (read < bytes.length) {
			const { bytesRead } = await file.read(
				bytes,
				read,
				bytes.length - read,
				read,
			);
			if (!bytesRead) break;
			read += bytesRead;
		}
		if (read !== info.size) throw new Error("unstable checkpoint file");
		return bytes.subarray(0, read);
	} finally {
		await file.close();
	}
}

class AwaitingGroup extends Error {}

function eligible(row, groups, curated) {
	const doc = /^corpus:([a-z0-9][a-z0-9-]{0,79})(?:@[^/\s]{1,96})?$/.exec(
		row.group,
	)?.[1];
	const phase = groups.get(row.block)?.get(row.group);
	if (
		!curated.has(doc) ||
		!hex.test(row.block) ||
		![row.part, row.stored, row.profile].every(
			(v) => typeof v === "string" && hex.test(v),
		) ||
		!blob.test(row.record)
	)
		throw new Error("unknown checkpoint source");
	if (!phase) throw new AwaitingGroup();
	return {
		phase,
		block: row.block,
		group: row.group,
		part: row.part,
		stored: row.stored,
		profile: row.profile,
		record: row.record,
	};
}

async function decodePart(bytes, sha, groups, curated, checkout) {
	if (digest(bytes) !== sha) throw new Error("wrong staged part digest");
	const header = await new Promise((accept, reject) => {
		const child = execFile(
			"python3",
			["-m", "proof.store.checkpoint", "inspect"],
			{
				cwd: checkout,
				env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1" },
				timeout: 30_000,
				killSignal: "SIGKILL",
				maxBuffer: 4096,
			},
			(error, stdout) => (error ? reject(error) : accept(stdout)),
		);
		// The verifier may refuse a malformed input before the pipe drains.
		child.stdin.on("error", reject);
		child.stdin.end(bytes);
	});
	return {
		...eligible(JSON.parse(header), groups, curated),
		sha256: sha,
		bytes: bytes.length,
	};
}

async function curatedDocuments(corpus, checkout) {
	const index = JSON.parse(await readFile(join(corpus, "index.json"), "utf8"));
	// The retained applications in the checked-out proof corpus are the reviewed synthetic roots.
	const roots = await opendir(join(checkout, "proof", "hq-apps"));
	const retained = new Set();
	for await (const item of roots) {
		if (
			item.isDirectory() &&
			(
				await lstat(
					join(checkout, "proof", "hq-apps", item.name, "application.json"),
				).catch(() => undefined)
			)?.isFile()
		)
			retained.add(item.name);
	}
	return new Set(
		index.documents
			.filter(
				(row) => retained.has(row.id) && row.source === `hq-authored:${row.id}`,
			)
			.map((row) => row.id),
	);
}

// One upload at a time; the host can still publish progress while the service accepts a large atom.
// Count attempted bytes against the job ceiling even when a finalization reply was lost.
export function partPublisher({
	output,
	corpus,
	checkout,
	source,
	upload = create,
}) {
	const parts = [];
	const finalized = new Set();
	const rejected = new Set();
	const deferred = new Set();
	const unconfirmed = new Map();
	let uploading,
		next = 0,
		attempts = 0,
		attemptedBytes = 0,
		window = 0,
		windowAttempts = 0,
		lastWarning = 0,
		curated;
	let omitted = { parts: [], additional: 0 };
	const reasons = new Set([
		"part-bytes",
		"part-blobs",
		"header-bytes",
		"job-bytes",
		"job-count",
	]);
	const scan = async (record, now) => {
		if (
			!record.active.some((r) => r.group.startsWith("corpus:")) &&
			!record.finished.some((r) => r.group.startsWith("corpus:")) &&
			!record.workerLost.some((r) => r.group.startsWith("corpus:"))
		)
			return;
		if (now >= window) {
			window = now + interval;
			windowAttempts = 0;
		}
		curated ??= await curatedDocuments(corpus, checkout);
		const groups = new Map();
		for (const row of [
			...record.finished,
			...record.active,
			...record.workerLost,
		]) {
			if (!groups.has(row.block)) groups.set(row.block, new Map());
			groups.get(row.block).set(row.group, row.phase);
		}
		try {
			const held = JSON.parse(
				(
					await plainBytes(
						join(output, ".reader-part-omissions.json"),
						1024 * 1024,
					)
				).toString("utf8"),
			);
			if (
				held.version !== 1 ||
				!Array.isArray(held.parts) ||
				held.parts.length > 512 ||
				!Number.isSafeInteger(held.additional) ||
				held.additional < 0
			)
				throw new Error("invalid omissions");
			omitted = {
				parts: held.parts.map((row) => {
					if (
						!reasons.has(row.reason) ||
						![row.bytes, row.blobCount].every(
							(n) => Number.isSafeInteger(n) && n >= 0,
						)
					)
						throw new Error("invalid omission");
					return {
						...eligible(row, groups, curated),
						bytes: row.bytes,
						blobCount: row.blobCount,
						reason: row.reason,
					};
				}),
				additional: held.additional,
			};
		} catch (error) {
			if (error.code !== "ENOENT")
				console.error("Could not verify the staged evidence omission list.");
		}
		let inspected = 0,
			entries = 0;
		for await (const entry of await opendir(output)) {
			if (
				++entries > 8192 ||
				inspected >= 12 ||
				windowAttempts >= 8 ||
				attempts >= jobCount ||
				attemptedBytes >= jobBound
			)
				break;
			const sha = /^\.reader-part-([0-9a-f]{64})\.bin$/.exec(entry.name)?.[1];
			if (!sha || finalized.has(sha) || rejected.has(sha) || deferred.has(sha))
				continue;
			const prior = unconfirmed.get(sha);
			if (prior && (prior.attempts >= 3 || now < prior.retryAt)) continue;
			inspected++;
			let bytes, part;
			try {
				bytes = await plainBytes(join(output, entry.name), atomBound);
				part = await decodePart(bytes, sha, groups, curated, checkout);
			} catch (error) {
				if (!(error instanceof AwaitingGroup) && rejected.size < 512)
					rejected.add(sha);
				continue;
			}
			if (attemptedBytes + bytes.length > jobBound) {
				if (deferred.size < 512) deferred.add(sha);
				continue;
			}
			windowAttempts++;
			attempts++;
			attemptedBytes += bytes.length;
			const artifact = `proof-part-${source.shard}-${source.attempt}-${sha}.bin`;
			const identity = {
				kind: "reader-part",
				version: 1,
				source,
				queues: record.queues,
				part: { ...part, artifact },
			};
			try {
				const id = await upload(artifact, bytes, {
					retentionDays: 14,
					archive: true,
					identity,
				});
				parts.push({ ...part, artifact, id });
				finalized.add(sha);
				unconfirmed.delete(sha);
			} catch (error) {
				// The service may have finalized a transfer before losing its reply. A conflict is not a receipt.
				// Keep its immutable name discoverable and continue with the other complete observations.
				const tries = (prior?.attempts ?? 0) + 1;
				unconfirmed.set(sha, {
					artifact,
					sha256: sha,
					attempts: tries,
					reason: error.status === 409 ? "name-conflict" : "upload-error",
					retryAt: now + interval * tries,
				});
			}
		}
	};
	return {
		state: () => ({
			parts: [...parts],
			partOmissions: omitted,
			unconfirmedParts: [...unconfirmed.values()].map(
				({ artifact, sha256, attempts, reason }) => ({
					artifact,
					sha256,
					attempts,
					reason,
				}),
			),
			partBudget: {
				attempts,
				attemptedBytes,
				maximumParts: jobCount,
				maximumBytes: jobBound,
				rejected: rejected.size,
				overBudget: deferred.size,
			},
		}),
		poll(record, now) {
			if (uploading || now < next) return;
			next = now + 10_000;
			uploading = scan(record, now)
				.catch(() => {
					if (now >= lastWarning) {
						console.error(
							"A complete observation part could not be verified or saved. A later checkpoint can retry.",
						);
						lastWarning = now + interval;
					}
				})
				.finally(() => {
					uploading = undefined;
				});
		},
		settled: () => uploading,
	};
}
