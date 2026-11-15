/**
 * Every place Nova's emitter keeps a case operation in, read back whole.
 *
 * Contract: each case operation fixture of `lib/commcare`, the own arm of
 * each form type in a Save to Case block (a registration's, which CommCare
 * HQ's app holds as a survey, a follow-up's beside its basic block, a
 * several-case form's shared update), and the targeted documents of advanced
 * menus, carried creates and Save to Case shapes, read through `readHqApp`,
 * give the canonical document (`READER_CANONICAL_CHOICES` applied to the
 * source) with no finding: every form's type, operations with their
 * identities and placements, and the catalog, compared whole, and every
 * expression slot holding the canonical tree of what the document stored,
 * as `readBackCorpus.ts::judgeReadBack` judges it for the yardsticks. The
 * documents together put an operation in every place `planPlacements` gives
 * one, which the last test holds, so a place no document reaches cannot pass
 * unseen.
 *
 * The plausible failure: a block the reader takes for another operation that
 * prints the same bytes (the own arm read as a create or an update) gives a
 * different document with no finding, which a test that asks only for no
 * finding passes.
 */
import { type Element, isTag } from "domhandler";
import { removeElement, replaceElement } from "domutils";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type CaseOperation,
	NEW_APP_SETTINGS,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { concat, eq, formField, literal, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { rewriteExpressionSlotValues } from "@/lib/domain/referenceSlots";
import type { CorpusDocument } from "@/proof/corpus/documents";
import { caseListOf } from "../../../../../proof/targeted/build";
import {
	advancedChildModule,
	advancedHeldKind,
	advancedModule,
	extensionCarried,
	rootCaseBlockNames,
} from "../../../../../proof/targeted/documents/advancedModules";
import { caseWritesOneConcept } from "../../../../../proof/targeted/documents/caseWritesOneConcept";
import { formLinkCarriedCase } from "../../../../../proof/targeted/documents/formLinkCarriedCase";
import { saveToCaseShapesApp } from "../../../../../proof/targeted/documents/saveToCaseShapes";
import {
	advancedFixture,
	OP,
	read,
	U,
} from "../../../__tests__/advancedPlacementFixture";
import {
	caseOperationFixture,
	operationScenarios,
} from "../../../__tests__/caseOperationFixture";
import { planPlacements } from "../../../placement";
import { serializeXml } from "../../../serializeXml";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { saveToCaseBlockShape } from "../../../xform/caseOps";
import { parseXml } from "../../../xmlParse";
import {
	type ExportEdits,
	exportedBody,
	inputFor,
} from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import {
	judgeReadBack,
	readBody,
} from "../../expressions/__tests__/readBackCorpus";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { updateBesideBareOwnAsOwnArm } from "../saveToCase";
import { readHqApp } from "./heldReading";

const id = (key: string) => testUuid(`own-in-block-${key}`);
const answer = (key: string) => term(formField(id(key)));

/** A menu of patients with one form of `type`, whose own arm is `own`. */
function ownArm(
	type: "registration" | "followup" | "close",
	own: Omit<CaseOperation, "uuid" | "id" | "action">,
	options: {
		readonly several?: boolean;
		readonly openCondition?: boolean;
		readonly closeCondition?: boolean;
	} = {},
): BlueprintDoc {
	const text = (key: string) =>
		f({ kind: "text", uuid: id(key), id: key, label: proseText(key) });
	return buildDoc(
		{
			appId: "app-1",
			appName: "Own arm",
			// Choosing several patients runs in Web Apps alone.
			appSettings: {
				...NEW_APP_SETTINGS,
				...(options.several === true && { runsOnlyOn: "web-apps" }),
			},
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "note", label: proseText("Note"), data_type: "text" },
						{ name: "score", label: proseText("Score"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					uuid: id("menu"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListOf(
						[plainColumn(id("name-column"), "case_name", "Name")],
						options.several === true
							? { selection: { kind: "multiple", maximum: 10 } }
							: {},
					),
					forms: [
						{
							uuid: id("form"),
							name: "Visit",
							type,
							fields: [text("name"), text("note"), text("flag")],
							...(options.openCondition === true && {
								openCondition: eq(formField(id("flag")), formField(id("note"))),
							}),
							...(options.closeCondition === true && {
								closeCondition: eq(formField(id("flag")), literal("y")),
							}),
						},
					],
				},
			],
		},
		(built) => {
			const form = built.forms[id("form")];
			if (form !== undefined)
				form.caseOperations = [
					{
						uuid: id("own"),
						id: "patient",
						action: "own",
						...own,
					} as CaseOperation,
				];
		},
	);
}

/** A survey of the patients' menu that creates a patient in a block: CommCare
 *  HQ's app holds it as it holds a registration whose own arm takes a block,
 *  so the reader must tell the two apart by what each prints. */
function surveyCreate(
	options: { readonly conditional?: boolean; readonly computed?: boolean } = {},
) {
	const doc = ownArm("registration", { name: answer("name") });
	return produce(doc, (draft) => {
		const form = draft.forms[id("form")];
		if (form === undefined) return;
		form.type = "survey";
		form.caseOperations = [
			{
				uuid: id("create"),
				id: "new_patient",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				name:
					options.computed === true
						? concat(answer("name"), term(literal(" (new)")))
						: answer("name"),
				...(options.computed !== true && {
					writes: [{ property: "external_id", value: answer("note") }],
				}),
				...(options.conditional === true && {
					condition: eq(formField(id("flag")), literal("y")),
				}),
			} as CaseOperation,
		];
	});
}

const conditionalNote = {
	property: "note",
	value: answer("note"),
	condition: eq(formField(id("flag")), literal("y")),
};
const computedScore = {
	property: "score",
	value: concat(answer("note"), term(literal(" points"))),
};

/** The own arm of each form type in a block, each for a reason Case
 *  Management cannot state. */
const OWN_ARMS: Record<string, () => BlueprintDoc> = {
	"a registration's, for a write's condition": () =>
		ownArm("registration", { name: answer("name"), writes: [conditionalNote] }),
	"a registration's, for a computed write": () =>
		ownArm("registration", { name: answer("name"), writes: [computedScore] }),
	"a registration's, for an open condition comparing two answers": () =>
		ownArm(
			"registration",
			{
				name: answer("name"),
				writes: [{ property: "note", value: answer("note") }],
			},
			{ openCondition: true },
		),
	"a follow-up's, for a write's condition": () =>
		ownArm("followup", { writes: [conditionalNote] }),
	"a follow-up's, for a computed write": () =>
		ownArm("followup", { writes: [computedScore] }),
	"a several-case form's, writing": () =>
		ownArm(
			"followup",
			{
				writes: [
					{ property: "note", value: answer("note") },
					{ ...computedScore, condition: conditionalNote.condition },
				],
			},
			{ several: true },
		),
	"a several-case form's, renaming": () =>
		ownArm(
			"followup",
			{
				name: answer("name"),
				writes: [{ property: "note", value: answer("note") }],
			},
			{ several: true },
		),
	"a several-case close form's": () => ownArm("close", {}, { several: true }),
	"a several-case close form's, with a close condition": () =>
		ownArm("close", {}, { several: true, closeCondition: true }),
};

/** A follow-up whose own arm changes nothing, beside an update of the
 *  session's case that `update` describes, named with the id a reading gives
 *  the bare own arm: the own arm in a block of that name prints the same. */
function updateBesideBareOwn(update: Partial<CaseOperation>): BlueprintDoc {
	return produce(ownArm("followup", {}), (draft) => {
		const form = draft.forms[id("form")];
		if (form === undefined) return;
		form.caseOperations = [
			{ uuid: id("own"), id: "own_case", action: "own" } as CaseOperation,
			{
				uuid: id("update"),
				id: "patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				...update,
			} as CaseOperation,
		];
	});
}

/** The pairs `update-beside-a-bare-own-arm-is-the-own-arm` names: each update
 *  and the own arm that prints the same block. */
const UPDATES_BESIDE_A_BARE_OWN: Record<string, () => BlueprintDoc> = {
	"writing a computed value": () =>
		updateBesideBareOwn({ writes: [computedScore] }),
	"writing a computed value under a condition of its own row": () =>
		updateBesideBareOwn({
			writes: [{ ...computedScore, condition: conditionalNote.condition }],
		}),
};

/** A targeted document as Nova's load boundary hydrates it. */
function hydrated(document: CorpusDocument): BlueprintDoc {
	const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(document.doc));
	ensureReferenceIndex(doc);
	return doc;
}

