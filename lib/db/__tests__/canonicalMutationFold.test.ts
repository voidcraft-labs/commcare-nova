import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
import type { LookupRevision } from "@/lib/lookup/types";
import { replayCanonicalAppChangeSuffix } from "../canonicalMutationFold";

const SOURCE_PROJECT = "project-source";
const DESTINATION_PROJECT = "project-destination";
const BASELINE = toPersistableDoc(
	buildDoc({
		appName: "Original",
		modules: [
			{
				name: "Cases",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	}),
);
const INVALID_BASELINE = { ...BASELINE, appName: "" };
const MODULE_HISTORY_BASELINE = toPersistableDoc(
	buildDoc({
		appName: "Module history",
		modules: ["One", "Two", "Three"].map((name) => ({
			name,
			forms: [
				{
					name: `${name} survey`,
					type: "survey" as const,
					fields: [
						f({
							kind: "text",
							id: `${name.toLowerCase()}_question`,
							label: proseText(`${name} question`),
						}),
					],
				},
			],
		})),
	}),
);

function row(seq: string, mutations: unknown) {
	return {
		seq,
		batch_id: `fixture:${seq}`,
		run_id: null,
		actor_id: "fixture-user",
		kind: "autosave",
		mutationsText: JSON.stringify(mutations),
		from_project_id: null,
		to_project_id: null,
	};
}

function move(
	seq: string,
	fromProjectId: string,
	toProjectId: string,
	mutations: unknown = [],
) {
	return {
		...row(seq, mutations),
		kind: "project-move",
		from_project_id: fromProjectId,
		to_project_id: toProjectId,
	};
}

function replay(
	overrides: Partial<Parameters<typeof replayCanonicalAppChangeSuffix>[0]> = {},
) {
	const finalProjectId = overrides.expectedFinalProjectId ?? SOURCE_PROJECT;
	const finalLookupContext: LookupValidationContext =
		overrides.finalLookupContext ?? {
			kind: "available",
			projectId: finalProjectId,
			projectRevision: "0" as LookupRevision,
			definitions: [],
		};
	return replayCanonicalAppChangeSuffix({
		baselineSnapshotText: JSON.stringify(BASELINE),
		baselineSeq: "4",
		baselineProjectId: SOURCE_PROJECT,
		expectedHeadSeq: "4",
		expectedFinalProjectId: SOURCE_PROJECT,
		suffix: [],
		finalLookupContext,
		...overrides,
	});
}

describe("replayCanonicalAppChangeSuffix", () => {
	it("allows historical invalid state to be healed before the one final gate", () => {
		const result = replay({
			baselineSnapshotText: JSON.stringify(INVALID_BASELINE),
			expectedHeadSeq: "5",
			suffix: [row("5", [{ kind: "setAppName", name: "Recovered" }])],
		});
		expect(result.snapshot.appName).toBe("Recovered");
	});

	it("does not gate an invalid intermediate document against today's context", () => {
		const result = replay({
			expectedHeadSeq: "6",
			suffix: [
				row("5", [{ kind: "setAppName", name: "" }]),
				row("6", [{ kind: "setAppName", name: "Recovered" }]),
			],
		});
		expect(result.snapshot.appName).toBe("Recovered");
	});

	it("admits the complete suffix before reducing its first batch", () => {
		expect(() =>
			replay({
				expectedHeadSeq: "6",
				suffix: [
					row("5", [{ kind: "setAppName", name: "" }]),
					row("6", [{ kind: "not-a-mutation" }]),
				],
			}),
		).toThrow();
	});

	it("rejects a final document that fails the absolute gate", () => {
		expect(() =>
			replay({
				expectedHeadSeq: "5",
				suffix: [row("5", [{ kind: "setAppName", name: "" }])],
			}),
		).toThrow(/fails the final absolute commit gate \(EMPTY_APP_NAME\)/);
	});

	it("folds empty and mutation-bearing Project moves in exact order", () => {
		const finalProject = "project-final";
		const result = replay({
			expectedHeadSeq: "7",
			expectedFinalProjectId: finalProject,
			suffix: [
				move("5", SOURCE_PROJECT, DESTINATION_PROJECT),
				move("6", DESTINATION_PROJECT, finalProject, [
					{ kind: "setAppName", name: "Moved" },
				]),
				row("7", [{ kind: "setAppName", name: "Canonical" }]),
			],
		});
		expect(result.projectId).toBe(finalProject);
		expect(result.snapshot.appName).toBe("Canonical");
		expect(result.mutations).toBe(2);
	});

	it("rejects a Project move whose source does not equal folded scope", () => {
		expect(() =>
			replay({
				expectedHeadSeq: "5",
				expectedFinalProjectId: DESTINATION_PROJECT,
				suffix: [move("5", "different-source", DESTINATION_PROJECT)],
			}),
		).toThrow(/does not start in the folded Project/);
	});

	it("rejects a folded Project that does not reach the app row", () => {
		expect(() =>
			replay({
				expectedHeadSeq: "5",
				expectedFinalProjectId: SOURCE_PROJECT,
				suffix: [move("5", SOURCE_PROJECT, DESTINATION_PROJECT)],
			}),
		).toThrow(/does not reach the app's final Project/);
	});

	it("rejects lookup definitions from any Project except the final scope", () => {
		expect(() =>
			replay({
				finalLookupContext: {
					kind: "available",
					projectId: "wrong-project",
					projectRevision: "0" as LookupRevision,
					definitions: [],
				},
			}),
		).toThrow(/requires definitions from the app's final Project/);
	});

	it("rejects fold-baseline rows after the selected greatest baseline", () => {
		expect(() =>
			replay({
				expectedHeadSeq: "5",
				suffix: [
					{
						...row("5", []),
						kind: "fold-baseline",
					},
				],
			}),
		).toThrow(/greatest fold baseline/);
	});

	it("returns a canonical snapshot after a valid contiguous suffix", () => {
		const result = replay({
			expectedHeadSeq: "5",
			suffix: [row("5", [{ kind: "setAppName", name: "Canonical" }])],
		});
		expect(result.snapshot.appName).toBe("Canonical");
		expect(result.projectId).toBe(SOURCE_PROJECT);
		expect(result.headSeq).toBe("5");
		expect(result.batches).toBe(1);
		expect(result.mutations).toBe(1);
	});

	it("replays a historical narrow move before an explicit reparent", () => {
		const [one, , three] = MODULE_HISTORY_BASELINE.moduleOrder;
		const result = replay({
			baselineSnapshotText: JSON.stringify(MODULE_HISTORY_BASELINE),
			expectedHeadSeq: "6",
			suffix: [
				// Historical rows have no parentModuleUuid. They remain a reorder in
				// the module's current sibling group instead of being reinterpreted as
				// an explicit promotion to the root.
				row("5", [{ kind: "moveModule", uuid: three, after: null }]),
				row("6", [
					{
						kind: "moveModule",
						uuid: three,
						parentModuleUuid: one,
						after: null,
					},
				]),
			],
		});
		expect(result.snapshot.modules[three]?.parentModuleUuid).toBe(one);
		expect(result.snapshot.moduleOrder).toEqual([
			one,
			three,
			MODULE_HISTORY_BASELINE.moduleOrder[1],
		]);
		expect(result.mutations).toBe(2);
	});

	it("admits the final safe sequence exactly and cannot advance past it", () => {
		const final = String(Number.MAX_SAFE_INTEGER);
		const beforeFinal = String(Number.MAX_SAFE_INTEGER - 1);
		const result = replay({
			baselineSeq: beforeFinal,
			expectedHeadSeq: final,
			suffix: [row(final, [{ kind: "setAppName", name: "At the boundary" }])],
		});
		expect(result.headSeq).toBe(final);

		expect(() =>
			replay({
				baselineSeq: final,
				expectedHeadSeq: final,
				suffix: [row(final, [{ kind: "setAppName", name: "Cannot advance" }])],
			}),
		).toThrow(/cannot advance/);
	});
});
