// The reporting and store consumers read artifact-named directories. Exercise
// zero, one and many results through the downloader and real destination files.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadNamed } from "../download.mjs";
import { ArtifactService } from "./artifactService";
import { Scripts } from "./scripts";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "proof-download-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

it.each([0, 1, 2])(
	"keeps artifact identity for %i matching artifacts",
	async (count) => {
		const artifacts = Array.from({ length: count }, (_, id) => ({
			id,
			name: `proof-store-lane${id}-1`,
			digest: `digest-${id}`,
		}));
		const service = {
			listArtifacts: async () => ({
				artifacts: [
					...artifacts,
					{ id: 99, name: "proof-store-old-2", digest: "old" },
					{ id: 100, name: "proof-lane-verdict-other-1", digest: "other" },
				],
			}),
			downloadArtifact: vi.fn(
				async (id: number, options: { path: string; expectedHash: string }) => {
					expect(options.expectedHash).toBe(`digest-${id}`);
					await writeFile(join(options.path, "entry"), `${id}`);
					return { digestMismatch: false };
				},
			),
		};
		await downloadNamed(service, {
			prefix: "proof-store-",
			suffix: "-1",
			directory,
		});
		expect(service.downloadArtifact).toHaveBeenCalledTimes(count);
		for (const artifact of artifacts) {
			expect(
				await readFile(join(directory, artifact.name, "entry"), "utf8"),
			).toBe(`${artifact.id}`);
		}
	},
);

it("refuses corrupt downloaded evidence", async () => {
	await expect(
		downloadNamed(
			{
				listArtifacts: async () => ({
					artifacts: [{ id: 1, name: "proof-store-lane-1", digest: "digest" }],
				}),
				downloadArtifact: async () => ({ digestMismatch: true }),
			},
			{ prefix: "proof-store-", suffix: "-1", directory },
		),
	).rejects.toThrow("downloads failed");
});

it.each(["digest", "transport"])(
	"hides partial %s failures from store and report consumers",
	async (failure) => {
		const name = "proof-store-lane-1";
		const service = {
			listArtifacts: async () => ({
				artifacts: [{ id: 1, name, digest: "digest" }],
			}),
			downloadArtifact: async (_id: number, options: { path: string }) => {
				await writeFile(join(options.path, "valid-looking-entry"), "{}");
				if (failure === "transport") throw new Error("Disconnected");
				return { digestMismatch: true };
			},
		};
		await expect(
			downloadNamed(service, {
				prefix: "proof-store-",
				suffix: "-1",
				directory,
			}),
		).rejects.toThrow();
		await expect(
			readFile(join(directory, name, "valid-looking-entry")),
		).rejects.toMatchObject({ code: "ENOENT" });
	},
);

it("downloads independent evidence after one artifact fails", async () => {
	const artifacts = ["bad", "good"].map((label, id) => ({
		id,
		name: `proof-store-${label}-1`,
		digest: "digest",
	}));
	await expect(
		downloadNamed(
			{
				listArtifacts: async () => ({ artifacts }),
				downloadArtifact: async (id: number, options: { path: string }) => {
					await writeFile(join(options.path, "entry"), `${id}`);
					return { digestMismatch: id === 0 };
				},
			},
			{ prefix: "proof-store-", suffix: "-1", directory },
		),
	).rejects.toThrow();
	await expect(
		readFile(join(directory, artifacts[0].name, "entry")),
	).rejects.toMatchObject({ code: "ENOENT" });
	expect(
		await readFile(join(directory, artifacts[1].name, "entry"), "utf8"),
	).toBe("1");
});

it.each([false, true])(
	"runs the actual action against a served zip artifact (corrupt: %s)",
	async (corrupt) => {
		const service = new ArtifactService();
		const scripts = new Scripts(service, directory);
		await service.start();
		try {
			await writeFile(join(directory, "verdict.json"), '{"passed":true}');
			const archive = join(directory, "evidence.zip");
			await promisify(execFile)("zip", [archive, "verdict.json"], {
				cwd: directory,
			});
			service.put(
				"proof-lane-verdict-mechanics-1",
				await readFile(archive),
				corrupt ? `sha256:${"0".repeat(64)}` : undefined,
				"application/zip",
			);
			const destination = join(directory, "downloaded");
			const result = await scripts.run(
				"../../.github/actions/proof-download/index.mjs",
				[],
				{
					env: {
						...service.env("report"),
						INPUT_PREFIX: "proof-lane-verdict-",
						INPUT_SUFFIX: "-1",
						INPUT_PATH: destination,
					},
				},
			);
			if (corrupt) {
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("digest validation");
				await expect(
					readFile(
						join(destination, "proof-lane-verdict-mechanics-1", "verdict.json"),
					),
				).rejects.toMatchObject({ code: "ENOENT" });
				return;
			}
			expect(result.stdout, result.stderr).toContain(
				"Downloaded 1 named proof artifacts.",
			);
			expect(result.code, result.stderr).toBe(0);
			expect(
				await readFile(
					join(destination, "proof-lane-verdict-mechanics-1", "verdict.json"),
					"utf8",
				),
			).toBe('{"passed":true}');
		} finally {
			await scripts.join();
			await service.stop();
		}
	},
);
