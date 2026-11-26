/**
 * What every outcome of the expression stage claims, held to the manifest.
 * The contract: every parse issue and checker code has its entry (the two
 * mappings are exhaustive), every entry any table answers is a member of
 * `EXPRESSION_CLAIMS` and an entry of `lib/commcare/surface/entries`, a
 * refusal never answers an entry that holds what it refuses, a held slot
 * never answers an entry that refuses, and every surface use the record
 * names is a key its entry lists, under the entry's own value class. The
 * failures this catches: a code added to the parser or the checker with no
 * entry, an entry renamed under a table, a refusal claimed as held, and a
 * surface use claimed under a key or class its entry does not hold.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { literal, matchAll, term } from "@/lib/domain/expression/builders";
import type {
	CheckError,
	CheckErrorCode,
} from "@/lib/domain/expression/typeChecker";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import { inventoryIndex } from "../../../surface/inventory";
import type { FormParseIssueCode } from "../../../xpath/formParseIssues";
import type { PendingExpression } from "../../pendingExpressions";
import {
	checkErrorEntry,
	claimKey,
	EXPRESSION_CLAIMS,
	formRefusalEntry,
	nameGrammarEntry,
	parseIssueEntry,
	type RegisteredSlotName,
	SLOT_ENTRIES,
	slotEntries,
} from "../findings";
import { SURFACE_USE_ENTRIES } from "../surfaceUses";

const INDEX = inventoryIndex();
const CLAIMED = new Set(
	Object.values(EXPRESSION_CLAIMS).map((claim) => claim.entry),
);

const ISSUES: Readonly<Record<FormParseIssueCode, true>> = {
	syntax: true,
	"unknown-function": true,
	arity: true,
	union: true,
	"filter-root": true,
	axis: true,
	"parent-after-name": true,
	wildcard: true,
	variable: true,
	"instance-unknown": true,
	"instance-argument": true,
	"groups-held": true,
	"form-root": true,
	"unknown-field": true,
	"ambiguous-field": true,
	"relative-unknown": true,
	"relative-above-form": true,
	"relative-no-context": true,
	"case-alias-unbound": true,
	"case-query-untyped": true,
	"case-row-attribute": true,
	"row-step-after-value": true,
	"row-leaves-record": true,
	"unknown-hashtag": true,
	"unknown-search-input": true,
	"search-results-unexcluded": true,
	"search-results-remote": true,
	"unknown-table": true,
	"table-path-mismatch": true,
	"unknown-column": true,
	"lookup-unavailable": true,
	"unknown-level": true,
	"unknown-location-property": true,
	"unknown-datum": true,
	"placeholder-datum": true,
	"multi-select-datum-value": true,
	"unknown-itext": true,
	"choice-name-not-a-select": true,
	"capture-link-not-a-question": true,
};

const CODES: Readonly<Record<CheckErrorCode, true>> = {
	"capture-default-not-blank": true,
	"unknown-property": true,
	"unknown-search-input": true,
	"unknown-form-field": true,
	"unknown-user-property": true,
	"unknown-lookup-table": true,
	"unknown-lookup-column": true,
	"lookup-table-scope": true,
	"unknown-operation-id": true,
	"operation-context-value": true,
	"unknown-case-type": true,
	"property-scope": true,
	"case-status-value": true,
	"incompatible-values": true,
	"ordered-values": true,
	"time-ordering": true,
	"location-value": true,
	"match-value": true,
	"match-value-empty": true,
	"multi-select-property": true,
	"pattern-match-unavailable": true,
	"range-order": true,
	"relation-origin": true,
	"relation-self": true,
	"relation-path": true,
	"relation-destination": true,
	"relation-ambiguous": true,
	"date-value": true,
	"number-value": true,
	"text-or-date-value": true,
	"text-or-number-value": true,
	"branch-values": true,
	"text-value": true,
	"expected-value": true,
	"constraint-value": true,
	"default-not-a-choice": true,
	"arm-unavailable": true,
	"case-data-unavailable": true,
	"form-answer-unavailable": true,
	"search-answer-unavailable": true,
	"search-results-not-supplied": true,
	"search-results-order": true,
	"search-results-other-type": true,
	"row-scope": true,
	"datum-not-supplied": true,
	"record-position": true,
	"many-values": true,
	"datetime-literal-precision": true,
	"format-date-pattern-not-fixed": true,
	"closed-on-not-on-device": true,
	"case-type-ordering": true,
	"epoch-fraction-on-device": true,
	"runtime-selected-value-type": true,
	"runtime-selected-value-on-device": true,
	"distance-not-numeric": true,
	"distance-unit-type": true,
	"undeclared-worker-field": true,
	"worker-property-read-by-name": true,
};

const ALLOWING = new Set(["held", "kept", "inert"]);
const REFUSING = new Set(["not-yet", "never", "fix-in-hq"]);

const doc = buildDoc({
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [f({ kind: "text", id: "q", label: "Q" })],
				},
			],
		},
	],
});
const MENU = doc.moduleOrder[0] as string;
const FORM = (doc.formOrder[MENU as never] ?? [])[0] as string;
const FIELD = Object.keys(doc.fields)[0] as string;

/** A registration in each slot the tables name, with its owner in the document. */
function refs(): readonly SlotContextRef[] {
	const member = testUuid("00000000-0000-4000-8000-0000000f1001");
	const all: SlotContextRef[] = [];
	for (const slot of Object.keys(SLOT_ENTRIES) as RegisteredSlotName[]) {
		switch (slot) {
			case "relevant":
			case "validate":
			case "calculate":
			case "default_value":
			case "required":
			case "repeat_count":
			case "ids_query":
			case "lookup_options_source":
			case "label":
			case "hint":
			case "help":
			case "validate_msg":
			case "assessment_user_score":
			case "deliver_entity_id":
			case "deliver_entity_name":
			case "deliver_work_area_id":
				all.push({ entity: "field", uuid: FIELD as never, slot });
				break;
			case "option_label":
				all.push({
					entity: "field",
					uuid: FIELD as never,
					slot,
					member: { optionUuid: member },
				});
				break;
			case "form_display_condition":
			case "form_open_condition":
			case "form_close_condition":
				all.push({ entity: "form", uuid: FORM as never, slot });
				break;
			case "form_link_condition":
				all.push({
					entity: "form",
					uuid: FORM as never,
					slot,
					member: { linkUuid: member },
				});
				break;
			case "form_link_datum_xpath":
				all.push({
					entity: "form",
					uuid: FORM as never,
					slot,
					member: {
						linkUuid: member,
						datum: { kind: "selected-case", module: MENU as never },
					},
				});
				break;
			case "case_operation_target_expression":
			case "case_operation_condition":
			case "case_operation_name":
			case "case_operation_owner":
			case "case_operation_rename":
				all.push({
					entity: "form",
					uuid: FORM as never,
					slot,
					member: { operationUuid: member },
				});
				break;
			case "case_operation_write_value":
			case "case_operation_write_condition":
				all.push({
					entity: "form",
					uuid: FORM as never,
					slot,
					member: { operationUuid: member, property: "p" },
				});
				break;
			case "case_operation_link_target_expression":
				all.push({
					entity: "form",
					uuid: FORM as never,
					slot,
					member: { operationUuid: member, identifier: "parent" },
				});
				break;
			case "module_display_condition":
			case "case_list_filter":
			case "search_button_display_condition":
			case "excluded_owner_ids":
				all.push({ entity: "module", uuid: MENU as never, slot });
				break;
			case "case_list_column_expression":
				all.push({
					entity: "module",
					uuid: MENU as never,
					slot,
					member: { columnUuid: member },
				});
				break;
			case "search_input_default":
			case "search_input_options":
			case "search_input_required_when":
			case "search_input_validation_rule":
			case "search_input_hidden_value":
				all.push({
					entity: "module",
					uuid: MENU as never,
					slot,
					member: { searchInputUuid: member },
				});
				break;
		}
	}
	return all;
}

