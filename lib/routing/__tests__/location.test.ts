import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import { parseLocation, serializeLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
const qUuid = asUuid("33333333-3333-3333-3333-333333333333");

describe("serializeLocation", () => {
	it("emits empty params for home", () => {
		const loc: Location = { kind: "home" };
		const params = serializeLocation(loc);
		expect(params.toString()).toBe("");
	});

	it("emits s=m&m=<uuid> for module screen", () => {
		const loc: Location = { kind: "module", moduleUuid: modUuid };
		const params = serializeLocation(loc);
		expect(params.get("s")).toBe("m");
		expect(params.get("m")).toBe(modUuid);
		expect(Array.from(params.keys())).toEqual(["s", "m"]);
	});

	it("emits s=cases&m=<uuid> for case list", () => {
		const loc: Location = { kind: "cases", moduleUuid: modUuid };
		const params = serializeLocation(loc);
		expect(params.get("s")).toBe("cases");
		expect(params.get("m")).toBe(modUuid);
		expect(params.get("case")).toBeNull();
	});

	it("emits case= when caseId is present", () => {
		const loc: Location = {
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "abc123",
		};
		const params = serializeLocation(loc);
		expect(params.get("case")).toBe("abc123");
	});

	it("emits s=f&m=&f= for form without selection", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
		};
		const params = serializeLocation(loc);
		expect(params.get("s")).toBe("f");
		expect(params.get("m")).toBe(modUuid);
		expect(params.get("f")).toBe(formUuid);
		expect(params.get("sel")).toBeNull();
	});

	it("emits sel= when a question is selected", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		};
		const params = serializeLocation(loc);
		expect(params.get("sel")).toBe(qUuid);
	});
});

const params = (s: string): URLSearchParams => new URLSearchParams(s);

describe("parseLocation", () => {
	it("returns home for empty params", () => {
		expect(parseLocation(params(""))).toEqual({ kind: "home" });
	});

	it("returns home when s is missing but other params are present", () => {
		// Defensive: if someone strips the screen param by mistake, we fall
		// back to home rather than rendering a broken screen.
		expect(parseLocation(params(`m=${modUuid}`))).toEqual({ kind: "home" });
	});

	it("returns home for an unrecognized s value", () => {
		expect(parseLocation(params("s=bogus"))).toEqual({ kind: "home" });
	});

	it("parses module screen", () => {
		expect(parseLocation(params(`s=m&m=${modUuid}`))).toEqual({
			kind: "module",
			moduleUuid: modUuid,
		});
	});

	it("falls back to home when module screen is missing m=", () => {
		expect(parseLocation(params("s=m"))).toEqual({ kind: "home" });
	});

	it("parses case list", () => {
		expect(parseLocation(params(`s=cases&m=${modUuid}`))).toEqual({
			kind: "cases",
			moduleUuid: modUuid,
		});
	});

	it("parses case detail", () => {
		expect(parseLocation(params(`s=cases&m=${modUuid}&case=abc`))).toEqual({
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "abc",
		});
	});

	it("falls back to home when case screen is missing m=", () => {
		expect(parseLocation(params("s=cases"))).toEqual({ kind: "home" });
	});

	it("parses form without selection", () => {
		expect(parseLocation(params(`s=f&m=${modUuid}&f=${formUuid}`))).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
		});
	});

	it("parses form with selection", () => {
		expect(
			parseLocation(params(`s=f&m=${modUuid}&f=${formUuid}&sel=${qUuid}`)),
		).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		});
	});

	it("falls back to home when form screen is missing f=", () => {
		expect(parseLocation(params(`s=f&m=${modUuid}`))).toEqual({
			kind: "home",
		});
	});

	it("round-trips every Location shape through serialize→parse", () => {
		const cases: Location[] = [
			{ kind: "home" },
			{ kind: "module", moduleUuid: modUuid },
			{ kind: "cases", moduleUuid: modUuid },
			{ kind: "cases", moduleUuid: modUuid, caseId: "abc" },
			{ kind: "form", moduleUuid: modUuid, formUuid },
			{
				kind: "form",
				moduleUuid: modUuid,
				formUuid,
				selectedUuid: qUuid,
			},
		];
		for (const loc of cases) {
			expect(parseLocation(serializeLocation(loc))).toEqual(loc);
		}
	});
});
