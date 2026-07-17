import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDateBestEffort } from "../columnCellRenderer";

const originalTimeZone = process.env.TZ;

describe("formatDateBestEffort", () => {
	beforeAll(() => {
		process.env.TZ = "America/Los_Angeles";
	});

	afterAll(() => {
		if (originalTimeZone === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = originalTimeZone;
		}
	});

	it("keeps a bare ISO date on its authored calendar day", () => {
		const raw = "2026-07-14";

		// This is the regression: native parsing treats the same string as a UTC
		// instant and displays the prior day in Pacific time.
		expect(new Date(raw).toLocaleDateString()).toBe(
			new Date(2026, 6, 13).toLocaleDateString(),
		);
		expect(formatDateBestEffort(raw)).toBe(
			new Date(2026, 6, 14).toLocaleDateString(),
		);
	});

	it("leaves invalid date strings unchanged", () => {
		expect(formatDateBestEffort("2026-02-31")).toBe("2026-02-31");
		expect(formatDateBestEffort("not-a-date")).toBe("not-a-date");
	});

	it("retains native local-date rendering for timestamps", () => {
		const timestamp = "2026-07-14T01:30:00.000Z";

		expect(formatDateBestEffort(timestamp)).toBe(
			new Date(timestamp).toLocaleDateString(),
		);
		expect(formatDateBestEffort(timestamp)).toBe(
			new Date(2026, 6, 13).toLocaleDateString(),
		);
	});
});
