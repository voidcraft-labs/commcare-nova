import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "../../../lib/__tests__/docHelpers";
import {
	containerScenarios,
	containerWireFixture,
} from "../../../lib/commcare/__tests__/containerWireFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "../../../lib/domain";
import { proseText } from "../../../lib/domain/prose";
import {
	liveCountEntryDoc,
	sectionEntryDoc,
} from "../../../lib/preview/engine/__tests__/fixtures/sectionEntry";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-container-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });

/**
 * The query repeats `ContainerRuntimeTest` follows through entry in the count
 * placement (part 04's gated run G2), beyond the corpus's container documents
 * it also reads (`query`, `nested-query`, `query-conditional-parent`,
 * `init-add`). Each is admitted by Nova's validator, and Nova chooses each
 * repeat's placement by its own rule; the producer checks the placement it
 * chose, so a change to the rule fails here rather than as a Core run that
 * reads the wrong shape.
 *
 * - `query-follows`: a registration form whose `members` query reads the
 *   form's `order` answer (`a b c`, `c b a` reversed, `a` short), each row
 *   creating a member case, with a row's record, its index and the rows made
 *   so far read by Hidden Values.
 * - `query-nested-gated`: a `sites` query under a group shown only once
 *   `show` is yes, and in each site a `plots` query reading that site's
 *   record (`p1 p2` for `s1`, `p3` for `s2`).
 * - `query-hidden-row`: two repeats over `a b c` whose condition hides the
 *   row for `b`. `held` holds model iteration, as a publish records it;
 *   `counted` takes the placement Nova's rule gives a repeat with a
 *   condition, the count placement.
 */
const QUERY_REPEAT_SCENARIOS = [
	"query-follows",
	"query-nested-gated",
	"query-hidden-row",
] as const;
type QueryRepeatScenario = (typeof QUERY_REPEAT_SCENARIOS)[number];

const text = (id: string, extra: Partial<FieldSpec> = {}) =>
	f({ kind: "text", id, label: proseText(id), ...extra } as FieldSpec);
const queryRepeat = (id: string, idsQuery: string, children: FieldSpec[]) =>
	f({
		kind: "repeat",
		id,
		label: proseText(id),
		repeat_mode: "query_bound",
		data_source: { ids_query: idsQuery },
		children,
	});

function queryRepeatDoc(scenario: QueryRepeatScenario): BlueprintDoc {
	if (scenario === "query-hidden-row") {
		const hiding = (id: string, extra: Partial<FieldSpec> = {}) =>
			f({
				kind: "repeat",
				id,
				label: proseText(id),
				repeat_mode: "query_bound",
				data_source: { ids_query: "'a b c'" },
				relevant: "position() != 1",
				...extra,
				children: [
					f({ kind: "hidden", id: "record", calculate: "current()/../@id" }),
				],
			} as FieldSpec);
		return buildDoc({
			appName: "Containers query-hidden-row",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								hiding("held", { placement: "model-iteration" }),
								hiding("counted"),
							],
						},
					],
				},
			],
		});
	}
	if (scenario === "query-follows") {
		const nameWriter = (caseType: string) =>
			text("case_name", { caseWrite: { caseType, property: "case_name" } });
		const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
		return buildDoc({
			appName: "Containers query-follows",
			caseTypes: ["household", "member"].map((name) => ({
				name,
				...(name === "member" && { parent_type: "household" }),
				properties: [{ name: "case_name", label: proseText("Name") }],
			})),
			modules: [
				{
					name: "Households",
					caseType: "household",
					caseListConfig: list(),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								text("order", { default_value: "'full'" }),
								nameWriter("household"),
								queryRepeat(
									"members",
									"if(#form/order = 'reverse', 'c b a', if(#form/order = 'short', 'a', 'a b c'))",
									[
										nameWriter("member"),
										text("note"),
										f({
											kind: "hidden",
											id: "record",
											calculate: "current()/../@id",
										}),
										f({
											kind: "hidden",
											id: "ordinal",
											calculate: "current()/../@index",
										}),
										f({
											kind: "hidden",
											id: "made",
											calculate: "current()/../../@current_index",
										}),
									],
								),
							],
						},
					],
				},
				{
					name: "Members",
					caseType: "member",
					caseListOnly: true,
					caseListConfig: list(),
					forms: [],
				},
			],
		});
	}
	return buildDoc({
		appName: "Containers query-nested-gated",
		modules: [
			{
				name: "M",
				forms: [
					{
						name: "F",
						type: "survey",
						fields: [
							text("show", { default_value: "'no'" }),
							f({
								kind: "group",
								id: "page",
								label: proseText("Sites"),
								relevant: "#form/show = 'yes'",
								children: [
									queryRepeat("sites", "'s1 s2'", [
										f({
											kind: "hidden",
											id: "site",
											calculate: "current()/../@id",
										}),
										queryRepeat(
											"plots",
											"if(#form/page/sites/site = 's1', 'p1 p2', 'p3')",
											[
												f({
													kind: "hidden",
													id: "plot",
													calculate: "current()/../@id",
												}),
												text("note"),
											],
										),
									]),
								],
							}),
						],
					},
				],
			},
		],
	});
}

