import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	mutationCommitVerdictWithPrevalidation,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import { runValidation } from "../validator/runner";
import { searchEmissionFixture } from "./searchEmissionFixture";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

function source(doc: ReturnType<typeof searchEmissionFixture>) {
	const form = doc.forms[doc.formOrder[doc.moduleOrder[1]][0]];
	const link = form.formLinks?.[0];
	if (!link) throw new Error("Fixture has a link");
	return { form, link };
}
it("preserves explicit new-case intent by selecting HQ's working automatic hydration path", () => {
	const doc = searchEmissionFixture("hidden-link");
	const before = structuredClone(doc);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	expect(hq.modules[1].forms[0].form_links[0].datums).toEqual([]);
	const suite = readXmlEvidence(
		new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText("suite.xml"),
	);
	const entry = onlyXml(
		xmlChildren(suite, "entry").filter(
			(node) => onlyXml(xmlChildren(node, "command")).attributes.id === "m1-f0",
		),
	);
	const create = onlyXml(
		xmlChildren(onlyXml(xmlChildren(entry, "stack")), "create"),
	);
	const query = onlyXml(xmlChildren(create, "query"));
	const selected = onlyXml(xmlChildren(create, "datum"));
	expect(selected.attributes.value).toBe(
		"instance('commcaresession')/session/data/case_id_new_patient_0",
	);
	expect(
		onlyXml(
			xmlChildren(query, "data").filter(
				(node) => node.attributes.key === "case_id",
			),
		).attributes.ref,
	).toBe(selected.attributes.value);
	expect(doc).toEqual(before);
});
it.each(["'other-patient'", "concat('patient-', '2')"])(
	"refuses a manual Search handover that HQ cannot hydrate: %s",
	(expression) => {
		const doc = searchEmissionFixture("hidden-link");
		const { form, link } = source(doc);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		for (const gate of [
			mutationCommitVerdict,
			mutationCommitVerdictWithPrevalidation,
		]) {
			const verdict = gate(
				doc,
				[
					{
						kind: "updateFormLink",
						formUuid: form.uuid,
						uuid: link.uuid,
						patch: { datums: [{ name: "case_id", xpath: xp(expression) }] },
					},
				],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok).toBe(false);
			if (verdict.ok) throw new Error("Unsafe Search handover committed");
			expect(
				verdict.findings.map((finding) => [
					finding.code,
					finding.location?.formUuid,
					finding.details?.linkUuid,
					finding.details?.datumIds,
				]),
			).toEqual([
				[
					"FORM_LINK_SEARCH_CASE_UNREPRESENTABLE",
					form.uuid,
					link.uuid,
					"case_id",
				],
			]);
		}
	},
);
it("keeps manual case selection available for a destination that opens on a list", () => {
	const doc = searchEmissionFixture("hidden-link");
	doc.modules[doc.moduleOrder[0]].caseSearchConfig = {};
	const { link } = source(doc);
	link.datums = [{ name: "case_id", xpath: xp("'other-patient'") }];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expect(expandDoc(doc).modules[1].forms[0].form_links[0].datums).toEqual([
		{ name: "case_id", xpath: "'other-patient'" },
	]);
});
it("keeps an existing selected case when the source has that selection", () => {
	const doc = searchEmissionFixture("hidden-link");
	const { form, link } = source(doc);
	form.type = "followup";
	link.datums = [
		{
			name: "case_id",
			xpath: xp("instance('commcaresession')/session/data/case_id"),
		},
	];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expect(expandDoc(doc).modules[1].forms[0].form_links[0].datums).toEqual([]);
});
