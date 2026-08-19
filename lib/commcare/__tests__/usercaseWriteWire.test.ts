// Saving a form answer into the worker's own record, across every emitted
// surface.
//
// The three surfaces have to agree because they are three renderings of one
// decision: HQ JSON carries `usercase_update` for an HQ import, the local
// `.ccz` carries the suite datum plus the XForm block for a device, and the
// HQ-upload XForm carries the same block for a project that builds its own
// suite. A form that writes to the worker's record on one path and not another
// is a silent data-loss bug — the answer is collected either way and simply
// never lands.
//
// The two facts every assertion here rests on, verified in
// `~/code/commcare-hq` rather than restated from a doc:
//
//   - `app_manager/xform.py::XForm._add_usercase` appends a
//     `commcare_usercase` wrapper holding one `XFormCaseBlock(self,
//     'commcare_usercase/')` with `add_case_updates` and nothing else. There
//     is no `<create>` arm; HQ never creates a usercase from a form.
//   - `suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums`
//     emits the computed `usercase_id` datum and
//     `::add_usercase_id_assertion` the `count(...) = 1` guard beside it,
//     both composed from `UsercaseXPath().case()`.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	SESSION_USERCASE_ID,
	USERCASE_ID_FUNCTION,
	USERCASE_MISSING_ASSERT_TEST,
	USERCASE_MISSING_LOCALE_ID,
} from "@/lib/commcare/usercaseWire";
import type { BlueprintDoc } from "@/lib/domain";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const VISITS_UUID = testUuid("worker-property-visits");

const CCHQ_ROOT = join(homedir(), "code/commcare-hq");
const CCHQ_ENTRY_FIXTURE = join(
	CCHQ_ROOT,
	"corehq/apps/app_manager/tests/data/suite/usercase_entry.xml",
);
const CCHQ_FORM_PREP_TEST = join(
	CCHQ_ROOT,
	"corehq/apps/app_manager/tests/test_form_preparation_v2.py",
);

/** Every element matching `name`, with its attributes, in document order. */
function elementsNamed(
	xml: string,
	name: string,
): Array<Readonly<Record<string, string>>> {
	const found: Array<Readonly<Record<string, string>>> = [];
	const parser = new Parser(
		{
			onopentag(tag, attributes) {
				if (tag === name) found.push({ ...attributes });
			},
		},
		{ xmlMode: true },
	);
	parser.end(xml);
	return found;
}

/** The order of the `<entry>` children, which HQ's own fixture pins. */
function entryChildOrder(suiteXml: string): string[] {
	const order: string[] = [];
	let depth = 0;
	let insideEntry = false;
	const parser = new Parser(
		{
			onopentag(tag) {
				if (tag === "entry" && !insideEntry) {
					insideEntry = true;
					depth = 0;
					return;
				}
				if (insideEntry) {
					if (depth === 0) order.push(tag);
					depth += 1;
				}
			},
			onclosetag(tag) {
				if (!insideEntry) return;
				if (tag === "entry" && depth === 0) {
					insideEntry = false;
					return;
				}
				depth -= 1;
			},
		},
		{ xmlMode: true },
	);
	parser.end(suiteXml);
	return order;
}

/**
 * A followup form whose only worker-record write is `visits_done`.
 *
 * `slug` is a parameter because the destination is a DECLARED worker property
 * — a rename has to travel to the wire, and the only way to see that is to
 * build the same doc under two slugs.
 */
function workerWritingDoc(slug = "visits_done"): BlueprintDoc {
	const doc = buildDoc({
		appName: "Worker record wire",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "visit_note",
								label: proseText("Visit note"),
								caseWrite: { caseType: "patient", property: "note" },
							}),
							f({
								kind: "text",
								id: "visits_so_far",
								label: proseText("Visits so far"),
								caseWrite: {
									caseType: USERCASE_CASE_TYPE,
									property: slug,
								},
							}),
						],
					},
				],
			},
		],
	});
	doc.userProperties = {
		[VISITS_UUID]: { uuid: VISITS_UUID, slug, label: "Visits so far" },
	};
	return doc;
}