function pending(ref: SlotContextRef): PendingExpression {
	return {
		ref,
		text: "x",
		mode: { target: "xform", constraint: false },
		place: { kind: "app" },
		key: "test:x",
	};
}

/** Each answer a table gives, which must be an entry or one of the table's own words. */
function entryOf(answer: string): string | undefined {
	return answer === "slot-default" ||
		answer === "form-default" ||
		answer === "unrecognized"
		? undefined
		: answer;
}

function expectRefusing(entryId: string, where: string): void {
	const entry = INDEX.entry(entryId);
	expect(entry, `${where}: ${entryId}`).toBeDefined();
	expect(CLAIMED.has(entryId), `${where}: ${entryId} is no claim`).toBe(true);
	expect(REFUSING.has(entry?.standing ?? ""), `${where}: ${entryId}`).toBe(
		true,
	);
}

describe("the expression stage's claims", () => {
	it("registers every member under an entry the manifest holds", () => {
		for (const [name, claim] of Object.entries(EXPRESSION_CLAIMS)) {
			const entry = INDEX.entry(claim.entry);
			expect(entry, name).toBeDefined();
			if (claim.key !== null)
				expect(entry?.surfaceKeys, name).toContain(claim.key);
		}
	});

	it("answers a refusing entry for every parse issue, in every slot", () => {
		for (const ref of refs())
			for (const code of Object.keys(ISSUES) as FormParseIssueCode[]) {
				const issue = { code, message: "", from: 0, to: 1 };
				const answer = parseIssueEntry(issue, doc, pending(ref));
				expect(answer.reason).toBe(`parse:${code}`);
				const entry = entryOf(answer.entryId);
				if (entry !== undefined) expectRefusing(entry, `${ref.slot} ${code}`);
			}
		for (const code of ["case-reference", "fixture-value"] as const)
			for (const ref of refs()) {
				const entry = entryOf(
					parseIssueEntry({ code }, doc, pending(ref)).entryId,
				);
				if (entry !== undefined) expectRefusing(entry, `${ref.slot} ${code}`);
			}
	});

	it("answers a refusing entry for every checker code, in every slot", () => {
		for (const ref of refs())
			for (const code of Object.keys(CODES) as CheckErrorCode[]) {
				const error: CheckError = { path: [], code, message: "" };
				for (const checked of [{ ref }, { ref, searchRow: true } as const]) {
					const answer = checkErrorEntry(error, doc, checked);
					const entry = entryOf(answer.entryId);
					if (entry !== undefined) expectRefusing(entry, `${ref.slot} ${code}`);
				}
				expectRefusing(formRefusalEntry(code), code);
			}
	});

	it("claims a held slot under an allowing entry and a refused one under a refusing entry", () => {
		for (const ref of refs())
			for (const bound of [matchAll(), term(literal("x"))]) {
				const held = slotEntries(ref.slot).held(doc, ref, bound);
				if (held !== undefined) {
					expect(CLAIMED.has(held), held).toBe(true);
					expect(ALLOWING.has(INDEX.entry(held)?.standing ?? ""), held).toBe(
						true,
					);
				}
				const refused = entryOf(slotEntries(ref.slot).refused(doc, ref));
				if (refused !== undefined) expectRefusing(refused, ref.slot);
			}
	});

	it("names every surface use under a key and a class its entry holds", () => {
		for (const [key, rows] of Object.entries(SURFACE_USE_ENTRIES)) {
			expect(INDEX.naming(key).length, key).toBeGreaterThan(0);
			for (const row of rows) {
				const entry = INDEX.entry(row.entryId);
				expect(entry?.surfaceKeys, `${key} ${row.entryId}`).toContain(key);
				expect(CLAIMED.has(row.entryId), row.entryId).toBe(true);
				if (rows.length > 1)
					expect(entry?.valueClass ?? undefined, `${key} ${row.entryId}`).toBe(
						row.valueClass,
					);
			}
		}
	});
});