const DOCUMENTS: Record<string, () => BlueprintDoc> = {
	...Object.fromEntries(
		operationScenarios.map((scenario) => [
			`the ${scenario} case operations`,
			() => caseOperationFixture(scenario),
		]),
	),
	...Object.fromEntries(
		Object.entries(OWN_ARMS).map(([name, doc]) => [
			`the own arm in a block, ${name}`,
			doc,
		]),
	),
	...Object.fromEntries(
		Object.entries(UPDATES_BESIDE_A_BARE_OWN).map(([name, doc]) => [
			`an update of the session's case beside a bare own arm, ${name}`,
			doc,
		]),
	),
	"a survey's create of its menu's case type, writing the external id": () =>
		surveyCreate(),
	"a survey's conditional create of its menu's case type": () =>
		surveyCreate({ conditional: true }),
	"a survey's create of its menu's case type, named by a computed value": () =>
		surveyCreate({ computed: true }),
	"every Save to Case shape": saveToCaseShapesApp,
	"an advanced menu": () => hydrated(advancedModule()),
	"an extension a link carries": () => hydrated(extensionCarried()),
	"an advanced child menu": () => hydrated(advancedChildModule()),
	"a held advanced kind": () => hydrated(advancedHeldKind()),
	"the root case block names": () => hydrated(rootCaseBlockNames()),
	"a case a link carries": () => hydrated(formLinkCarriedCase()),
	"one concept written several ways": () => hydrated(caseWritesOneConcept()),
	// An advanced registration whose one indexed open action in its repeat is
	// written at the repeat's row.
	"an open action at its row": () =>
		advancedFixture({
			formType: "registration",
			operations: () => [
				{ uuid: OP("own"), id: "own_case", action: "own", name: read("name") },
				{
					uuid: OP("kid"),
					id: "kid",
					action: "create",
					caseType: "member",
					target: { kind: "new" },
					name: read("kid_name"),
					links: [
						{
							identifier: "parent",
							targetType: "household",
							target: { kind: "op", opUuid: OP("own") },
							relationship: "child",
						},
					],
					forEach: { repeat: U("kids") },
				} as CaseOperation,
			],
		}).doc,
};

