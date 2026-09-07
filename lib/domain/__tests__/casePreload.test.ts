import { describe, expect, it } from "vitest";
import {
	caseWriteDestinationClass,
	type Field,
	formOpensWithOneCase,
	type Module,
	USERCASE_CASE_TYPE,
	writerPreloadsFromLoadedCase,
} from "@/lib/domain";

const oneCaseModule = {
	caseType: "patient",
	caseListConfig: undefined,
} satisfies Pick<Module, "caseType" | "caseListConfig">;

const severalCaseModule = {
	caseType: "patient",
	caseListConfig: {
		columns: [],
		listColumnOrder: [],
		detailColumnOrder: [],
		searchInputs: [],
		selection: { kind: "multiple", maximum: 10 },
	},
} satisfies Pick<Module, "caseType" | "caseListConfig">;

function textWriter(caseType: string, property = "phone"): Field {
	return {
		uuid: "00000000-0000-4000-8000-000000000001",
		kind: "text",
		id: "phone",
		label: { parts: [{ kind: "text", text: "Phone" }] },
		caseWrite: { caseType, property },
	} as Field;
}

describe("formOpensWithOneCase", () => {
	it("is true only for a followup or close form in a one-case module", () => {
		expect(formOpensWithOneCase("followup", "single")).toBe(true);
		expect(formOpensWithOneCase("close", "single")).toBe(true);
		expect(formOpensWithOneCase("followup", "multiple")).toBe(false);
		expect(formOpensWithOneCase("registration", "single")).toBe(false);
		expect(formOpensWithOneCase("survey", "single")).toBe(false);
	});
});

describe("writerPreloadsFromLoadedCase", () => {
	it("preloads a writer to the module's own type on a one-case followup or close form", () => {
		expect(
			writerPreloadsFromLoadedCase(textWriter("patient"), oneCaseModule, {
				type: "followup",
			}),
		).toBe(true);
		expect(
			writerPreloadsFromLoadedCase(textWriter("patient"), oneCaseModule, {
				type: "close",
			}),
		).toBe(true);
	});

	it("preloads case_name like every other property", () => {
		expect(
			writerPreloadsFromLoadedCase(
				textWriter("patient", "case_name"),
				oneCaseModule,
				{ type: "followup" },
			),
		).toBe(true);
	});

	it("never preloads a child-type or worker-record writer", () => {
		expect(
			writerPreloadsFromLoadedCase(textWriter("visit"), oneCaseModule, {
				type: "followup",
			}),
		).toBe(false);
		expect(
			writerPreloadsFromLoadedCase(
				textWriter(USERCASE_CASE_TYPE),
				oneCaseModule,
				{ type: "followup" },
			),
		).toBe(false);
	});

	it("never preloads a capture kind, even to the own type", () => {
		const image = {
			uuid: "00000000-0000-4000-8000-000000000002",
			kind: "image",
			id: "photo",
			label: { parts: [{ kind: "text", text: "Photo" }] },
			caseWrite: { caseType: "patient", property: "photo", mode: "url" },
		} as Field;
		expect(
			writerPreloadsFromLoadedCase(image, oneCaseModule, {
				type: "followup",
			}),
		).toBe(false);
	});

	it("never preloads on a several-case form, a registration or survey form, or a module without a case type", () => {
		expect(
			writerPreloadsFromLoadedCase(textWriter("patient"), severalCaseModule, {
				type: "followup",
			}),
		).toBe(false);
		expect(
			writerPreloadsFromLoadedCase(textWriter("patient"), oneCaseModule, {
				type: "registration",
			}),
		).toBe(false);
		expect(
			writerPreloadsFromLoadedCase(textWriter("patient"), oneCaseModule, {
				type: "survey",
			}),
		).toBe(false);
		expect(
			writerPreloadsFromLoadedCase(
				textWriter("patient"),
				{ caseType: undefined, caseListConfig: undefined },
				{ type: "followup" },
			),
		).toBe(false);
	});

	it("does not preload a field with no destination", () => {
		const plain = {
			uuid: "00000000-0000-4000-8000-000000000003",
			kind: "text",
			id: "note",
			label: { parts: [{ kind: "text", text: "Note" }] },
		} as Field;
		expect(
			writerPreloadsFromLoadedCase(plain, oneCaseModule, {
				type: "followup",
			}),
		).toBe(false);
	});
});

describe("caseWriteDestinationClass", () => {
	it("names own, child, worker-record, and none", () => {
		expect(caseWriteDestinationClass(undefined, oneCaseModule)).toBe("none");
		expect(
			caseWriteDestinationClass(
				{ caseType: "patient", property: "phone" },
				oneCaseModule,
			),
		).toBe("own");
		expect(
			caseWriteDestinationClass(
				{ caseType: "visit", property: "notes" },
				oneCaseModule,
			),
		).toBe("child");
		expect(
			caseWriteDestinationClass(
				{ caseType: USERCASE_CASE_TYPE, property: "district" },
				oneCaseModule,
			),
		).toBe("worker-record");
	});
});