/** The local form must hold the count placement for every query repeat the
 * scenario names: the generated ids node in the wrapper and the guard on the
 * row, which the Core run depends on. */
const COUNT_PLACED: Record<QueryRepeatScenario, readonly string[]> = {
	"query-follows": ["/data/members"],
	"query-nested-gated": ["/data/page/sites", "/data/page/sites/item/plots"],
	"query-hidden-row": ["/data/counted"],
};

/** The query repeats a scenario holds in model iteration: the setvalue that
 * gives each row its place from `@current_index`. */
const MODEL_ITERATED: Record<QueryRepeatScenario, readonly string[]> = {
	"query-follows": [],
	"query-nested-gated": [],
	"query-hidden-row": ["/data/held"],
};

function admitted(scenario: string, doc: BlueprintDoc): BlueprintDoc {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length > 0)
		throw new Error(
			`Nova's validator refuses the container scenario ${scenario} (${findings
				.map((finding) => `${finding.code}: ${finding.message}`)
				.join("; ")}), so no device would receive it.`,
		);
	return doc;
}

/** Writes a scenario's local form, the source HQ regenerates from, and the
 * app JSON HQ imports; returns the local form. */
function emit(scenario: string, doc: BlueprintDoc): string {
	const hq = expandDoc(doc);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget: NATIVE_RUNTIME_TARGET,
		}),
	);
	const form = Object.values(hq._attachments)[0];
	if (typeof form !== "string") throw new Error("Missing XForm");
	const local = zip
		.getEntries()
		.filter(
			(e) => e.entryName.endsWith(".xml") && e.entryName.startsWith("modules-"),
		);
	if (local.length !== 1)
		throw new Error(JSON.stringify(zip.getEntries().map((e) => e.entryName)));
	const localForm = zip.readAsText(local[0]);
	writeFileSync(resolve(output, `container-${scenario}.xml`), localForm);
	writeFileSync(resolve(output, `container-${scenario}.source.xml`), form);
	writeFileSync(
		resolve(output, `container-${scenario}.json`),
		JSON.stringify(hq),
	);
	return localForm;
}

for (const scenario of [
	...containerScenarios,
	"section-entry",
	"live-count-entry",
	"live-count-effects",
] as const) {
	const doc =
		scenario === "live-count-effects"
			? liveCountEntryDoc(true)
			: scenario === "live-count-entry"
				? liveCountEntryDoc()
				: scenario === "section-entry"
					? sectionEntryDoc()
					: containerWireFixture(scenario);
	emit(scenario, doc);
}

// Built after every corpus scenario, so the identities those documents mint
// stay where the corpus's own build of them puts them.
for (const scenario of QUERY_REPEAT_SCENARIOS) {
	const form = emit(scenario, admitted(scenario, queryRepeatDoc(scenario)));
	for (const wrapper of COUNT_PLACED[scenario]) {
		const id = wrapper.slice(wrapper.lastIndexOf("/") + 1);
		for (const nodeset of [
			`${wrapper}/nova_query_ids_${id}`,
			`${wrapper}/item/nova_query_id_${id}`,
		])
			if (!form.includes(`nodeset="${nodeset}"`))
				throw new Error(
					`The ${scenario} form holds no bind for ${nodeset}, so Nova did not place ${wrapper} by count and the Core run would read another shape.`,
				);
	}
	for (const wrapper of MODEL_ITERATED[scenario])
		if (!form.includes(`ref="${wrapper}/item/@index"`))
			throw new Error(
				`The ${scenario} form sets no ${wrapper}/item/@index, so Nova did not write ${wrapper} in model iteration and the Core run would read another shape.`,
			);
}