/** What a form holds of its case changes, whole, and the catalog, with each
 *  of the form's expression slots marked where it stands: the slots are
 *  judged one by one, against the canonical tree. */
function caseFacts(doc: BlueprintDoc) {
	const entities = JSON.parse(
		JSON.stringify({
			fields: doc.fields,
			forms: doc.forms,
			modules: doc.modules,
		}),
	) as Pick<BlueprintDoc, "fields" | "forms" | "modules">;
	for (const uuid of Object.keys(entities.forms) as Uuid[])
		rewriteExpressionSlotValues(
			entities,
			{ entity: "form", uuid },
			() => "expression",
		);
	return JSON.parse(
		JSON.stringify({
			caseTypes: doc.caseTypes,
			// HQ's build writes `required` on the question that names a case
			// an action creates, so the reading must hold whether each field
			// is required as the source does.
			required: Object.values(doc.fields)
				.filter((field) => "required" in field && field.required !== undefined)
				.map((field) => field.uuid)
				.sort(),
			forms: Object.fromEntries(
				Object.values(entities.forms).map((form) => [
					form.uuid,
					{
						type: form.type,
						openCondition: form.openCondition,
						closeCondition: form.closeCondition,
						ownClosePlacement: form.ownClosePlacement,
						caseOperations: form.caseOperations,
					},
				]),
			),
		}),
	) as unknown;
}

async function readBack(doc: BlueprintDoc, edits: ExportEdits = {}) {
	return readHqApp(
		await inputFor(exportedBody(doc, edits), {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
			// A save of only the answers that changed is published only to a
			// project space that applies it.
			saveOnlyEditedApplied: true,
		}),
	);
}

