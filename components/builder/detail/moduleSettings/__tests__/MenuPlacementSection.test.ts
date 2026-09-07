import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	placementAtEnd,
	siblingMovePlacement,
} from "@/components/builder/appTree/modulePlacement";

const ROOT_A = testUuid("root-a");
const ROOT_B = testUuid("root-b");
const CHILD_A = testUuid("child-a");
const CHILD_B = testUuid("child-b");

describe("module placement plans", () => {
	it("uses the start for empty destinations and refuses stale or boundary reorder gestures", () => {
		expect(placementAtEnd(ROOT_A, null, [ROOT_A], {})).toStrictEqual({
			parentModuleUuid: null,
			after: null,
		});
		expect(placementAtEnd(ROOT_B, ROOT_A, [ROOT_A, ROOT_B], {})).toStrictEqual({
			parentModuleUuid: ROOT_A,
			after: null,
		});
		for (const direction of ["up", "down"] as const) {
			expect(
				siblingMovePlacement(CHILD_A, [ROOT_A, ROOT_B], direction),
			).toBeUndefined();
		}
		expect(
			siblingMovePlacement(ROOT_A, [ROOT_A, ROOT_B], "up"),
		).toBeUndefined();
		expect(
			siblingMovePlacement(ROOT_B, [ROOT_A, ROOT_B], "down"),
		).toBeUndefined();
		expect(
			siblingMovePlacement(CHILD_A, [ROOT_A, ROOT_B, CHILD_A], "up"),
		).toStrictEqual({ after: ROOT_A });
	});
	it("makes a submenu top-level at the end without anchoring after itself", () => {
		expect(
			placementAtEnd(CHILD_A, null, [ROOT_A, ROOT_B], { [ROOT_A]: [CHILD_A] }),
		).toStrictEqual({ parentModuleUuid: null, after: ROOT_B });
	});

	it("appends a module to the destination's existing child group", () => {
		expect(
			placementAtEnd(ROOT_B, ROOT_A, [ROOT_A, ROOT_B], {
				[ROOT_A]: [CHILD_A, CHILD_B],
			}),
		).toStrictEqual({ parentModuleUuid: ROOT_A, after: CHILD_B });
	});

	it("reorders within the current sibling group without carrying a parent", () => {
		expect(
			siblingMovePlacement(CHILD_B, [CHILD_A, CHILD_B], "up"),
		).toStrictEqual({
			after: null,
		});
		expect(
			siblingMovePlacement(CHILD_A, [CHILD_A, CHILD_B], "down"),
		).toStrictEqual({
			after: CHILD_B,
		});
	});
});