describe("saving into the worker's own record", () => {
	it("carries usercase_update through HQ JSON, and leaves preload alone", () => {
		const hq = expandDoc(workerWritingDoc());
		const actions = hq.modules[0].forms[0].actions;

		expect(actions.usercase_update.condition.type).toBe("always");
		expect(actions.usercase_update.update).toEqual({
			visits_done: {
				question_path: "/data/visits_so_far",
				update_mode: "always",
			},
		});
		// A stated fence rather than an omission: `#user/<prop>` already
		// compiles to the same `casedb` join, so a preload would be a second
		// representation of one read.
		expect(actions.usercase_preload.condition.type).toBe("never");
		expect(actions.usercase_preload.preload).toEqual({});
	});

	it("emits the computed datum and its assertion on the suite entry", () => {
		const doc = workerWritingDoc();
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const suite = zip.readAsText("suite.xml");

		const usercaseDatum = elementsNamed(suite, "datum").find(
			(datum) => datum.id === "usercase_id",
		);
		expect(usercaseDatum?.function).toBe(USERCASE_ID_FUNCTION);
		// A computed datum selects rather than prompts, so it carries no
		// nodeset, no value, and no detail to show.
		expect(usercaseDatum?.nodeset).toBeUndefined();
		expect(usercaseDatum?.value).toBeUndefined();

		const assertion = elementsNamed(suite, "assert")[0];
		expect(assertion?.test).toBe(USERCASE_MISSING_ASSERT_TEST);
		expect(suite).toContain(`<locale id="${USERCASE_MISSING_LOCALE_ID}"/>`);
	});

	it("puts assertions between the session and the stack", () => {
		// `suite_xml/xml_models.py::Entry`'s `ORDER` covers only `form, post,
		// command, instance, datums` and leaves the rest to field-declaration
		// order, so this order is only knowable from a fixture carrying both
		// blocks — `case_list_form/case-list-form-suite-usercase.xml`.
		const doc = workerWritingDoc();
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const order = entryChildOrder(zip.readAsText("suite.xml"));

		expect(order).toContain("assertions");
		expect(order.indexOf("session")).toBeLessThan(order.indexOf("assertions"));
		expect(order.indexOf("assertions")).toBeLessThan(order.indexOf("stack"));
	});

	it("emits the case block and its three attribute binds on the local XForm", () => {
		// Local only, and that is the existing division rather than a gap: the
		// HQ-upload XForm ships WITHOUT case blocks and HQ regenerates them
		// from `actions` server-side (`compiler.ts` calls `addCaseBlocks` on the
		// `.ccz` path alone, mirroring `xform.py::add_case_and_meta`). The HQ
		// surface is covered by the `usercase_update` assertion above.
		const doc = workerWritingDoc();
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const localXform = zip.readAsText("modules-0/forms-0.xml");

		for (const xform of [localXform]) {
			const binds = new Map(
				elementsNamed(xform, "bind").map((bind) => [bind.nodeset, bind]),
			);
			// The bind, not a setvalue: `_add_usercase_bind` uses `add_bind`,
			// and the datum is computed at entry so the value is already there.
			expect(
				binds.get("/data/commcare_usercase/case/@case_id")?.calculate,
			).toBe(SESSION_USERCASE_ID);
			// `XFormCaseBlock.elem`'s own two binds, which every case block gets.
			expect(
				binds.get("/data/commcare_usercase/case/@date_modified")?.calculate,
			).toBe("/data/meta/timeEnd");
			expect(
				binds.get("/data/commcare_usercase/case/@date_modified")?.type,
			).toBe("xsd:dateTime");
			expect(
				binds.get("/data/commcare_usercase/case/@user_id")?.calculate,
			).toBe("/data/meta/userID");

			const write = binds.get(
				"/data/commcare_usercase/case/update/visits_done",
			);
			expect(write?.calculate).toBe("/data/visits_so_far");
			// The same guard every other update bind carries: a hidden question
			// has no data node at submission, and without this its bind would
			// fire with an empty result and erase what is on the record.
			expect(write?.relevant).toBe("count(/data/visits_so_far) > 0");
			// HQ never creates a usercase from a form, so the block has no
			// `<create>` and the wrapper holds exactly one case element.
			expect(xform).toContain("<commcare_usercase>");
			expect(xform).not.toContain("/data/commcare_usercase/case/create");
		}
	});

	it("follows a worker-property rename to the wire, because the slug is the destination", () => {
		const renamed = workerWritingDoc("home_visits");
		const zip = new AdmZip(
			compileCcz(expandDoc(renamed), renamed.appName, renamed),
		);
		const binds = elementsNamed(
			zip.readAsText("modules-0/forms-0.xml"),
			"bind",
		).map((bind) => bind.nodeset);

		expect(binds).toContain("/data/commcare_usercase/case/update/home_visits");
		expect(binds).not.toContain(
			"/data/commcare_usercase/case/update/visits_done",
		);
	});

	it("declares casedb and commcaresession on an entry that has no case datum", () => {
		// The gap this closes: a survey form's only write can be to the worker's
		// record, so it has no case-loading datum and nothing else would declare
		// `casedb`. A missing declaration resolves to NOTHING at runtime with no
		// build-time error (`CommCareInstanceInitializer::loadFixtureRoot`).
		const doc = buildDoc({
			appName: "Worker survey",
			modules: [
				{
					name: "Check in",
					forms: [
						{
							name: "Daily",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "visits_so_far",
									label: proseText("Visits so far"),
									caseWrite: {
										caseType: USERCASE_CASE_TYPE,
										property: "visits_done",
									},
								}),
							],
						},
					],
				},
			],
		});
		doc.userProperties = {
			[VISITS_UUID]: {
				uuid: VISITS_UUID,
				slug: "visits_done",
				label: "Visits so far",
			},
		};

		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const suite = zip.readAsText("suite.xml");
		const declared = elementsNamed(suite, "instance").map(
			(instance) => instance.id,
		);

		expect(declared).toContain("casedb");
		expect(declared).toContain("commcaresession");

		// And the form actually carries the block. Emitting the datum and the
		// assertion without it would collect the answer, guard the entry on a
		// record it never touches, and write nothing — the worst of the three.
		const xform = zip.readAsText("modules-0/forms-0.xml");
		expect(xform).toContain("<commcare_usercase>");
		expect(elementsNamed(xform, "bind").map((bind) => bind.nodeset)).toContain(
			"/data/commcare_usercase/case/update/visits_done",
		);
	});

	it("leaves the standalone case-list browse entry alone", () => {
		// `get_extra_case_id_datums` requires `form.form_type == 'module_form'`,
		// and `add_usercase_id_assertion` follows the datum. Nova's browse entry
		// carries no form, so it gets neither — and it must not, because the
		// assertion would block browsing on a domain with no usercase rows.
		const doc = workerWritingDoc();
		const moduleUuid = doc.moduleOrder[0];
		doc.modules[moduleUuid].caseListOnly = true;
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const suite = zip.readAsText("suite.xml");

		const browseEntryHasUsercase = suite
			.split("<entry>")
			.filter((entry) => !entry.includes("<form>"))
			.some((entry) => entry.includes("usercase_id"));
		expect(browseEntryHasUsercase).toBe(false);
	});

	it.skipIf(
		!existsSync(CCHQ_ENTRY_FIXTURE) || !existsSync(CCHQ_FORM_PREP_TEST),
	)("matches the shapes CommCare HQ's own fixtures pin", () => {
		const entryFixture = readFileSync(CCHQ_ENTRY_FIXTURE, "utf8");
		const formPrep = readFileSync(CCHQ_FORM_PREP_TEST, "utf8");

		expect(entryFixture).toContain(`function="${USERCASE_ID_FUNCTION}"`);
		expect(entryFixture).toContain(`test="${USERCASE_MISSING_ASSERT_TEST}"`);
		expect(entryFixture).toContain(
			`<locale id="${USERCASE_MISSING_LOCALE_ID}"/>`,
		);
		// The nodeset shape, from the inline partial in
		// `test_update_usercase_edit_update_mode`. Its `relevant` there is the
		// `SAVE_ONLY_EDITED_FORM_FIELDS` variant, which Nova does not emit.
		expect(formPrep).toContain(
			'nodeset="/data/commcare_usercase/case/update/case_name"',
		);
	});
});
