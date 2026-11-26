import { expect, it, vi } from "vitest";
import {
	checkHqLookupJsonWrite,
	createHqLookupTableJson,
	HQ_LOOKUP_JSON_WRITE_DEADLINE_MS,
} from "@/lib/commcare/hq/lookupJson";
import { hqLookupJsonPort } from "../lookupJsonExecutor";

vi.mock("@/lib/commcare/hq/lookupJson", async (load) => ({
	...(await load<typeof import("@/lib/commcare/hq/lookupJson")>()),
	checkHqLookupJsonWrite: vi.fn(),
	createHqLookupTableJson: vi.fn(),
}));

it("charges the permission read to the journaled HQ write deadline", async () => {
	vi.useFakeTimers();
	try {
		vi.mocked(checkHqLookupJsonWrite).mockImplementationOnce(
			() =>
				new Promise((resolve) => setTimeout(() => resolve("confirmed"), 9_000)),
		);
		vi.mocked(createHqLookupTableJson).mockImplementationOnce(
			(_credentials, _domain, _definition, signal) =>
				new Promise((resolve) => {
					if (!signal) throw new Error("Expected a deadline signal.");
					signal.addEventListener(
						"abort",
						() =>
							resolve({
								kind: "uncertain",
								error: { success: false, status: 503 },
							}),
						{ once: true },
					);
				}),
		);
		const port = hqLookupJsonPort(
			{
				username: "worker@example.org",
				apiKey: "fixture-key",
				server: "production",
			},
			"clinic",
			1,
		);
		const settled = port.createTable({
			tag: "types",
			fields: [],
			itemAttributes: [],
		});
		await vi.advanceTimersByTimeAsync(HQ_LOOKUP_JSON_WRITE_DEADLINE_MS - 1);
		const call = vi.mocked(createHqLookupTableJson).mock.calls[0];
		expect(call?.[3]?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(settled).resolves.toMatchObject({ kind: "uncertain" });
		expect(call?.[3]?.aborted).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});
