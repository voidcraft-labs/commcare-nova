/**
 * Case property names HQ's form builder can't keep in a form's source.
 *
 * A write a Save to Case block holds is an element of the form's source,
 * named by its property; a write that rides a basic action is added by HQ's
 * build and never stands in the source. `sourceBlockCaseWrites` is the one
 * answer to which writes stand there, read by the emitter and the validator
 * alike, so the rule refuses exactly those writes and leaves the others.
 */

import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { formLinkProjectionContext } from "@/lib/commcare/formLinkProjection";
import { sourceBlockCaseWrites } from "@/lib/commcare/xform/sourceCaseWrites";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../runner";

const MODULE = testUuid("source-writes-module");
const FORM = testUuid("source-writes-form");
const NAME = testUuid("source-writes-name");
const WRITER = testUuid("source-writes-writer");
const CHILD_NAME = testUuid("source-writes-child-name");
const CHILD_WRITER = testUuid("source-writes-child-writer");
const OPERATION = testUuid("source-writes-operation");

const CODE = "CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP";

interface Shape {
	/** The menu selects several cases. */
	readonly several?: boolean;
	/** The property the form's own case is written under, by a field. */
	readonly ownProperty?: string;
	/** A subcase of this type is written, its property by a field. */
	readonly subcase?: { readonly caseType: string; readonly property: string };
	readonly operations?: readonly CaseOperation[];
}

function formDoc(shape: Shape): BlueprintDoc {
	const properties = [
		"instance",
		"bind",
		"parsererror",
		"close",
		"instances",
		"note",
	].map((name) => ({
		name,
		label: proseText(name),
	}));
	const doc = buildDoc({
		caseTypes: [
			{ name: "patient", properties },
			{ name: "visit", parent_type: "patient", properties },
			{
				name: "household_member",
				parent_type: "patient",
				relationship: "extension",
				properties,
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					...(shape.several && {
						selection: { kind: "multiple" as const, maximum: 10 },
					}),
				},
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "name",
								label: proseText("Name"),
							}),
							...(shape.ownProperty === undefined
								? []
								: [
										f({
											uuid: WRITER,
											kind: "text",
											id: "writer",
											label: proseText("Writer"),
											caseWrite: {
												caseType: "patient",
												property: shape.ownProperty,
											},
										}),
									]),
							...(shape.subcase === undefined
								? []
								: [
										f({
											uuid: CHILD_NAME,
											kind: "text",
											id: "child_name",
											label: proseText("Child name"),
											caseWrite: {
												caseType: shape.subcase.caseType,
												property: "case_name",
											},
										}),
										f({
											uuid: CHILD_WRITER,
											kind: "text",
											id: "child_writer",
											label: proseText("Child writer"),
											caseWrite: {
												caseType: shape.subcase.caseType,
												property: shape.subcase.property,
											},
										}),
									]),
						],
					},
				],
			},
			...["visit", "household_member"].map((caseType) => ({
				name: caseType,
				caseType,
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
			})),
		],
	});
	if (shape.operations !== undefined) {
		doc.forms[FORM].caseOperations = [...shape.operations];
	}
	return doc;
}

function updateWriting(property: string): CaseOperation {
	return {
		uuid: OPERATION,
		id: "update_patient",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property, value: term(literal("x")) }],
	};
}

function findings(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
}

function sourceWrites(doc: BlueprintDoc) {
	return sourceBlockCaseWrites(
		doc,
		MODULE,
		FORM,
		formLinkProjectionContext(doc),
	).map((write) => ({
		property: write.property,
		origin:
			write.origin.kind === "operation"
				? write.origin.operationUuid
				: write.origin.fieldUuid,
	}));
}

/** Every element name the emitted form's source holds. */
function sourceElementNames(doc: BlueprintDoc): Set<string> {
	const hq = expandDoc(doc);
	const source = Object.values(hq._attachments).find(
		(value): value is string => typeof value === "string",
	);
	if (source === undefined) throw new Error("The form has no source");
	return new Set(
		findAll(() => true, parseDocument(source, { xmlMode: true }).children).map(
			(element) => element.name,
		),
	);
}

