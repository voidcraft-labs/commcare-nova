import { describe, expect, it } from "vitest";
import { parseAppStatusFrame } from "../appStatusFrame";

describe("app-status frame admission", () => {
	it("admits exactly the closed lifecycle vocabulary", () => {
		expect(parseAppStatusFrame('{"status":"generating"}')).toEqual({
			status: "generating",
		});
		expect(parseAppStatusFrame('{"status":"complete"}')).toEqual({
			status: "complete",
		});
		expect(parseAppStatusFrame('{"status":"error"}')).toEqual({
			status: "error",
		});
	});

	it("returns null on anything else — a malformed frame must not move the pricing latch", () => {
		expect(parseAppStatusFrame('{"status":"deleted"}')).toBeNull();
		expect(parseAppStatusFrame('{"status":""}')).toBeNull();
		expect(
			parseAppStatusFrame('{"status":"complete","extra":true}'),
		).toBeNull();
		expect(parseAppStatusFrame("{}")).toBeNull();
		expect(parseAppStatusFrame("not json")).toBeNull();
		expect(parseAppStatusFrame('"complete"')).toBeNull();
	});
});