describe("a parse issue's entry, by what the text and the form hold", () => {
	const relevant: SlotContextRef = {
		entity: "field",
		uuid: FIELD as never,
		slot: "relevant",
	};
	const declared = (text: string, sources: Record<string, string>) =>
		parseIssueEntry(
			{ code: "instance-unknown", message: "", from: 0, to: text.length },
			doc,
			{ ...pending(relevant), text },
			{
				instanceSources: new Map(Object.entries(sources)),
				computedDatums: new Set(),
				operationIdPaths: new Map(),
			},
		).entryId;

	it("reads an unknown instance by the source the form declares it from, then by its id", () => {
		const text = "instance('products')/products/product";
		expect(
			declared(text, { products: "jr://fixture/commtrack:products" }),
		).toBe("expressions-and-data/commtrack-products-commtrack-programs");
		expect(declared(text, { products: "jr://instance/ledgerdb" })).toBe(
			"expressions-and-data/ledgerdb-vellum-id-ledger",
		);
		expect(declared(text, { products: "jr://elsewhere/products" })).toBe(
			"expressions-and-data/declared-and-referenced-instance-with-an-unrecognized-src",
		);
		expect(declared(text, {})).toBe(
			"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
		);
		expect(declared("instance('ledgerdb')/ledgerdb", {})).toBe(
			"expressions-and-data/ledgerdb-vellum-id-ledger",
		);
	});

	it("reads supply_point_id by whether the advanced form computes it", () => {
		const text = "instance('commcaresession')/session/data/supply_point_id";
		const issue = {
			code: "unknown-datum" as const,
			message: "",
			from: 0,
			to: text.length,
		};
		const reading = { ...pending(relevant), text };
		expect(
			parseIssueEntry(issue, doc, reading, {
				instanceSources: new Map(),
				computedDatums: new Set(["supply_point_id"]),
				operationIdPaths: new Map(),
			}).entryId,
		).toBe(
			"expressions-and-data/session-data-supply-point-id-in-an-advanced-form-whose-computed",
		);
		expect(parseIssueEntry(issue, doc, reading).entryId).toBe(
			"expressions-and-data/session-data-supply-point-id-anywhere-except-in-an-advanced-form",
		);
	});

	it("sends self::node() alone to the slot's default, and any other self step to the axes entry", () => {
		const axis = (text: string) =>
			parseIssueEntry(
				{ code: "axis", message: "", from: 0, to: text.length },
				doc,
				{ ...pending(relevant), text },
			).entryId;
		expect(axis("self::node()")).toBe("slot-default");
		expect(axis("parent::node()")).toBe("slot-default");
		expect(axis("self::foo")).toBe(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
		);
	});

	it("reads a bind attribute's syntax error by the characters outside its string literals", () => {
		const syntax = (text: string) =>
			parseIssueEntry(
				{ code: "syntax", message: "", from: 0, to: text.length },
				doc,
				{ ...pending(relevant), text },
			).entryId;
		expect(syntax("/data/q = 'café' and")).toBe(
			"expressions-and-data/an-invalid-xpath-in-a-bind-attribute",
		);
		expect(syntax("/data/café = 'x' and")).toBe("unrecognized");
	});
});

