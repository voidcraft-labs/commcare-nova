/**
 * A form's read of an ancestor case walks the index the app links each type
 * to its parent by (`caseTypeDepths.ts::caseTypeHopMap`).
 *
 * Contract: in a menu of members chosen under their household, where the app
 * links a member to its household as `home`, a read of the household's
 * property walks `index/home` from the member, on the XForm, in HQ's load
 * metadata and in Preview, and the export reads back to the same document. An
 * advanced menu chooses the member among the cases whose `index/home` names
 * the household (`entries.py::get_parent_filter_by_ref_id`, from the load's
 * `case_index.reference_id`), and a basic one among those any child index of
 * which names it (`get_parent_filter`), so the walk reaches the household the
 * worker chose.
 *
 * The plausible failure: the read walking `index/parent` whatever the app's
 * links name, so a member that holds only `home` reads every household
 * property blank, and one that holds both reads another household than the
 * one the menu chose it under; or Nova's own test records naming the member's
 * household under `parent` while the read walks `home`.
 */
import { findOne } from "domutils";
import { describe, expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { evaluationScenarioCases } from "@/lib/preview/engine/evaluationScenario";
import { formSessionBindings } from "@/lib/preview/engine/formExpressionRuntime";
import {
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
} from "@/lib/preview/engine/xpathInstances";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import {
	advancedFixture,
	HOUSEHOLD_VISIT,
	OP,
	read,
	U,
	UNDER_TEST,
} from "../../__tests__/advancedPlacementFixture";
import { expandDoc } from "../../expander";
import { exportedBody, inputFor } from "../../reader/__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../reader/assemble";
import {
	judgeReadBack,
	readBody,
} from "../../reader/expressions/__tests__/readBackCorpus";
import { matchingResolver } from "../../reader/identity";
import { externalIdentityMap } from "../../reader/identityMap";
import { knownCaseTypesOf, readHqApp } from "../../reader/index";
import { serializeXml } from "../../serializeXml";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { parseXml } from "../../xmlParse";
import { serializeWire } from "../../xpath/wire/serialize";

const householdRemark: Expression = {
	kind: "term",
	term: { kind: "form-case", caseType: "household", property: "remark" },
};

/**
 * Members chosen under their household, advanced where `advanced`, whose
 * household's visit saves its remark and registers a member linked to it as
 * `identifier`, and whose follow-up shows its note only while the household
 * has no remark.
 */
function members(identifier: string, advanced: boolean): BlueprintDoc {
	return advancedFixture({
		formType: "followup",
		menu: "members",
		heldKind: advanced,
		operations: () => [
			{
				uuid: OP("own"),
				id: "member",
				action: "own",
				writes: [{ property: "age", value: read("age") }],
			},
		],
		configure: (doc) => {
			const remark = doc.fieldOrder[HOUSEHOLD_VISIT]?.[0] as Uuid;
			doc.forms[HOUSEHOLD_VISIT] = {
				...doc.forms[HOUSEHOLD_VISIT],
				caseOperations: [
					{
						uuid: OP("household"),
						id: "household",
						action: "own",
						writes: [{ property: "remark", value: term(formField(remark)) }],
					},
					{
						uuid: OP("member"),
						id: "member",
						action: "create",
						caseType: "member",
						target: { kind: "new" },
						name: term(formField(remark)),
						links: [
							{
								identifier,
								targetType: "household",
								target: { kind: "session" },
								relationship: "child",
							},
						],
					},
				],
			} as never;
			const note = U("note");
			doc.fields[note] = {
				...doc.fields[note],
				relevant: { kind: "is-blank", left: householdRemark },
			} as never;
		},
	}).doc;
}

/** The members menu's form under test, as the HQ import file holds it. */
function underTest(doc: BlueprintDoc) {
	const app = expandDoc(doc);
	const form = app.modules[1]?.forms[0] as unknown as {
		readonly unique_id: string;
		readonly actions?: { readonly load_update_cases?: unknown[] };
		readonly case_references_data?: { readonly load?: unknown };
	};
	const source = (app._attachments as Record<string, string>)[
		`${form.unique_id}.xml`
	];
	if (source === undefined) throw new Error("The form has its source.");
	return { form, source };
}

/** The `relevant` the note's bind carries. */
function noteRelevant(source: string): string | undefined {
	return findOne(
		(element) =>
			element.name === "bind" && element.attribs.nodeset === "/data/note",
		parseXml(source).children,
	)?.attribs.relevant;
}

/** The note's condition as Nova prints it over the member's datum, walking `index`. */
const printed = (datum: string, index: string) =>
	"string-length(string(instance('casedb')/casedb/case[@case_id = " +
	`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/${datum}]` +
	`/index/${index}]/remark)) = 0`;

describe("a read of the household from a member", () => {
	it("walks the index an advanced menu chose the member through", () => {
		for (const identifier of ["parent", "home"]) {
			const { form, source } = underTest(members(identifier, true));
			const [, own] = (form.actions?.load_update_cases ?? []) as {
				readonly case_index?: { readonly reference_id?: string };
			}[];
			// HQ's build narrows this load's list by `[index/<reference_id>=…]`.
			expect(own?.case_index?.reference_id).toBe(identifier);
			expect(noteRelevant(source)).toBe(
				printed("case_id_load_member1", identifier),
			);
			// HQ's summary resolves `home/` by the relationship name the app's
			// forms write (`AppCaseMetadata.get_property_list`).
			expect(form.case_references_data?.load).toEqual({
				"/data/note": [
					identifier === "parent"
						? "#case/parent/remark"
						: `#case/${identifier}/remark`,
				],
			});
		}
	});

	it("walks the same index in a basic menu, whose parent selection lists any child index", () => {
		const { source } = underTest(members("home", false));
		expect(noteRelevant(source)).toBe(printed("case_id", "home"));
	});

	it("reads, in Preview, the household the member holds under that index", () => {
		const doc = members("home", true);
		const tree = formSessionBindings(doc, UNDER_TEST).formCaseProperty(
			"household",
			"remark",
		);
		const text = serializeWire(tree, { target: "preview" }).text;
		const row = (caseId: string, caseType: string, remark: string) => ({
			case_id: caseId,
			app_id: "app-1",
			case_type: caseType,
			owner_id: "worker-1",
			status: "open",
			opened_on: null,
			modified_on: null,
			closed_on: null,
			case_name: caseId,
			external_id: null,
			parent_case_id: null,
			properties: { remark },
		});
		const edge = (ancestor: string, identifier: string) => ({
			case_id: "member-1",
			ancestor_id: ancestor,
			target_case_type: "household",
			identifier,
			relationship: "child" as const,
			depth: 1,
		});
		const casedb = caseDatabaseXPathInstance({
			rows: [
				row("chosen", "household", "the chosen household"),
				row("other", "household", "another household"),
				row("member-1", "member", ""),
			],
			// The member is chosen under `chosen` through `home`, and holds a
			// `parent` index to another household.
			indices: [edge("chosen", "home"), edge("other", "parent")],
		} as never);
		const session = commcareSessionXPathInstance(
			{ context: {}, user: {}, userPropertySlugs: {} } as never,
			{ case_id_load_member1: "member-1" },
		);
		expect(
			evaluate(text, {
				getValue: () => undefined,
				contextPath: "/data",
				position: undefined,
				resolveXPathInstance: (id) =>
					id === "casedb"
						? casedb
						: id === "commcaresession"
							? session
							: undefined,
			}),
		).toBe("the chosen household");
	});

	it("reads the household an evaluation's records link the member to, under the app's own index", () => {
		// `evaluate_form` and an App Test's seed build their records through
		// `evaluationScenarioCases`; a member written under `parent` while the
		// form walks `home` would read every household value blank.
		const doc = members("home", false);
		const snapshot = evaluationScenarioCases(doc, "worker-1", {
			records: [
				{
					id: "chosen",
					caseType: "household",
					properties: { remark: "the chosen household" },
				},
				{ id: "member-1", caseType: "member", parentId: "chosen" },
			],
		});
		expect(snapshot.indices.map((index) => index.identifier)).toEqual(["home"]);
		const text = serializeWire(
			formSessionBindings(doc, UNDER_TEST).formCaseProperty(
				"household",
				"remark",
			),
			{ target: "preview" },
		).text;
		const casedb = caseDatabaseXPathInstance(snapshot, doc.caseTypes ?? []);
		const session = commcareSessionXPathInstance(
			{ context: {}, user: {}, userPropertySlugs: {} } as never,
			{ case_id: "member-1" },
		);
		expect(
			evaluate(text, {
				getValue: () => undefined,
				contextPath: "/data",
				position: undefined,
				resolveXPathInstance: (id) =>
					id === "casedb"
						? casedb
						: id === "commcaresession"
							? session
							: undefined,
			}),
		).toBe("the chosen household");
	});

	it.each([
		["parent", "an advanced", true],
		["home", "an advanced", true],
		["home", "a basic", false],
	])(
		"reads a walk through `%s` in %s menu back from its export to the same document, with no finding",
		async (identifier, _menu, advanced) => {
			const doc = members(identifier, advanced);
			const told = {
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
			};
			const outcome = readHqApp(await inputFor(exportedBody(doc), told));
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			const want = READER_CANONICAL_CHOICES.reduce(
				(current, choice) => choice.apply(current),
				doc,
			);
			expect(outcome.draft.doc.forms[HOUSEHOLD_VISIT]?.caseOperations).toEqual(
				want.forms[HOUSEHOLD_VISIT]?.caseOperations,
			);
			const reading = await readBody(
				exportedBody(doc),
				doc,
				recordDialectRoundTrip,
			);
			const differing = judgeReadBack(want, reading).flatMap(
				({ stored, verdict }) =>
					verdict.kind === "differs" ? [{ slot: stored.key, verdict }] : [],
			);
			expect(differing).toEqual([]);
			const note = Object.values(outcome.draft.doc.fields).find(
				(field) => field.id === "note",
			) as { readonly relevant?: unknown } | undefined;
			expect(note?.relevant).toEqual({
				kind: "is-blank",
				left: householdRemark,
			});
		},
	);

	it("holds no household read where an app's form walks an index its links do not name", async () => {
		// The app links a member to its household as `home`; the form, written
		// by hand in CommCare HQ, walks `index/parent`, which names another case
		// or none, so it is no read Nova prints.
		const doc = members("home", true);
		const outcome = readHqApp(
			await inputFor(
				exportedBody(doc, {
					xml: (xml) => {
						const parsed = parseXml(xml);
						const bind = findOne(
							(element) =>
								element.name === "bind" &&
								element.attribs.nodeset === "/data/note",
							parsed.children,
						);
						if (bind === null) return xml;
						bind.attribs.relevant = printed("case_id_load_member1", "parent");
						return serializeXml(parsed);
					},
				}),
				{
					resolver: matchingResolver(
						"app-1",
						externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
					),
					knownCaseTypes: knownCaseTypesOf(doc),
				},
			),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		const at = (outcome.kind === "account" ? outcome.findings : []).map(
			(finding) => finding.place,
		);
		expect(at).toContainEqual(expect.objectContaining({ path: "note" }));
	});
});
