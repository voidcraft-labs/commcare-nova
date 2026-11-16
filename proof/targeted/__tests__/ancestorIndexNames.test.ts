/**
 * `targeted-ancestor-index-names` holds the walks its intent values witness.
 *
 * Contract: the document is admitted, the Member visits menu is emitted
 * advanced and every other menu basic, and each form under test reads the
 * household through the index the app links its case by: `index/home` from a
 * member in the basic and the advanced menu (with HQ's load metadata
 * `#case/home/remark`), `index/host` from a pledge; and each expectation
 * opens its form under the session values the form's entry declares. The
 * plausible failures: a document change that leaves the forms walking
 * `parent` (the lane's values would then hold a read Nova no longer writes),
 * a menu no longer advanced, or an expectation opening its form on session
 * values its entry does not have, which Core would read as blank and the
 * expectation would then hold the wrong cause. The observations are the
 * document's HQ import file and its expectations.
 */

import { findOne } from "domutils";
import { describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import {
	entrySessionDatums,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { parseXml } from "@/lib/commcare/xmlParse";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { Uuid } from "@/lib/domain";
import {
	ancestorIndexNames,
	ancestorIndexNamesUuid as uuid,
} from "../documents/ancestorIndexNames";
import type { Expected } from "../expected";

const document = ancestorIndexNames();
const doc = hydratePersistedBlueprint(document.doc);
const app = expandDoc(doc);

/** The HQ form of `formUuid`, with its source. */
function hqForm(formUuid: Uuid) {
	const position = doc.moduleOrder.findIndex((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).includes(formUuid),
	);
	const index = (doc.formOrder[doc.moduleOrder[position]] ?? []).indexOf(
		formUuid,
	);
	const form = app.modules[position]?.forms[index] as unknown as {
		readonly unique_id: string;
		readonly case_references_data?: { readonly load?: unknown };
	};
	const source = (app._attachments as Record<string, string>)[
		`${form.unique_id}.xml`
	];
	if (source === undefined) throw new Error("The form has its source.");
	return { form, source, command: `m${position}-f${index}` };
}

/** The `calculate` of the Hidden Value reading the household. */
function householdCalculate(source: string): string | undefined {
	return findOne(
		(element) =>
			element.name === "bind" &&
			element.attribs.nodeset === "/data/household_remark",
		parseXml(source).children,
	)?.attribs.calculate;
}

/** The session values the entry of `formUuid` takes, as the suite writes
 *  them (`formLinkProjection.ts::entrySessionDatums`). */
function entryDatums(formUuid: Uuid): readonly string[] {
	const moduleUuid = doc.moduleOrder.find((candidate) =>
		(doc.formOrder[candidate] ?? []).includes(formUuid),
	);
	if (moduleUuid === undefined) throw new Error("The form is on a menu.");
	return entrySessionDatums(
		doc,
		formLinkProjectionContext(doc),
		moduleUuid,
		formUuid,
	).map((datum) => datum.id);
}

/** The value the question starting on the household's remark is set to. */
function startingValue(source: string): string | undefined {
	return findOne(
		(element) =>
			element.name === "setvalue" &&
			element.attribs.ref === "/data/remark_seen",
		parseXml(source).children,
	)?.attribs.value;
}

const walk = (datum: string, index: string) =>
	"instance('casedb')/casedb/case[@case_id = " +
	`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/${datum}]` +
	`/index/${index}]/remark`;

describe("targeted-ancestor-index-names", () => {
	it("is advanced in Member visits alone", () => {
		expect(
			Object.fromEntries(
				doc.moduleOrder.map((moduleUuid) => [
					doc.modules[moduleUuid]?.name,
					emittedModuleKind(doc, moduleUuid),
				]),
			),
		).toEqual({
			Households: "basic",
			Members: "basic",
			"Member visits": "advanced",
			Visits: "basic",
			Pledges: "basic",
		});
	});

	it("reads the household through each case's own index", () => {
		const member = hqForm(uuid("check-member"));
		expect(householdCalculate(member.source)).toBe(walk("case_id", "home"));
		expect(startingValue(member.source)).toBe(walk("case_id", "home"));
		expect(member.form.case_references_data?.load).toMatchObject({
			"/data/household_remark": ["#case/home/remark"],
		});
		const visit = hqForm(uuid("visit-member"));
		expect(householdCalculate(visit.source)).toBe(
			walk("case_id_load_member1", "home"),
		);
		expect(startingValue(visit.source)).toBe(
			walk("case_id_load_member1", "home"),
		);
		const pledge = hqForm(uuid("check-pledge"));
		expect(householdCalculate(pledge.source)).toBe(walk("case_id", "host"));
		expect(startingValue(pledge.source)).toBe(walk("case_id", "host"));
		expect(pledge.form.case_references_data?.load).toMatchObject({
			"/data/household_remark": ["#case/host/remark"],
		});
	});

	it("opens each form under its own command and exactly its entry's case values", () => {
		const expected = document.expected as Expected;
		expect(expected.intent.length).toBeGreaterThan(0);
		for (const expectation of expected.intent) {
			const { command } = hqForm(expectation.form);
			expect(expectation.request.session?.command).toBe(command);
			expect(Object.keys(expectation.request.session?.data ?? {})).toEqual(
				entryDatums(expectation.form),
			);
		}
	});
});
