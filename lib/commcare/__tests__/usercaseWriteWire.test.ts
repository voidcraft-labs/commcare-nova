import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { usercaseWriteFixture } from "./usercaseWriteFixture";

function one(elements: Element[]) {
	expect(elements).toHaveLength(1);
	const element = elements[0];
	if (!element) throw new Error("Missing exported element");
	return element;
}
function children(element: Element, name: string) {
	return element.children.filter(isTag).filter((e) => e.name === name);
}
function child(element: Element, name: string) {
	return one(children(element, name));
}
function root(xml: string) {
	new SaxesParser({ xmlns: true }).write(xml).close();
	return one(parseDocument(xml, { xmlMode: true }).children.filter(isTag));
}
function exported(doc: BlueprintDoc) {
	expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
		true,
	);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	const form = hq.modules[0].forms[0];
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	const suite = root(zip.readAsText("suite.xml"));
	const entries = children(suite, "entry");
	const entry = one(
		entries.filter((e) =>
			children(e, "form").some((f) => textContent(f) === form.xmlns),
		),
	);
	const model = child(
		child(root(zip.readAsText("modules-0/forms-0.xml")), "h:head"),
		"model",
	);
	const data = child(
		one(children(model, "instance").filter((i) => !i.attribs.src)),
		"data",
	);
	return { form, zip, entries, entry, model, data };
}

// Independent native HQ contract: XForm._add_usercase and EntriesHelper's
// extra datum/assertion builders. Native execution uses these same exported
// fixtures in scripts/fixtures/hq, never a conditional local-checkout unit test.
const selector =
	"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]";
it.each(["survey", "followup"] as const)(
	"joins the worker write, entry lookup, and localized refusal (%s)",
	(type) => {
		const output = exported(usercaseWriteFixture(type));
		expect(output.form.actions.usercase_update).toMatchObject({
			condition: { type: "always" },
			update: {
				visits_done: {
					question_path: "/data/visits_so_far",
					update_mode: "always",
				},
			},
		});
		expect(output.form.actions.usercase_preload).toMatchObject({
			condition: { type: "never" },
			preload: {},
		});
		const session = child(output.entry, "session");
		expect(
			children(session, "datum")
				.filter((d) => d.attribs.id === "usercase_id")
				.map((d) => d.attribs),
		).toEqual([{ id: "usercase_id", function: `${selector}/@case_id` }]);
		const assertions = child(output.entry, "assertions");
		const assertion = child(assertions, "assert");
		expect(assertion.attribs).toEqual({ test: `count(${selector}) = 1` });
		const locale = child(child(assertion, "text"), "locale");
		expect(locale.attribs).toEqual({
			id: "case_autoload.usercase.case_missing",
		});
		const strings = output.zip
			.readAsText("default/app_strings.txt")
			.split("\n")
			.filter((line) => line.startsWith(`${locale.attribs.id}=`));
		expect(strings).toHaveLength(1);
		expect(
			strings[0].slice(locale.attribs.id.length + 1).trim().length,
		).toBeGreaterThan(0);
		const order = output.entry.children.filter(isTag).map((e) => e.name);
		expect(
			order.filter((name) => ["session", "assertions", "stack"].includes(name)),
		).toEqual(
			type === "followup"
				? ["session", "assertions", "stack"]
				: ["session", "assertions"],
		);
		expect(
			children(output.entry, "instance")
				.filter((e) => ["casedb", "commcaresession"].includes(e.attribs.id))
				.map((e) => e.attribs),
		).toEqual([
			{ id: "casedb", src: "jr://instance/casedb" },
			{ id: "commcaresession", src: "jr://instance/session" },
		]);
		const block = child(child(output.data, "commcare_usercase"), "case");
		expect(block.attribs).toEqual({
			case_id: "",
			date_modified: "",
			user_id: "",
			xmlns: "http://commcarehq.org/case/transaction/v2",
		});
		expect(block.children.filter(isTag).map((e) => e.name)).toEqual(["update"]);
		expect(
			child(block, "update")
				.children.filter(isTag)
				.map((e) => e.name),
		).toEqual(["visits_done"]);
		const binds = children(output.model, "bind")
			.filter((b) => b.attribs.nodeset.startsWith("/data/commcare_usercase/"))
			.map((b) => b.attribs);
		expect(
			binds.toSorted((a, b) => a.nodeset.localeCompare(b.nodeset)),
		).toEqual(
			[
				{
					nodeset: "/data/commcare_usercase/case/@date_modified",
					calculate: "/data/meta/timeEnd",
					type: "xsd:dateTime",
				},
				{
					nodeset: "/data/commcare_usercase/case/@user_id",
					calculate: "/data/meta/userID",
				},
				{
					nodeset: "/data/commcare_usercase/case/@case_id",
					calculate: "instance('commcaresession')/session/data/usercase_id",
				},
				{
					nodeset: "/data/commcare_usercase/case/update/visits_done",
					calculate: "/data/visits_so_far",
					relevant: "count(/data/visits_so_far) > 0",
				},
			].toSorted((a, b) => a.nodeset.localeCompare(b.nodeset)),
		);
		const browseEntries = output.entries.filter(
			(e) => children(e, "form").length === 0,
		);
		expect(browseEntries).toHaveLength(type === "followup" ? 1 : 0);
		for (const browse of browseEntries) {
			expect(children(browse, "assertions")).toEqual([]);
			expect(
				children(child(browse, "session"), "datum").filter(
					(d) => d.attribs.id === "usercase_id",
				),
			).toEqual([]);
		}
	},
);

