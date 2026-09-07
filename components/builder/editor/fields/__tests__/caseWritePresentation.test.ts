import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import type { Field, Module } from "@/lib/domain";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { caseWriteGuidance } from "../caseWritePresentation";

const ordinary: Field = {
	kind: "text",
	id: "phone",
	uuid: testUuid("phone"),
	label: proseText("Phone"),
	caseWrite: { caseType: "patient", property: "phone" },
};
const multiple: Pick<Module, "caseType" | "caseListConfig"> = {
	caseType: "patient",
	caseListConfig: {
		searchInputs: [],
		columns: [],
		listColumnOrder: [],
		detailColumnOrder: [],
		selection: { kind: "multiple", maximum: 10 },
	},
};
const oneCase: Pick<Module, "caseType" | "caseListConfig"> = {
	caseType: "patient",
};
const scope = { module: multiple, form: { type: "followup" as const } };
const oneCaseFollowup = {
	module: oneCase,
	form: { type: "followup" as const },
};

describe("actual case-write guidance projection", () => {
	it("explains blank writes in the selected primary-case scope", () => {
		expect(caseWriteGuidance(ordinary, scope, ordinary.caseWrite)).toEqual({
			writesEverySelectedCase: true,
			preloadsFromLoadedCase: false,
			warning: false,
			help: "This question starts blank. Any answer someone enters updates this information on every selected case. Leaving it blank keeps each case's current value.",
		});
	});
	it("warns about a starting answer and a hidden calculation", () => {
		const expression = { parts: [{ kind: "text" as const, text: "'value'" }] };
		const withDefault = { ...ordinary, default_value: expression };
		const hidden: Field = {
			kind: "hidden",
			id: "computed",
			uuid: testUuid("computed"),
			calculate: expression,
		};
		for (const field of [withDefault, hidden]) {
			const guidance = caseWriteGuidance(field, scope, ordinary.caseWrite);
			expect(guidance.warning).toBe(true);
			expect(guidance.help).toContain("even if no one changes it");
		}
	});
	it("distinguishes capture link and attachment semantics", () => {
		const image: Field = {
			kind: "image",
			id: "photo",
			uuid: testUuid("photo"),
			label: proseText("Photo"),
		};
		const link = caseWriteGuidance(image, scope, {
			caseType: "patient",
			property: "photo",
			mode: "url",
		});
		const attachment = caseWriteGuidance(image, scope, {
			caseType: "patient",
			property: "photo",
			mode: "attachment",
		});
		expect(link.help).toContain("its stored link updates");
		expect(link.help).toContain("does not create that stored link");
		expect(attachment.help).toContain("does not create case attachments");
		expect(link.warning).toBe(true);
		expect(attachment.warning).toBe(true);
	});
	it("withholds several-case guidance outside a loading primary-case write", () => {
		for (const context of [
			null,
			{ ...scope, form: { type: "registration" as const } },
			{ ...scope, form: { type: "survey" as const } },
		])
			expect(caseWriteGuidance(ordinary, context, ordinary.caseWrite)).toEqual({
				writesEverySelectedCase: false,
				preloadsFromLoadedCase: false,
				help: undefined,
				warning: false,
			});
		expect(
			caseWriteGuidance(ordinary, scope, undefined).writesEverySelectedCase,
		).toBe(false);
	});
});

/**
 * What the line says when the form opens, by destination class. The
 * predicate behind it is `writerPreloadsFromLoadedCase`, the one the preview
 * engine seeds from, so these pin the rail to the running form.
 */
