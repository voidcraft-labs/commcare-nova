import { describe, expect, it } from "vitest";
import { DesignLookupReferenceResolver } from "@/lib/agent/change-set/designLookupReferences";
import {
	ChangeSetIntegrityError,
	ChangeSetStagingRejectedError,
} from "@/lib/agent/change-set/errors";
import { designLookupBindingSchema } from "@/lib/agent/design/lookupMaterializationTypes";

const TABLE_DESIGN_ID = "00000000-0000-4000-8000-000000000101";
const VALUE_DESIGN_ID = "00000000-0000-4000-8000-000000000102";
const LABEL_DESIGN_ID = "00000000-0000-4000-8000-000000000103";
const TABLE_LOOKUP_ID = "018f0000-0000-7000-8000-000000000101";
const VALUE_LOOKUP_ID = "018f0000-0000-7000-8000-000000000102";
const LABEL_LOOKUP_ID = "018f0000-0000-7000-8000-000000000103";

const BINDINGS = designLookupBindingSchema.array().parse([
	{
		kind: "lookup-table",
		designId: TABLE_DESIGN_ID,
		lookupId: TABLE_LOOKUP_ID,
	},
	{
		kind: "lookup-column",
		designId: VALUE_DESIGN_ID,
		lookupId: VALUE_LOOKUP_ID,
	},
	{
		kind: "lookup-column",
		designId: LABEL_DESIGN_ID,
		lookupId: LABEL_LOOKUP_ID,
	},
]);

describe("DesignLookupReferenceResolver", () => {
	it("resolves a designed reference only at the canonical tool boundary", () => {
		const resolver = new DesignLookupReferenceResolver(BINDINGS);
		expect(
			resolver.resolveInput({
				field: {
					source: {
						kind: "designed-project-lookup",
						tableId: TABLE_DESIGN_ID,
						valueColumnId: VALUE_DESIGN_ID,
						labelColumnId: LABEL_DESIGN_ID,
					},
				},
			}),
		).toEqual({
			field: {
				source: {
					kind: "lookup",
					tableId: TABLE_LOOKUP_ID,
					valueColumnId: VALUE_LOOKUP_ID,
					labelColumnId: LABEL_LOOKUP_ID,
				},
			},
		});
	});

	it("reverse-projects canonical results to the same designed reference", () => {
		const resolver = new DesignLookupReferenceResolver(BINDINGS);
		expect(
			resolver.projectOutput({
				optionsSource: {
					kind: "lookup",
					tableId: TABLE_LOOKUP_ID,
					valueColumnId: VALUE_LOOKUP_ID,
					labelColumnId: LABEL_LOOKUP_ID,
				},
			}),
		).toEqual({
			optionsSource: {
				kind: "designed-project-lookup",
				tableId: TABLE_DESIGN_ID,
				valueColumnId: VALUE_DESIGN_ID,
				labelColumnId: LABEL_DESIGN_ID,
			},
		});
	});

	it("uses discovered stable identities unchanged for an existing source", () => {
		const resolver = new DesignLookupReferenceResolver([]);
		const accepted = {
			kind: "existing-project-lookup",
			tableId: TABLE_LOOKUP_ID,
			valueColumnId: VALUE_LOOKUP_ID,
			labelColumnId: LABEL_LOOKUP_ID,
		};
		expect(resolver.resolveInput(accepted)).toEqual({
			...accepted,
			kind: "lookup",
		});
		expect(
			resolver.projectOutput({
				...accepted,
				kind: "lookup",
			}),
		).toEqual(accepted);
	});

	it("returns a normal staging rejection for a malformed existing identity", () => {
		const resolver = new DesignLookupReferenceResolver([]);
		expect(() =>
			resolver.resolveInput({
				kind: "existing-project-lookup",
				tableId: "not-a-table-id",
				valueColumnId: VALUE_LOOKUP_ID,
				labelColumnId: LABEL_LOOKUP_ID,
			}),
		).toThrow(ChangeSetStagingRejectedError);
	});

	it("refuses an ambiguous materialization mapping", () => {
		expect(
			() =>
				new DesignLookupReferenceResolver([
					...BINDINGS,
					designLookupBindingSchema.parse({
						kind: "lookup-column",
						designId: VALUE_DESIGN_ID,
						lookupId: "018f0000-0000-7000-8000-000000000104",
					}),
				]),
		).toThrow(ChangeSetIntegrityError);
	});

	it("never leaks a partially projected materialization identity", () => {
		const resolver = new DesignLookupReferenceResolver(BINDINGS);
		expect(() =>
			resolver.projectOutput({
				kind: "lookup",
				tableId: TABLE_LOOKUP_ID,
				valueColumnId: "018f0000-0000-7000-8000-000000000201",
				labelColumnId: "018f0000-0000-7000-8000-000000000202",
			}),
		).toThrow(ChangeSetIntegrityError);
	});

	it("refuses build-time semantics absent from the accepted designed source", () => {
		const resolver = new DesignLookupReferenceResolver(BINDINGS);
		expect(() =>
			resolver.projectOutput({
				kind: "lookup",
				tableId: TABLE_LOOKUP_ID,
				valueColumnId: VALUE_LOOKUP_ID,
				labelColumnId: LABEL_LOOKUP_ID,
				filter: { kind: "true" },
			}),
		).toThrow(ChangeSetIntegrityError);
	});
});
