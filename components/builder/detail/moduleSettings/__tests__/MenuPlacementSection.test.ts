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
	it("makes a submenu top-level at the end without anchoring after itself", () => {
		expect(
			placementAtEnd(CHILD_A, null, [ROOT_A, ROOT_B], { [ROOT_A]: [CHILD_A] }),
		).toEqual({ parentModuleUuid: null, after: ROOT_B });
	});

	it("appends a module to the destination's existing child group", () => {
		expect(
			placementAtEnd(ROOT_B, ROOT_A, [ROOT_A, ROOT_B], {
				[ROOT_A]: [CHILD_A, CHILD_B],
			}),
		).toEqual({ parentModuleUuid: ROOT_A, after: CHILD_B });
	});

	it("reorders within the current sibling group without carrying a parent", () => {
		expect(siblingMovePlacement(CHILD_B, [CHILD_A, CHILD_B], "up")).toEqual({
			after: null,
		});
		expect(siblingMovePlacement(CHILD_A, [CHILD_A, CHILD_B], "down")).toEqual({
			after: CHILD_B,
		});
	});
});
