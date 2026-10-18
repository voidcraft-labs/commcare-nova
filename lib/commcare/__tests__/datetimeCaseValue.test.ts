import { describe, expect, it } from "vitest";
import { datetimeCaseValueExpression } from "@/lib/commcare/xform/datetimeCaseValue";
import { w } from "../xpath/wire/builders";

describe("datetimeCaseValueExpression", () => {
	it("preserves the whole typed operand in the blank guard and the coalesced clock value", () => {
		for (const value of [
			w.form(["visit_time"]),
			w.call("now"),
			w.or(w.form(["a"]), w.form(["b"])),
		]) {
			const result = datetimeCaseValueExpression(value);
			expect(result.k).toBe("call");
			if (result.k !== "call")
				throw new Error("Expected the datetime blank guard.");
			expect(result.fn).toBe("if");
			expect(result.args[0]).toMatchObject({
				k: "cmp",
				op: "=",
				right: { k: "str", value: "" },
			});
			const guard = result.args[0];
			if (guard.k !== "cmp") throw new Error("Expected the blank comparison.");
			expect(guard.left).toBe(value);
			expect(result.args[1]).toEqual(w.str(""));
			const formatted = result.args[2];
			expect(formatted).toMatchObject({ k: "call", fn: "format-date" });
			if (formatted.k !== "call") throw new Error("Expected clock formatting.");
			expect(formatted.args[0]).toMatchObject({ k: "call", fn: "coalesce" });
			const coalesced = formatted.args[0];
			if (coalesced.k !== "call")
				throw new Error("Expected blank-safe clock input.");
			expect(coalesced.args[0]).toBe(value);
			expect(coalesced.args[1]).toEqual(w.str(""));
			expect(formatted.args[1]).toEqual(w.str("%Y-%m-%dT%H:%M:%S.%3%Z"));
		}
	});
});
