import { describe, expect, it } from "vitest";
import { NOVA_PROJECT_LIFECYCLE_OPTIONS } from "../auth";

describe("Project lifecycle policy", () => {
	it("uses Better Auth's pre-mutation deletion block", () => {
		expect(NOVA_PROJECT_LIFECYCLE_OPTIONS).toEqual({
			disableOrganizationDeletion: true,
		});
		expect(Object.isFrozen(NOVA_PROJECT_LIFECYCLE_OPTIONS)).toBe(true);
	});
});
