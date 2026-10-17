import { describe, expect, it } from "vitest";
import {
	isReservedInstanceTag,
	LOOKUP_MAX_TAG_LENGTH,
	reservedInstanceTagCause,
} from "../constants";
import {
	createLookupTableInputSchema,
	lookupTagSchema,
	lookupWireNameSchema,
	updateLookupTableTagInputSchema,
} from "../schema";

const tableId = "01890f45-0000-7000-8000-000000000001";
const columns = [{ wireName: "label", label: "Label", dataType: "text" }];

// Parser admission for new tags and explicit tag changes. Native XForm consumer
// tests in lib/commcare own the demonstrated instance-name collision.
describe("lookup instance tag admission", () => {
	it.each([
		"selected_cases",
		"selected_cases_patient",
		"parent_selected_cases",
		"parent_parent_selected_cases_a",
		"search_selected_cases",
		"Selected_Cases",
		"PARENT_SELECTED_CASES_PATIENT",
		"SEARCH_SELECTED_CASES",
	])("refuses reserved virtual instance tag %s at create and rename", (tag) => {
		const create = { name: "Labels", tag: "labels", columns };
		const rename = { tableId, expectedTableRevision: "0", tag: "labels" };
		expect(createLookupTableInputSchema.parse(create)).toEqual(create);
		expect(updateLookupTableTagInputSchema.parse(rename)).toEqual(rename);
		expect(
			createLookupTableInputSchema.safeParse({ ...create, tag }).success,
		).toBe(false);
		expect(
			updateLookupTableTagInputSchema.safeParse({ ...rename, tag }).success,
		).toBe(false);
		expect(lookupWireNameSchema.parse(tag)).toBe(tag);
	});
	it.each([
		"selected_cases_",
		"selected_cases_1",
		"selected_cases__patient",
		"parent_search_selected_cases",
		"my_selected_cases",
		"selected_case",
		"selected_caseslabels",
		"parent_patient",
	])("preserves noncolliding table tag %s", (tag) => {
		const create = { name: "Labels", tag, columns };
		expect(createLookupTableInputSchema.parse(create)).toEqual(create);
		expect(
			updateLookupTableTagInputSchema.parse({
				tableId,
				expectedTableRevision: "0",
				tag,
			}).tag,
		).toBe(tag);
	});
});

describe("tags that contain a word the runtime reads as its own data", () => {
	it.each(["my_casedb_x", "xledgerdb", "casedb_codes", "stock_ledgerdb"])(
		"refuses %s",
		(tag) => {
			expect(isReservedInstanceTag(tag)).toBe(true);
		},
	);
	it.each(["my_CaseDB", "stock_LedgerDB_codes", "case_db", "ledger_db_x"])(
		"admits %s, since the runtime's test is case-sensitive",
		(tag) => {
			expect(isReservedInstanceTag(tag)).toBe(false);
			expect(lookupTagSchema.parse(tag)).toBe(tag);
		},
	);
	it.each(["casedb", "CaseDB", "LEDGERDB", "Results"])(
		"still refuses the whole name %s in any case",
		(tag) => {
			expect(reservedInstanceTagCause(tag)).toEqual({ kind: "name" });
		},
	);
	it("names the word, ledgerdb first as the runtime tests it", () => {
		expect(reservedInstanceTagCause("my_casedb_x")).toEqual({
			kind: "contains",
			word: "casedb",
		});
		expect(reservedInstanceTagCause("xledgerdb")).toEqual({
			kind: "contains",
			word: "ledgerdb",
		});
		expect(reservedInstanceTagCause("casedb_ledgerdb")).toEqual({
			kind: "contains",
			word: "ledgerdb",
		});
		expect(reservedInstanceTagCause("regions")).toBeNull();
	});
	it("refuses with the sentence that names the word and its other spelling", () => {
		const parsed = lookupTagSchema.safeParse("my_casedb_x");
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
			"Table tag contains casedb, and CommCare reads any tag containing casedb as its own data, so a table can't use it. You can write it as case_db instead.",
		]);
		expect(
			lookupTagSchema.safeParse("xledgerdb").error?.issues[0]?.message,
		).toBe(
			"Table tag contains ledgerdb, and CommCare reads any tag containing ledgerdb as its own data, so a table can't use it. You can write it as ledger_db instead.",
		);
		expect(lookupTagSchema.safeParse("casedb").error?.issues[0]?.message).toBe(
			"Table tag is a name CommCare reserves for its own data, so a table cannot use it. Pick another tag.",
		);
	});
});

describe("the tag's length", () => {
	it("is pinned to the 32 characters CommCare HQ's tag column stores", () => {
		/* proof/views/test_lookup_upload.py holds HQ's side: its upload keeps a
		 * 32-character tag's table and answers a 33-character one with a server
		 * error. A change here is a reviewed change against that column. */
		expect(LOOKUP_MAX_TAG_LENGTH).toBe(32);
	});
	it("admits a 32-character tag and refuses a 33-character one", () => {
		expect(lookupTagSchema.parse("t".repeat(32))).toBe("t".repeat(32));
		const refused = lookupTagSchema.safeParse("t".repeat(33));
		expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
			"Table tag must be at most 32 characters.",
		]);
	});
});