describe("every place Nova keeps a case operation in", () => {
	it.each(Object.keys(DOCUMENTS))(
		"reads %s back to the canonical document, with no finding",
		async (name) => {
			const doc = (DOCUMENTS[name] as () => BlueprintDoc)();
			const outcome = await readBack(doc);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			const want = READER_CANONICAL_CHOICES.reduce(
				(current, choice) => choice.apply(current),
				doc,
			);
			expect(caseFacts(outcome.draft.doc)).toEqual(caseFacts(want));
			const reading = await readBody(
				exportedBody(doc),
				doc,
				recordDialectRoundTrip,
				undefined,
				{ saveOnlyEditedApplied: true },
			);
			const differing = judgeReadBack(want, reading).flatMap(
				({ stored, verdict }) =>
					verdict.kind === "differs"
						? [{ slot: stored.key, want: verdict.want, got: verdict.got }]
						: [],
			);
			expect(differing).toEqual([]);
		},
	);

	it.each(Object.keys(UPDATES_BESIDE_A_BARE_OWN))(
		"prints an update beside a bare own arm, %s, as the own arm it is read as",
		(name) => {
			const doc = (UPDATES_BESIDE_A_BARE_OWN[name] as () => BlueprintDoc)();
			const own = updateBesideBareOwnAsOwnArm(doc);
			expect(own).not.toBe(doc);
			const ownArm = own.forms[id("form")]?.caseOperations?.[0];
			expect(ownArm?.action).toBe("own");
			expect(own.forms[id("form")]?.caseOperations).toHaveLength(1);
			expect(exportedBody(own)).toEqual(exportedBody(doc));
			expect(updateBesideBareOwnAsOwnArm(own)).toBe(own);
		},
	);

	it("leaves an update that writes an answer as it is, which prints its own block", () => {
		const doc = updateBesideBareOwn({
			writes: [{ property: "note", value: answer("note") }],
		});
		expect(updateBesideBareOwnAsOwnArm(doc)).toBe(doc);
	});

	it("puts an operation in every place the plan gives one", () => {
		const places = new Set<string>();
		for (const make of Object.values(DOCUMENTS)) {
			const doc = make();
			for (const formUuid of Object.keys(doc.forms) as Uuid[]) {
				for (const [subject, planned] of planPlacements(doc, formUuid)
					.placements) {
					const placement = planned.placement;
					if (planned.sharesWith !== undefined) {
						places.add("shares a create's place");
						continue;
					}
					if (placement.kind === "basic") places.add(`basic ${placement.slot}`);
					else if (placement.kind === "advanced")
						places.add(placement.row === true ? "advanced row" : "advanced");
					else {
						const shape = saveToCaseBlockShape(
							doc,
							formUuid,
							subject === "own-close"
								? { kind: "own-close" }
								: { kind: "operation", operationUuid: subject as Uuid },
						).join("/");
						const what = subject === "own-close" ? "own close" : "operation";
						places.add(
							`save-to-case ${what} ${shape}${placement.repeat === undefined ? "" : " in a repeat"}`,
						);
					}
				}
			}
		}
		expect([...places].sort(), JSON.stringify([...places].sort())).toEqual(
			[
				"advanced",
				"advanced row",
				"basic own",
				"basic subcase",
				"basic subcase-row",
				"basic usercase",
				"save-to-case operation operations/block",
				"save-to-case operation operations/block in a repeat",
				"save-to-case operation operations/condition/block",
				"save-to-case operation operations/condition/block in a repeat",
				"save-to-case operation operations/keyed/block",
				"save-to-case operation selected-cases/selected-case/operations/block",
				"save-to-case operation selected-cases/selected-case/operations/condition/block",
				"save-to-case own close operations/condition/block",
				"save-to-case own close selected-cases/selected-case/operations/block",
				"save-to-case own close selected-cases/selected-case/operations/condition/block",
				"shares a create's place",
			].sort(),
		);
	});
});

/** Where a several-case close form's own close stands, in each selected
 *  case's row. */
const ROW = "/data/nova_selected_cases/item/nova_operations";
const CLOSE_GROUP = `${ROW}/nova_condition_close`;
const CLOSE_BLOCK = "nova_close_selected_cases";

