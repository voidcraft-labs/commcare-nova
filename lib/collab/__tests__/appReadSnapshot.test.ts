import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	appReadSnapshotSchema,
	parseAppReadSnapshot,
	recordedPlacementHoldsOf,
} from "@/lib/collab/appReadSnapshot";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { placementTargetKey } from "@/lib/doc/placementHolds";

const SNAPSHOT = {
	projectId: "project-1",
	role: "editor",
	canEdit: true,
	blueprint: toPersistableDoc(
		buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Interview",
							type: "survey",
							fields: [{ kind: "text", id: "name" }],
						},
					],
				},
			],
		}),
	),
	baseSeq: 7,
	recordedHolds: [],
};

const OWN_CLOSE_HOLD = {
	target: "own-close",
	formUuid: "01890f45-0000-7000-8000-0000000000a1",
	placement: { kind: "save-to-case", path: ["close_case"] },
} as const;

const OPERATION_HOLD = {
	target: "case-operation",
	formUuid: "01890f45-0000-7000-8000-0000000000a1",
	operationUuid: "01890f45-0000-7000-8000-0000000000a2",
	placement: { kind: "basic", slot: "own" },
} as const;

describe("current app-read snapshot", () => {
	it("parses the exact six-key response", () => {
		expect(parseAppReadSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
		expect(
			Object.keys(appReadSnapshotSchema.parse(SNAPSHOT)).toSorted(),
		).toEqual(
			[
				"projectId",
				"role",
				"canEdit",
				"blueprint",
				"baseSeq",
				"recordedHolds",
			].toSorted(),
		);
	});

	it.each(["app_name", "status", "error_type", "mutation_seq"])(
		"rejects the retired %s response key",
		(key) => {
			expect(() =>
				parseAppReadSnapshot({
					...SNAPSHOT,
					[key]: key === "mutation_seq" ? 7 : "old",
				}),
			).toThrow();
		},
	);

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
		"rejects invalid cursor %s",
		(baseSeq) => {
			expect(() => parseAppReadSnapshot({ ...SNAPSHOT, baseSeq })).toThrow();
		},
	);

	it("rejects an incomplete or malformed snapshot as a whole", () => {
		const { role: _role, ...withoutRole } = SNAPSHOT;
		expect(() => parseAppReadSnapshot(withoutRole)).toThrow();
		expect(() =>
			parseAppReadSnapshot({ ...SNAPSHOT, blueprint: {} }),
		).toThrow();
		expect(() =>
			parseAppReadSnapshot({ ...SNAPSHOT, canEdit: "true" }),
		).toThrow();
	});

	it("parses recordedHolds and refuses a malformed entry", () => {
		const parsed = parseAppReadSnapshot({
			...SNAPSHOT,
			recordedHolds: [OPERATION_HOLD, OWN_CLOSE_HOLD],
		});
		// Document order survives the parse.
		expect(parsed.recordedHolds).toEqual([OPERATION_HOLD, OWN_CLOSE_HOLD]);
		expect(
			recordedPlacementHoldsOf(parsed.recordedHolds).get(
				placementTargetKey(OWN_CLOSE_HOLD),
			),
		).toEqual(OWN_CLOSE_HOLD);

		const malformed: unknown[] = [
			// A recording always wrote a placement; a cleared one is no record.
			{ ...OWN_CLOSE_HOLD, placement: null },
			// The placement must be one its target can hold.
			{ ...OWN_CLOSE_HOLD, placement: "count" },
			{ ...OPERATION_HOLD, placement: { kind: "basic", slot: "parent" } },
			// A target the vocabulary does not have.
			{ target: "module", moduleUuid: OWN_CLOSE_HOLD.formUuid },
			// An extra key.
			{ ...OWN_CLOSE_HOLD, recordedAt: 3 },
			// An identity that is no uuid.
			{ ...OWN_CLOSE_HOLD, formUuid: "form-1" },
		];
		for (const entry of malformed) {
			expect(() =>
				parseAppReadSnapshot({ ...SNAPSHOT, recordedHolds: [entry] }),
			).toThrow();
		}
		// One target named twice cannot be two latest recordings.
		expect(() =>
			parseAppReadSnapshot({
				...SNAPSHOT,
				recordedHolds: [
					OWN_CLOSE_HOLD,
					{
						...OWN_CLOSE_HOLD,
						placement: { kind: "save-to-case", path: ["other_close"] },
					},
				],
			}),
		).toThrow();
		// The whole key is required: a read that omits it is not this contract.
		const { recordedHolds: _recordedHolds, ...withoutHolds } = SNAPSHOT;
		expect(() => parseAppReadSnapshot(withoutHolds)).toThrow();
	});
});
