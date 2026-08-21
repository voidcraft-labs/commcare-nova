/**
 * The writer loop's deploy-safety contract. `runSelectOptionValueRepair` runs
 * inside the migrate Job on every deploy, ahead of the revision carrying the
 * gate it converges, so what it does with a refusal decides whether one
 * already-locked app can block the whole rollout.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { proseText } from "@/lib/domain/prose";

const appendSyntheticBatch = vi.fn();
const loadPersistedBlueprintReadOnly = vi.fn();

vi.mock("@/lib/db/apps", () => ({
	appendSyntheticBatch: (...args: unknown[]) => appendSyntheticBatch(...args),
}));
vi.mock("../lib/loadPersistedBlueprint", () => ({
	loadPersistedBlueprintReadOnly: (...args: unknown[]) =>
		loadPersistedBlueprintReadOnly(...args),
}));
vi.mock("@/lib/db/pg", () => ({
	getAppDb: () => Promise.resolve(fakeAppDb()),
}));

/**
 * The app row every snapshot load reads, plus the read-only transaction
 * wrapper it reads it inside. Only the calls the loader makes are modelled.
 */
function fakeAppDb() {
	const row = (appId: string) => ({
		id: appId,
		app_name: `App ${appId}`,
		mutation_seq: 7,
	});
	const tx = {
		selectFrom: () => ({
			select: () => ({
				where: (_col: string, _op: string, appId: string) => ({
					executeTakeFirst: () => Promise.resolve(row(appId)),
				}),
			}),
		}),
	};
	return {
		transaction: () => ({
			setIsolationLevel: () => ({
				setAccessMode: () => ({
					execute: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
				}),
			}),
		}),
	};
}

/** A one-field survey app whose only choice value holds a space. */
function refusedDoc() {
	return toPersistableDoc(
		buildDoc({
			appName: "Survey",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "answer",
									optionsSource: {
										kind: "inline",
										options: [
											{
												uuid: testUuid("opt-1"),
												value: "a b",
												label: proseText("A b"),
											},
										],
									},
								}),
							],
						},
					],
				},
			],
		}),
	);
}

const { runSelectOptionValueRepair } = await import(
	"../lib/selectOptionValueRepair"
);

describe("runSelectOptionValueRepair", () => {
	beforeEach(() => {
		appendSyntheticBatch.mockReset();
		loadPersistedBlueprintReadOnly.mockReset();
		loadPersistedBlueprintReadOnly.mockImplementation(() =>
			Promise.resolve(refusedDoc()),
		);
	});

	it("names an app the gate still refuses and keeps repairing the rest", async () => {
		appendSyntheticBatch.mockImplementation(({ appId }: { appId: string }) => {
			if (appId === "blocked") {
				throw new BlueprintCommitRejectedError(
					'The form "Visit" has no name in English.',
				);
			}
			return Promise.resolve({ kind: "committed", seq: 8 });
		});

		const report = await runSelectOptionValueRepair(["blocked", "repairable"]);

		expect(report.scannedApps).toBe(2);
		expect(report.repairedApps).toBe(1);
		expect(report.rewrittenValues).toBe(1);
		expect(report.blockedApps).toEqual([
			{
				appId: "blocked",
				appName: "App blocked",
				reason: 'The form "Visit" has no name in English.',
			},
		]);
	});

	it("records a write that fails for any other reason and keeps going", async () => {
		// The worst this repair can do to an app it cannot fix is leave it
		// where it already was. Failing the Job is strictly worse: it blocks
		// the deploy for everyone and strands every app it could have fixed.
		appendSyntheticBatch.mockImplementation(({ appId }: { appId: string }) => {
			if (appId === "broken") throw new TypeError("cannot read x of undefined");
			return Promise.resolve({ kind: "committed", seq: 8 });
		});

		const report = await runSelectOptionValueRepair(["broken", "repairable"]);

		expect(report.repairedApps).toBe(1);
		expect(report.blockedApps).toEqual([
			{
				appId: "broken",
				appName: "App broken",
				reason: "TypeError: cannot read x of undefined",
			},
		]);
	});

	it("still fails loudly when the snapshot load itself cannot reach the database", async () => {
		loadPersistedBlueprintReadOnly.mockImplementation(() => {
			throw new Error("connection terminated unexpectedly");
		});

		await expect(runSelectOptionValueRepair(["one"])).rejects.toThrow(
			"connection terminated unexpectedly",
		);
	});

	it("does not write for an app already inside the grammar", async () => {
		loadPersistedBlueprintReadOnly.mockImplementation(() =>
			Promise.resolve(
				toPersistableDoc(
					buildDoc({
						appName: "Clean",
						modules: [
							{
								name: "Visits",
								forms: [
									{
										name: "Visit",
										type: "survey",
										fields: [
											f({
												kind: "single_select",
												id: "answer",
												optionsSource: {
													kind: "inline",
													options: [
														{
															uuid: testUuid("opt-1"),
															value: "a_b",
															label: proseText("A b"),
														},
													],
												},
											}),
										],
									},
								],
							},
						],
					}),
				),
			),
		);

		const report = await runSelectOptionValueRepair(["clean"]);

		expect(appendSyntheticBatch).not.toHaveBeenCalled();
		expect(report.repairedApps).toBe(0);
		expect(report.blockedApps).toEqual([]);
	});
});