describe("what the destination does when the form opens", () => {
	const hiddenCalculated: Field = {
		kind: "hidden",
		id: "last_seen",
		uuid: testUuid("last_seen"),
		calculate: xp("today()"),
		caseWrite: { caseType: "patient", property: "last_seen" },
	};
	const hiddenSetOnce: Field = {
		kind: "hidden",
		id: "seeded",
		uuid: testUuid("seeded"),
		default_value: xp("'x'"),
		caseWrite: { caseType: "patient", property: "seeded" },
	};
	const image: Field = {
		kind: "image",
		id: "photo",
		uuid: testUuid("photo"),
		label: proseText("Photo"),
	};

	it("own type on a one-case followup: opens with the case's current value", () => {
		const guidance = caseWriteGuidance(
			ordinary,
			oneCaseFollowup,
			ordinary.caseWrite,
		);
		expect(guidance).toEqual({
			writesEverySelectedCase: false,
			preloadsFromLoadedCase: true,
			help: "Opens with this case's current value.",
			warning: false,
		});
	});
	it("own type on a one-case close form: opens with the case's current value", () => {
		expect(
			caseWriteGuidance(
				ordinary,
				{ module: oneCase, form: { type: "close" } },
				ordinary.caseWrite,
			).help,
		).toBe("Opens with this case's current value.");
	});
	it("case_name preloads like any other property", () => {
		const name = { caseType: "patient", property: "case_name" };
		const guidance = caseWriteGuidance(ordinary, oneCaseFollowup, name);
		expect(guidance.preloadsFromLoadedCase).toBe(true);
		expect(guidance.help).toBe("Opens with this case's current value.");
	});
	it("a hidden calculated writer: the calculation sets the value", () => {
		const guidance = caseWriteGuidance(
			hiddenCalculated,
			oneCaseFollowup,
			hiddenCalculated.caseWrite,
		);
		expect(guidance.preloadsFromLoadedCase).toBe(true);
		expect(guidance.help).toBe("The calculation sets this value.");
		expect(guidance.warning).toBe(false);
	});
	it("a hidden set-once writer opens with the case's current value", () => {
		expect(
			caseWriteGuidance(hiddenSetOnce, oneCaseFollowup, hiddenSetOnce.caseWrite)
				.help,
		).toBe("Opens with this case's current value.");
	});
	it("child type: creates a new case on each submission, on any form type", () => {
		const visit = { caseType: "visit", property: "notes" };
		for (const form of [
			{ type: "followup" as const },
			{ type: "registration" as const },
		]) {
			const guidance = caseWriteGuidance(
				ordinary,
				{ module: oneCase, form },
				visit,
			);
			expect(guidance).toEqual({
				writesEverySelectedCase: false,
				preloadsFromLoadedCase: false,
				help: "Creates a new Visit case on each submission.",
				warning: false,
			});
		}
	});
	it("child type on a several-case form still says it creates a case", () => {
		expect(
			caseWriteGuidance(ordinary, scope, {
				caseType: "visit",
				property: "notes",
			}).help,
		).toBe("Creates a new Visit case on each submission.");
	});
	it("the worker's own record says nothing", () => {
		expect(
			caseWriteGuidance(ordinary, oneCaseFollowup, {
				caseType: USERCASE_CASE_TYPE,
				property: "region",
			}),
		).toEqual({
			writesEverySelectedCase: false,
			preloadsFromLoadedCase: false,
			help: undefined,
			warning: false,
		});
	});
	it("a capture on a one-case followup says nothing: a stored link is not an upload", () => {
		const guidance = caseWriteGuidance(image, oneCaseFollowup, {
			caseType: "patient",
			property: "photo",
			mode: "url",
		});
		expect(guidance.preloadsFromLoadedCase).toBe(false);
		expect(guidance.help).toBeUndefined();
	});
	it("a registration or survey own-type writer says nothing", () => {
		for (const type of ["registration", "survey"] as const) {
			expect(
				caseWriteGuidance(
					ordinary,
					{ module: oneCase, form: { type } },
					ordinary.caseWrite,
				).help,
			).toBeUndefined();
		}
	});
	it("no destination says nothing", () => {
		expect(caseWriteGuidance(ordinary, oneCaseFollowup, undefined)).toEqual({
			writesEverySelectedCase: false,
			preloadsFromLoadedCase: false,
			help: undefined,
			warning: false,
		});
	});
});
