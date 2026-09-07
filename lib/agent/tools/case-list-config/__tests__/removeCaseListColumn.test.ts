/** Schema-admitted shared tool calls through the real workspace and reducer.
 * Controlled host receipts prove local state transitions, not SQL commits. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { removeCaseListColumnTool } from "../removeCaseListColumn";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

const TARGET_UUID = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const SIBLING_UUID = testUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function fixtureWithColumns(): BlueprintDoc {
	const doc = makeCaseListDoc();
	const target = plainColumn(TARGET_UUID, "case_name", "Patient");
	const sibling = plainColumn(SIBLING_UUID, "phone", "Phone");
	return {
		...doc,
		modules: {
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: resolveCaseListConfig({
					columns: [target, sibling],
					searchInputs: [],
				}),
			},
		},
	};
}

describe("removeCaseListColumn", () => {
	it("removes the targeted column and leaves siblings intact", async () => {
		const h = makeCaseListFixture(fixtureWithColumns());

		await h.runTool(removeCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: TARGET_UUID,
		});

		const cols = h.currentDoc().modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(cols).toHaveLength(1);
		expect(cols[0]?.uuid).toBe(SIBLING_UUID);
	});

	it("returns the removed uuid and remaining count", async () => {
		const h = makeCaseListFixture(fixtureWithColumns());
		const result = await h.runTool(removeCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: TARGET_UUID,
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		expect(result.result.uuid).toBe(TARGET_UUID);
		expect(result.result.remaining).toBe(1);
		expect(result.result.message).toContain(String(TARGET_UUID));
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture(fixtureWithColumns());
		const result = await h.runTool(removeCaseListColumnTool, {
			moduleUuid: testUuid("unknown-module"),
			columnUuid: TARGET_UUID,
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});

	it("returns an Elm-style error when the column uuid is unknown", async () => {
		const h = makeCaseListFixture(fixtureWithColumns());
		const unknown = testUuid("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const result = await h.runTool(removeCaseListColumnTool, {
			moduleUuid: MOD_A,
			columnUuid: unknown,
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain(String(unknown));
		expect(result.result.error).toContain("Found no entry with that uuid");
	});
});