describe("a name outside a grammar Nova keeps unchanged", () => {
	const prop = (property: string) =>
		({
			kind: "term",
			term: { kind: "prop", caseType: "patient", property },
		}) as never;

	it("refuses a case property name outside the authored grammar, under the non-ASCII entry where it holds a character past ASCII", () => {
		expect(nameGrammarEntry(prop("prénom"))).toEqual({
			entryId:
				"forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character",
			reason: "name:case-property",
		});
		expect(nameGrammarEntry(prop("first.name"))).toEqual({
			entryId: "slot-default",
			reason: "name:case-property",
		});
		expect(nameGrammarEntry(prop("first_name"))).toBeUndefined();
	});

	it("refuses an index identifier outside the element-name grammar", () => {
		const index = (identifier: string) =>
			nameGrammarEntry({
				kind: "term",
				term: { kind: "case-index", identifier },
			} as never);
		expect(index("my-index")).toEqual({
			entryId: "slot-default",
			reason: "name:index-identifier",
		});
		expect(index("host")).toBeUndefined();
	});
});

describe("the key a refusal is claimed under", () => {
	const UNTYPED =
		"case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of";

	it("takes the slot's own key where the entry holds it", () => {
		expect(
			claimKey(
				"case-search/a-search-value-that-queries-cases-a-table-or-places",
				"schema:DefaultCaseSearchProperty.defaultValue",
				[],
			),
		).toBe("schema:DefaultCaseSearchProperty.defaultValue");
	});

	it("takes the key of the use the entry is registered under, else its first member's", () => {
		expect(claimKey(UNTYPED, "csql-key:_xpath_query", ["csql-op:<="])).toBe(
			"csql-op:<=",
		);
		expect(claimKey(UNTYPED, "csql-key:_xpath_query", [])).toBe("csql-op:>");
		const m2 =
			"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant";
		expect(claimKey(m2, "xform:bind@relevant", ["jr-fn:if"])).toBe(
			"xform:bind@relevant",
		);
	});
});
