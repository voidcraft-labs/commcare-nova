import { describe, expect, it } from "vitest";
import { xpathCarrierCompatibilityVerificationShouldFail } from "../xpathCarrierCompatibilityRepair";

describe("XPath carrier deploy verification", () => {
	it("passes only when every app is readable and every carrier is compatible", () => {
		expect(
			xpathCarrierCompatibilityVerificationShouldFail({
				errorFindings: 0,
				unreadableApps: 0,
			}),
		).toBe(false);
		expect(
			xpathCarrierCompatibilityVerificationShouldFail({
				errorFindings: 1,
				unreadableApps: 0,
			}),
		).toBe(true);
		expect(
			xpathCarrierCompatibilityVerificationShouldFail({
				errorFindings: 0,
				unreadableApps: 1,
			}),
		).toBe(true);
	});
});
