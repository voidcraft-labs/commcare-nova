/**
 * The input step 1 left out of the lane as one no Nova document can hold,
 * tried through Nova's parser, commit gate and exports: a form that reads the
 * session's `supply_point_id`. The basic child case of its own menu's case
 * type and defect 20's `product_id` datum, which step 5 produces, are checked
 * at publish (`./publishChecks.test.ts`).
 *
 * Contract: a claim that Nova cannot produce an input is true only where
 * Nova's own parser, gate or exports say so. The plausible failure is a row
 * dropped from the lane on a belief its production boundary does not share.
 *
 * - **A form that reads the session's `supply_point_id`** (defect 20,
 *   under CommTrack). No menu of a Nova app supplies that datum, so the
 *   form could never open, and Nova's parser refuses the unknown datum
 *   (the unknown session value, finding 68); a read of a datum the form's
 *   entry declares is admitted. The path written as text, in a string or a
 *   label, reads nothing and is admitted, and every export writes the
 *   path's apostrophes as `&apos;`, so the bytes Nova sends do not hold the
 *   text HQ's substring test
 *   (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`) looks
 *   for; a save in HQ's form builder can write them plainly, which is why
 *   Nova's publish asks CommCare Supply off for such a form
 *   (`targeted-supply-point-text`). The control `targeted-supply-point-read`
 *   keeps the read from before the refusal, and the lane observes what HQ
 *   does with it.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";

const ID = "targeted-unproduced-inputs";
/** The path HQ's substring test looks for (`suite_xml/xml_models.py::session_var`). */
const SUPPLY_POINT_PATH =
	"instance('commcaresession')/session/data/supply_point_id";
const uuid = (name: string) => targetedUuid(ID, name);

interface HqApp {
	readonly _attachments: Readonly<Record<string, string>>;
}

/** The document as Nova's planner makes it and Nova's gate admits it, exported as Nova's upload holds it. */
function exported(doc: BlueprintDoc): HqApp {
	const made = targetedDocument({
		id: ID,
		rows: ["a dropped input, tried"],
		doc,
		expected: { intent: [] },
	});
	return expandDoc(hydratePersistedBlueprint(made.doc)) as unknown as HqApp;
}

describe("a form that reads the session's supply point", () => {
	const escapedSuffix =
		"(&apos;commcaresession&apos;)/session/data/supply_point_id";

	function visit(field: ReturnType<typeof f>): BlueprintDoc {
		return buildDoc({
			appId: ID,
			appName: "Stock",
			caseTypes: [
				{
					name: "client",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: uuid("module"),
					name: "Clients",
					caseType: "client",
					caseListConfig: caseListOf([
						plainColumn(uuid("name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: uuid("form"),
							name: "Visit",
							type: "followup",
							fields: [field],
						},
					],
				},
			],
		});
	}

	function held(calculate: string) {
		return f({ kind: "hidden", uuid: uuid("held"), id: "held", calculate });
	}

	it("is refused by Nova's parser where a hidden value reads the unknown datum", () => {
		expect(() => visit(held(SUPPLY_POINT_PATH))).toThrow(
			/session value named "supply_point_id"/,
		);
	});

	it("is admitted where the read is of a datum the form's entry declares", () => {
		const sources = Object.values(
			exported(visit(held("instance('commcaresession')/session/data/case_id")))
				._attachments,
		);
		expect(sources).toHaveLength(1);
	});

	const text = {
		"a hidden value holding the path as text": held(`"${SUPPLY_POINT_PATH}"`),
		"a label that says the path": f({
			kind: "text",
			uuid: uuid("held"),
			id: "held",
			label: proseText(`Read ${SUPPLY_POINT_PATH} here`),
		}),
	};

	it.each(Object.entries(text))(
		"is admitted with %s, which reads nothing, and its export spells the path so HQ's test does not find it",
		(_name, field) => {
			const sources = Object.values(exported(visit(field))._attachments);
			expect(sources).toHaveLength(1);
			for (const source of sources) {
				expect(source).toContain(escapedSuffix);
				expect(source).not.toContain(SUPPLY_POINT_PATH);
			}
		},
	);
});