it("removes all worker entry requirements and case effects when the last writer is cleared", () => {
	const doc = usercaseWriteFixture("survey");
	const before = exported(doc);
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const fieldUuid = doc.fieldOrder[formUuid][1];
	expect(children(before.data, "commcare_usercase")).toHaveLength(1);
	const verdict = mutationCommitVerdict(
		doc,
		[
			{
				kind: "updateField",
				targetKind: "text",
				uuid: fieldUuid,
				patch: { caseWrite: null },
			},
		],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(true);
	const after = exported(verdict.nextDoc);
	expect(after.form.actions.usercase_update).toMatchObject({
		condition: { type: "never" },
		update: {},
	});
	expect(children(after.data, "commcare_usercase")).toEqual([]);
	expect(
		children(after.model, "bind").filter((e) =>
			e.attribs.nodeset.startsWith("/data/commcare_usercase/"),
		),
	).toEqual([]);
	expect(
		children(after.entry, "session")
			.flatMap((s) => children(s, "datum"))
			.filter((d) => d.attribs.id === "usercase_id"),
	).toEqual([]);
	expect(children(after.entry, "assertions")).toEqual([]);
	expect(
		children(after.entry, "instance").filter((e) => e.attribs.id === "casedb"),
	).toEqual([]);
});

it("exports the current question path and explicitly retargeted worker property", () => {
	const doc = usercaseWriteFixture("survey");
	exported(doc);
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const fieldUuid = doc.fieldOrder[formUuid][1];
	const propertyUuid = doc.userPropertyOrder?.[0];
	if (!propertyUuid) throw new Error("Missing worker property");
	// Worker-case destinations are explicit names. Rename the declaration and
	// its writer atomically; an isolated question-id edit never implies this.
	const verdict = mutationCommitVerdict(
		doc,
		[
			{
				kind: "updateUserProperty",
				uuid: propertyUuid,
				patch: { slug: "home_visits" },
			},
			{
				kind: "updateField",
				targetKind: "text",
				uuid: fieldUuid,
				patch: {
					id: "current_count",
					caseWrite: { caseType: "commcare-user", property: "home_visits" },
				},
			},
		],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(true);
	const output = exported(verdict.nextDoc);
	expect(output.form.actions.usercase_update.update).toEqual({
		home_visits: {
			question_path: "/data/current_count",
			update_mode: "always",
		},
	});
	const block = child(child(output.data, "commcare_usercase"), "case");
	expect(
		child(block, "update")
			.children.filter(isTag)
			.map((e) => e.name),
	).toEqual(["home_visits"]);
	expect(
		children(output.model, "bind")
			.filter((e) =>
				e.attribs.nodeset.startsWith("/data/commcare_usercase/case/update/"),
			)
			.map((e) => e.attribs),
	).toEqual([
		{
			nodeset: "/data/commcare_usercase/case/update/home_visits",
			calculate: "/data/current_count",
			relevant: "count(/data/current_count) > 0",
		},
	]);
});
