// Proof jobs know the artifact names they need. GitHub caps the run-wide
// listing, which can fill with checkpoints before subsequent lanes finish.
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { findArtifact } from "./artifacts.mjs";

export async function downloadNamed(
	service,
	{ names, directory, allowMissing = false },
) {
	if (!directory) throw new Error("An artifact destination is required.");
	for (const name of names) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
			throw new Error(`Invalid artifact name: ${name}`);
		}
	}
	let downloaded = 0;
	const errors = [];
	await mkdir(directory, { recursive: true });
	// Bounded concurrency leaves capacity for the shards that are still uploading.
	for (let i = 0; i < names.length; i += 4) {
		const outcomes = await Promise.allSettled(
			names.slice(i, i + 4).map(async (name) => {
				const artifact = await findArtifact(service, name);
				if (!artifact) {
					if (allowMissing) return;
					throw new Error(`Proof artifact ${name} is missing.`);
				}
				const staging = await mkdtemp(join(directory, ".download-"));
				try {
					const { digestMismatch } = await service.downloadArtifact(
						artifact.id,
						{
							path: staging,
							expectedHash: artifact.digest,
						},
					);
					if (digestMismatch)
						throw new Error(`Artifact ${name} failed digest validation.`);
					await rename(staging, join(directory, name));
					downloaded++;
				} catch (error) {
					throw new Error(`Could not download proof artifact ${name}.`, {
						cause: error,
					});
				} finally {
					await rm(staging, { recursive: true, force: true });
				}
			}),
		);
		for (const outcome of outcomes) {
			if (outcome.status === "rejected") errors.push(outcome.reason);
		}
	}
	if (errors.length)
		throw new AggregateError(errors, "Proof artifact downloads failed.");
	process.stdout.write(`Downloaded ${downloaded} named proof artifacts.\n`);
}