describe("which case writes stand in a form's source", () => {
	it("holds no field write of a one-case follow-up, which a basic action carries", () => {
		const doc = formDoc({ ownProperty: "note" });
		expect(sourceWrites(doc)).toEqual([]);
		expect(sourceElementNames(doc).has("note")).toBe(false);
	});

	it("holds a several-case form's own update, located at its field", () => {
		const doc = formDoc({ several: true, ownProperty: "note" });
		expect(sourceWrites(doc)).toEqual([{ property: "note", origin: WRITER }]);
		expect(sourceElementNames(doc).has("note")).toBe(true);
	});

	it("holds an extension subcase's writes, and not an ordinary child's", () => {
		const extension = formDoc({
			subcase: { caseType: "household_member", property: "note" },
		});
		expect(sourceWrites(extension)).toEqual([
			{ property: "note", origin: CHILD_WRITER },
		]);
		expect(sourceElementNames(extension).has("note")).toBe(true);

		const child = formDoc({ subcase: { caseType: "visit", property: "note" } });
		expect(sourceWrites(child)).toEqual([]);
		expect(sourceElementNames(child).has("note")).toBe(false);
	});

	it("holds every case operation's writes, located at the operation", () => {
		const doc = formDoc({ operations: [updateWriting("note")] });
		expect(sourceWrites(doc)).toEqual([
			{ property: "note", origin: OPERATION },
		]);
		expect(sourceElementNames(doc).has("note")).toBe(true);
	});
});

describe(CODE, () => {
	it.each(["instance", "bind", "parsererror"])(
		"refuses a case change that saves %s, a name the form builder can't open",
		(property) => {
			const errors = findings(
				formDoc({ operations: [updateWriting(property)] }),
			);
			expect(errors.map((error) => error.code)).toEqual([CODE]);
			expect(errors[0]?.details).toMatchObject({
				operationUuid: OPERATION,
				property,
				problem: "stops_form_builder",
			});
			expect(errors[0]?.message).toContain(
				`CommCare HQ's form builder can't open a form that saves a property named "${property}" from a case change.`,
			);
		},
	);

	it("refuses a case change that saves close, which the form builder reads as closing the case", () => {
		const errors = findings(formDoc({ operations: [updateWriting("close")] }));
		expect(errors.map((error) => error.code)).toEqual([CODE]);
		expect(errors[0]?.details).toMatchObject({
			property: "close",
			problem: "closes_case",
		});
		expect(errors[0]?.message).toContain(
			`CommCare HQ's form builder reads a property named "close" as closing the case`,
		);
	});

	it("accepts the neighbor instances on a case change", () => {
		expect(
			findings(formDoc({ operations: [updateWriting("instances")] })),
		).toEqual([]);
	});

	it("refuses the field of a several-case form that saves bind", () => {
		const errors = findings(formDoc({ several: true, ownProperty: "bind" }));
		expect(errors.map((error) => error.code)).toEqual([CODE]);
		expect(errors[0]?.location).toMatchObject({
			fieldUuid: WRITER,
			fieldId: "writer",
		});
	});

	it("refuses the field of an extension subcase that saves close", () => {
		const errors = findings(
			formDoc({ subcase: { caseType: "household_member", property: "close" } }),
		);
		expect(errors.map((error) => error.code)).toEqual([CODE]);
		expect(errors[0]?.location.fieldUuid).toBe(CHILD_WRITER);
		expect(errors[0]?.details?.problem).toBe("closes_case");
	});

	it.each(["bind", "close"])(
		"accepts a field that saves %s through a basic action, which the source never holds",
		(property) => {
			expect(findings(formDoc({ ownProperty: property }))).toEqual([]);
			expect(
				findings(formDoc({ subcase: { caseType: "visit", property } })),
			).toEqual([]);
		},
	);
});