/**
 * The several-case close form's source with its own close as a close-only
 * block standing in each selected case's row with no condition group, the
 * close condition the `relevant` of the block's `case/close`: what HQ's form
 * builder writes for a Close Condition on a block, which submits the block,
 * with no close in it, for every selected case the condition leaves open.
 */
function closeConditionOnTheClose(xml: string): string {
	const document = parseXml(xml);
	const all: Element[] = [];
	const walk = (node: { children?: unknown[] }) => {
		for (const child of (node.children ?? []) as Element[])
			if (isTag(child)) {
				all.push(child);
				walk(child);
			}
	};
	walk(document as { children?: unknown[] });
	const group = all.find((one) => one.name === "nova_condition_close");
	const block = group?.children.find(
		(child): child is Element => isTag(child) && child.name === CLOSE_BLOCK,
	);
	const control = all.find(
		(one) => one.name === "group" && one.attribs.ref === CLOSE_GROUP,
	);
	const groupBind = all.find(
		(one) => one.name === "bind" && one.attribs.nodeset === CLOSE_GROUP,
	);
	const relevant = groupBind?.attribs.relevant;
	if (
		group === undefined ||
		block === undefined ||
		control === undefined ||
		groupBind === undefined ||
		relevant === undefined
	)
		throw new Error(
			"The several-case close form's source has no own close in a condition group to move.",
		);
	removeElement(block);
	replaceElement(group, block);
	removeElement(control);
	const closePath = `${ROW}/${CLOSE_BLOCK}/case`;
	groupBind.attribs = { nodeset: `${closePath}/close`, relevant };
	for (const bind of all)
		if (
			bind.name === "bind" &&
			bind.attribs.nodeset?.startsWith(`${CLOSE_GROUP}/`)
		) {
			const nodeset = `${ROW}${bind.attribs.nodeset.slice(CLOSE_GROUP.length)}`;
			bind.attribs.nodeset = nodeset;
			// The block's id is the row's, one element nearer.
			if (nodeset === `${closePath}/@case_id`)
				bind.attribs.calculate = "current()/../../../../@id";
		}
	return serializeXml(document);
}

/** The stored `case_references_data.save` with the own close's block keyed
 *  where `closeConditionOnTheClose` moves it. */
function saveMapMoved(
	modules: Record<string, unknown>[],
): Record<string, unknown>[] {
	return modules.map((module) => ({
		...module,
		forms: (module.forms as Record<string, unknown>[]).map((form) => {
			const references = form.case_references_data as {
				save: Record<string, unknown>;
			};
			return {
				...form,
				case_references_data: {
					...references,
					save: Object.fromEntries(
						Object.entries(references.save).map(([path, reference]) => [
							path === `${CLOSE_GROUP}/${CLOSE_BLOCK}`
								? `${ROW}/${CLOSE_BLOCK}`
								: path,
							reference,
						]),
					),
				},
			};
		}),
	}));
}

describe("a several-case close form's own close with the condition on its close", () => {
	it("is the finding a-close-only-savetocase-block-with-a-close-condition at the block, and no document", async () => {
		const doc =
			OWN_ARMS["a several-case close form's, with a close condition"]?.();
		if (doc === undefined) throw new Error("The fixture is missing.");
		const outcome = await readBack(doc, {
			xml: closeConditionOnTheClose,
			modules: saveMapMoved,
		});
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		const findings = outcome.kind === "account" ? outcome.findings : [];
		expect(
			findings
				.filter((finding) => finding.code !== "unrecognized")
				.map((finding) => ({
					code: finding.code,
					path: (finding.place as { path?: string }).path,
				})),
		).toEqual([
			{
				code: "questions/a-close-only-savetocase-block-with-a-close-condition",
				path: `nova_selected_cases/item/nova_operations/${CLOSE_BLOCK}`,
			},
		]);
		// The selected-cases repeat around the block, which no operation the
		// reading holds runs in, is no node Nova generates for the form.
		expect(
			findings
				.filter((finding) => finding.code === "unrecognized")
				.map((finding) => finding.detail?.name)
				.sort(),
		).toEqual([
			"xform:bind",
			"xform:setvalue",
			expect.stringMatching(/}nova_selected_cases$/),
		]);
	});
});
