// Pattern downloads in download-artifact@v8 flatten a single match. These
// consumers need artifact identity in the path regardless of cardinality.
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export async function downloadNamed(service, { prefix, suffix, directory }) {
	if (!prefix || !suffix || !directory) {
		throw new Error("Artifact prefix, suffix and destination are required.");
	}
	const { artifacts } = await service.listArtifacts({ latest: true });
	const selected = artifacts.filter(
		({ name }) => name.startsWith(prefix) && name.endsWith(suffix),
	);
	const errors = [];
	for (const artifact of selected) {
		if (artifact.name.includes("/") || artifact.name.includes("\\")) {
			throw new Error(`Invalid artifact name: ${artifact.name}`);
		}
		await mkdir(directory, { recursive: true });
		const staging = await mkdtemp(join(directory, ".download-"));
		try {
			const { digestMismatch } = await service.downloadArtifact(artifact.id, {
				path: staging,
				expectedHash: artifact.digest,
			});
			if (digestMismatch) {
				throw new Error(`Artifact ${artifact.name} failed digest validation.`);
			}
			await rename(staging, join(directory, artifact.name));
		} catch (error) {
			errors.push(error);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
	if (errors.length)
		throw new AggregateError(errors, "Proof artifact downloads failed.");
	process.stdout.write(
		`Downloaded ${selected.length} named proof artifacts.\n`,
	);
}
