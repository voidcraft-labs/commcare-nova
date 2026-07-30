import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	commitApplyBlueprintChangeTestBatch,
	seedApplyBlueprintChangeTestWriter,
} from "@/lib/db/__tests__/applyBlueprintChangeTestWriter";
import type { ApplyBlueprintChangeResult } from "@/lib/db/applyBlueprintChange";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";

const ROOT = process.cwd();

function testSources(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const absolute = join(directory, entry);
		if (statSync(absolute).isDirectory()) {
			files.push(...testSources(absolute));
		} else if (/\.test\.tsx?$/.test(entry)) {
			files.push(absolute);
		}
	}
	return files;
}

function incompleteApplyResults(source: string): readonly number[] {
	const lines: number[] = [];
	const candidates = [
		/applyBlueprintChange[\w.()]*\.mockResolvedValue(?:Once)?\(\s*\{\s*seq\s*:/g,
		/applyBlueprintChange\s*:\s*vi\.fn\(\)\.mockResolvedValue(?:Once)?\(\s*\{\s*seq\s*:/g,
		/applyBlueprintChange[\w.()]*\.mockImplementation(?:Once)?\([\s\S]{0,500}?\{\s*seq\s*:/g,
		/applyBlueprintChange\s*:\s*vi\.fn\([\s\S]{0,500}?Promise\.resolve\(\s*\{\s*seq\s*:/g,
	];
	for (const pattern of candidates) {
		for (const match of source.matchAll(pattern)) {
			const start = match.index;
			const tail = source.slice(start, start + 800);
			const nextBoundary = tail.search(/\}\s*\)\s*[,;}]/);
			const resultSource =
				nextBoundary === -1 ? tail : tail.slice(0, nextBoundary + 1);
			if (!/\bcommittedDoc\s*:/.test(resultSource)) {
				lines.push(source.slice(0, start).split("\n").length);
			}
		}
	}
	return lines.toSorted((a, b) => a - b);
}

describe("applyBlueprintChange result contract", () => {
	it("requires an authoritative committed document in the public type", () => {
		const complete = {
			seq: 1,
			committedDoc: buildDoc(),
		} satisfies ApplyBlueprintChangeResult;
		expect(complete.committedDoc.appId).toBe("test-app");

		// @ts-expect-error committedDoc is intentionally mandatory.
		const incomplete: ApplyBlueprintChangeResult = { seq: 1 };
		expect(incomplete).toEqual({ seq: 1 });
	});

	it("the shared tool-test writer replays onto seeded state and returns it", async () => {
		const initial = buildDoc({ appId: "writer-contract", appName: "Before" });
		seedApplyBlueprintChangeTestWriter(initial);
		const result = await commitApplyBlueprintChangeTestBatch({
			appId: initial.appId,
			userId: "user-1",
			expectedProjectId: "project-1",
			batchId: "00000000-0000-4000-8000-000000000001",
			kind: "mcp",
			guard: {
				mutations: admitMutationBatch([{ kind: "setAppName", name: "After" }]),
			},
		});
		expect(result).toMatchObject({
			seq: 1,
			committedDoc: { appId: initial.appId, appName: "After" },
		});
	});

	it("finds a seq-only apply mock and accepts a complete result", () => {
		expect(
			incompleteApplyResults(`
				applyBlueprintChangeMock.mockResolvedValue({ seq: 1 });
				const module = {
					applyBlueprintChange: vi.fn(() =>
						Promise.resolve({ seq: 2 }),
					),
				};
				const chained = {
					applyBlueprintChange: vi.fn().mockResolvedValue({ seq: 3 }),
				};
			`),
		).toEqual([2, 4, 9]);
		expect(
			incompleteApplyResults(`
				applyBlueprintChangeMock.mockResolvedValue({
					seq: 1,
					committedDoc: doc,
				});
			`),
		).toEqual([]);
	});

	it("rejects missing-document apply mocks across app and lib tests", () => {
		const offenders: string[] = [];
		for (const root of ["app", "lib"]) {
			for (const absolute of testSources(join(ROOT, root))) {
				if (
					absolute ===
					join(
						ROOT,
						"lib/db/__tests__/applyBlueprintChangeResultContract.test.ts",
					)
				) {
					continue;
				}
				const source = readFileSync(absolute, "utf8");
				for (const line of incompleteApplyResults(source)) {
					offenders.push(`${relative(ROOT, absolute)}:${line}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
