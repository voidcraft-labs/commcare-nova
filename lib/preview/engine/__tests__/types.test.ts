import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { getParentScreen, screenKey, screensEqual } from "../types";

const MODULE = testUuid("module");
const FORM = testUuid("form");

describe("PreviewScreen identity", () => {
	it("keys entity screens by UUID so reorder cannot change their identity", () => {
		expect(screenKey({ type: "module", moduleUuid: MODULE })).toBe(
			`module-${MODULE}`,
		);
		expect(
			screenKey({ type: "form", moduleUuid: MODULE, formUuid: FORM }),
		).toBe(`form-${MODULE}-${FORM}`);
	});

	it("uses UUIDs for equality and parent navigation", () => {
		const form = { type: "form", moduleUuid: MODULE, formUuid: FORM } as const;
		expect(screensEqual(form, { ...form })).toBe(true);
		expect(getParentScreen(form)).toEqual({
			type: "module",
			moduleUuid: MODULE,
		});
	});
});
