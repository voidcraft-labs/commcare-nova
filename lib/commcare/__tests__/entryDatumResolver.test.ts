/**
 * Which datum a session read prints when two datums of an entry supply it.
 * From step 5 a form may create two child cases of one type outside a
 * repeat, so its entry holds two `case_id_new_<type>_<i>` datums that both
 * supply `new-child-case`. HQ's form-link matcher carries the first source
 * datum of a type (`workflow.py::_find_best_match`), so the read names the
 * first in entry order. Catches a resolver that keeps the last row it saw.
 */
import { expect, it } from "vitest";
import {
	type EntryDatumId,
	entryDatumIdResolver,
	entryDatumIds,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import type { CaseOperation } from "@/lib/domain";
import { childCreate, OWN, own, placementFixture } from "./placementFixture";

const KID = { kind: "new-child-case", caseType: "kid" } as const;

it("resolves a ref two rows supply to the first row", () => {
	const rows: EntryDatumId[] = [
		{ id: "case_id", refs: [], scalar: true },
		{ id: "case_id_new_kid_0", refs: [KID], scalar: true },
		{ id: "case_id_new_kid_1", refs: [KID], scalar: true },
	];
	expect(entryDatumIdResolver(rows)(KID)).toBe("case_id_new_kid_0");
	expect(entryDatumIdResolver([...rows].reverse())(KID)).toBe(
		"case_id_new_kid_1",
	);
});

it("names the first of two child creates of one type that a follow-up's entry gives a datum", () => {
	const { doc, formUuid, moduleUuid } = placementFixture("followup", {
		operations: (formType) => [
			own(),
			childCreate("first", formType),
			{
				...childCreate("second", formType),
				name: childCreate("first", formType).name,
			} as CaseOperation,
		],
	});
	const rows = entryDatumIds(
		doc,
		formLinkProjectionContext(doc),
		moduleUuid,
		formUuid,
	);
	expect(
		rows.flatMap((row) =>
			row.refs.some((ref) => ref.kind === "new-child-case") ? [row.id] : [],
		),
	).toEqual(["case_id_new_kid_0", "case_id_new_kid_1"]);
	expect(entryDatumIdResolver(rows)(KID)).toBe("case_id_new_kid_0");
});

it("names the registration's own new case by the datum HQ mints for it", () => {
	const { doc, formUuid, moduleUuid } = placementFixture("registration", {
		operations: (formType) => [
			own({ uuid: OWN, name: childCreate("x", formType).name }),
		],
	});
	const rows = entryDatumIds(
		doc,
		formLinkProjectionContext(doc),
		moduleUuid,
		formUuid,
	);
	expect(entryDatumIdResolver(rows)({ kind: "new-case" })).toBe(
		"case_id_new_patient_0",
	);
});
