import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import { serializeLocation } from "@/lib/routing/location";
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
