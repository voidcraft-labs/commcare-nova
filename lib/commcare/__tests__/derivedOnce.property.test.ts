/**
 * The answers a reading at the byte cap derives once rather than once per
 * question, held to the plain paths they replaced over the documents the
 * oracle corpora draw:
 *
 * - the projected menus (`moduleHierarchy.ts::projectedModuleSet`) and the
 *   menus that select through another (`entryDatumSupplies.ts::
 *   modulesSelectingThrough`), remembered by settled `moduleOrder` and
 *   `modules` records;
 * - an owner's expression values (`referenceSlots.ts::expressionSlotValues`),
 *   remembered by a settled owner;
 * - the lookup references of a whole document
 *   (`lookupReferences.ts::extractLookupReferenceOccurrences`), which walks
 *   each owner once per extraction rather than once per slot;
 * - the reader's new document under a change
 *   (`reader/expressions/index.ts::cloned`), which shares what a settled
 *   document's change leaves alone rather than copying it;
 * - the add-ons an emission needs (`addOns.ts::addOnsNeededBy`), which parses
 *   a form's source for an `<itemset>` only where its text names one;
 * - the case blocks and identity records read from form texts
 *   (`hq/publishedCaseBlocks.ts`, `hq/sourceIdentity.ts`), and the reader's
 *   grammar reads (`reader/syntaxRead.ts::readFormSyntax`), held by the text;
 * - every sibling group of the menus at once
 *   (`moduleHierarchy.ts::moduleSiblingGroups`), each form's first menu in a
 *   link projection (`formLinkProjection.ts::owningModuleOf`), and the ids a
 *   reading mints beside the ones taken (`idSlug.ts::SlugsTaken`);
 * - whether a document is settled all the way down, remembered for a frozen
 *   part found open beneath (`settled.ts::isDeeplySettled`);
 * - the commit gate's verdict and the export readiness of its candidate from
 *   one validator run (`commitVerdicts.ts::mutationCommitVerdictSteps`);
 * - a form text's parse (`xmlParse.ts::heldXmlParse`), held by the text and
 *   shared frozen by every reader of it;
 * - an emission a reading compares with, held for the request's other
 *   readings (`reader/heldExpansions.ts`), answered only for the same settled
 *   document under the same facts.
 *
 * A settled copy is a deep-frozen `structuredClone` of the draw and an open
 * copy another, so freezing is the one difference between them; a draft
 * written between two questions must get the draft's answers. Each plain path
 * is the code as it stood, written out here, or the production path taken
 * over an open document, which no memo serves.
 */
import { type AnyNode, isTag } from "domhandler";
import * as fc from "fast-check";
import { current, freeze, isDraft, produce } from "immer";
import { describe, expect, it } from "vitest";
import { addOnsNeededBy } from "@/lib/commcare/addOns";
import { expandDoc, expandDocSteps } from "@/lib/commcare/expander";
import {
	formLinkProjectionContext,
	owningModuleOf,
} from "@/lib/commcare/formLinkProjection";
import {
	FORM_TEXTS_HELD_CHARACTERS,
	HeldByText,
} from "@/lib/commcare/heldByText";
import { publishedCaseBlocks } from "@/lib/commcare/hq/publishedCaseBlocks";
import { sourceIdentity } from "@/lib/commcare/hq/sourceIdentity";
import { cloned } from "@/lib/commcare/reader/expressions";
import { HeldExpansions } from "@/lib/commcare/reader/heldExpansions";
import { readFormSyntax } from "@/lib/commcare/reader/syntaxRead";
import { heldXmlParse, parseXml } from "@/lib/commcare/xmlParse";
import { readFormSyntax as plainFormSyntax } from "@/lib/commcare/xpath/formSyntax";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
	mutationCommitVerdictSteps,
} from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	rebuildFieldParent,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceOccurrences,
	type LookupValidationContext,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { scan } from "@/lib/domain/__tests__/structuralScans";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { modulesSelectingThrough } from "@/lib/domain/entryDatumSupplies";
import { SlugsTaken, uniqueSlug } from "@/lib/domain/idSlug";
import {
	moduleSiblingGroups,
	moduleSiblingUuids,
	projectedModulePreorder,
	projectedModuleSet,
} from "@/lib/domain/moduleHierarchy";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import { isDeeplySettled } from "@/lib/domain/settled";
import type { Uuid } from "@/lib/domain/uuid";
import type { LookupRevision } from "@/lib/lookup/types";
import { advancedDocArbitrary } from "./advancedDocArbitrary";
import { manifestFor } from "./compilerEvidence";
import { menuScreenDocArbitrary } from "./menuScreenDocArbitrary";
import { suiteDocArbitrary } from "./suiteDocArbitrary";
import { blueprintDocArbitrary } from "./xformDocArbitrary";

function outcome<T>(run: () => T): { value: T } | { threw: string } {
	try {
		return { value: run() };
	} catch (error) {
		return { threw: error instanceof Error ? error.message : String(error) };
	}
}

/** `modulesSelectingThrough` as it was: every chain walked per question. */
function selectingThroughScan(doc: BlueprintDoc, moduleUuid: Uuid): Uuid[] {
	const chain = (start: Uuid): Uuid[] => {
		const reverse: Uuid[] = [];
		const seen = new Set<Uuid>([start]);
		let at = start;
		while (true) {
			const parent = doc.modules[at]?.parentCaseModuleUuid;
			if (parent === undefined || seen.has(parent)) break;
			seen.add(parent);
			reverse.push(parent);
			at = parent;
		}
		return reverse.reverse();
	};
	return (Object.keys(doc.modules) as Uuid[]).filter(
		(uuid) => uuid !== moduleUuid && chain(uuid).includes(moduleUuid),
	);
}

/** Every owner of `doc`, and one it does not hold. */
function ownersOf(doc: BlueprintDoc): ExpressionCarrierRef[] {
	return [
		...Object.keys(doc.modules).map((uuid) => ({
			entity: "module" as const,
			uuid: uuid as Uuid,
		})),
		...Object.keys(doc.forms).map((uuid) => ({
			entity: "form" as const,
			uuid: uuid as Uuid,
		})),
		...Object.keys(doc.fields).map((uuid) => ({
			entity: "field" as const,
			uuid: uuid as Uuid,
		})),
		{ entity: "form", uuid: "not-a-form" as Uuid },
	];
}

/** Every derived answer of `doc` equals the plain path's over `oracle`. */
function expectDerivedAgree(doc: BlueprintDoc, oracle: BlueprintDoc): void {
	expect([...projectedModuleSet(doc)]).toEqual([
		...new Set(projectedModulePreorder(oracle)),
	]);
	for (const moduleUuid of [
		...(Object.keys(oracle.modules) as Uuid[]),
		"not-a-menu" as Uuid,
	])
		expect([...modulesSelectingThrough(doc, moduleUuid)]).toEqual(
			selectingThroughScan(oracle, moduleUuid),
		);
	const open = structuredClone(oracle);
	for (const owner of ownersOf(oracle))
		expect(expressionSlotValues(doc, owner)).toEqual(
			expressionSlotValues(open, owner),
		);
	const groups = moduleSiblingGroups(doc);
	for (const parent of [
		null,
		...(Object.keys(oracle.modules) as Uuid[]),
		"not-a-menu" as Uuid,
	])
		expect([...groups(parent)]).toEqual(moduleSiblingUuids(oracle, parent));
	const context = formLinkProjectionContext(doc);
	for (const formUuid of [
		...(Object.keys(oracle.forms) as Uuid[]),
		"not-a-form" as Uuid,
	])
		expect(owningModuleOf(context, formUuid)).toBe(
			scan.ordered(context, formUuid),
		);
}

/** Whether `value` and all it holds are frozen and no draft, walked afresh. */
function settledThroughout(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return true;
	if (
		isDraft(value) ||
		!Object.isFrozen(value) ||
		value instanceof Map ||
		value instanceof Set
	)
		return false;
	return Object.values(value).every(settledThroughout);
}

/** Moves the first menu under a parent selection of the last, and the first
 *  form's display condition onto another form, where the draw holds them. */
function rewire(draft: BlueprintDoc): void {
	const [first] = draft.moduleOrder;
	const last = draft.moduleOrder[draft.moduleOrder.length - 1];
	if (first !== undefined && last !== undefined && first !== last) {
		const mod = draft.modules[first];
		if (mod !== undefined) mod.parentCaseModuleUuid = last;
	}
	const forms = Object.values(draft.forms);
	const held = forms.find((form) => form.displayCondition !== undefined);
	const other = forms.find((form) => form !== held);
	if (held !== undefined && other !== undefined)
		other.displayCondition = held.displayCondition;
	else if (held !== undefined) delete held.displayCondition;
}

/** The plain extraction: each registry entry asked of a copy no extraction
 *  in progress holds, so every slot walks the document on its own. */
function plainOccurrences(doc: BlueprintDoc) {
	const copy = structuredClone(doc);
	return outcome(() =>
		extractLookupReferenceOccurrences(
			doc,
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS.map((extractor) => ({
				registrySlot: extractor.registrySlot,
				extract: () => extractor.extract(copy),
			})),
		),
	);
}

/** A change of the kind the expression stage makes: the catalog, a slot. */
function change(draft: BlueprintDoc): void {
	draft.caseTypes = [
		...(draft.caseTypes ?? []),
		{
			name: "derived_once_probe",
			properties: [
				{ name: "seen", label: { parts: [{ kind: "text", text: "Seen" }] } },
			],
		},
	];
	const [form] = Object.values(draft.forms);
	if (form !== undefined) form.name = `${form.name} again`;
}

/** Whether a form's source holds an `<itemset>`, by a walk of every element. */
function holdsItemset(nodes: readonly AnyNode[]): boolean {
	return nodes.some(
		(node) =>
			isTag(node) &&
			(node.name.split(":").pop() === "itemset" || holdsItemset(node.children)),
	);
}

const corpora: readonly [string, fc.Arbitrary<BlueprintDoc>, number][] = [
	["workflow", suiteDocArbitrary, 30],
	["menu screens", menuScreenDocArbitrary, 30],
	["advanced menus", advancedDocArbitrary, 15],
	["form fields", blueprintDocArbitrary, 30],
];

describe("an answer derived once per settled part", () => {
	it.each(corpora)(
		"gives over a settled %s document, and over a draft after a write, what the plain path gives",
		async (_name, arbitrary, numRuns) => {
			await fc.assert(
				fc.property(arbitrary, (draw) => {
					rebuildFieldParent(draw);
					const open = structuredClone(draw);
					const settled = freeze(structuredClone(draw), true);

					expectDerivedAgree(settled, open);
					expectDerivedAgree(settled, open);
					expectDerivedAgree(open, open);
					expect(
						outcome(() =>
							extractLookupReferenceOccurrences(
								settled,
								PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
							),
						),
					).toEqual(plainOccurrences(open));

					produce(settled, (draft) => {
						const doc = draft as unknown as BlueprintDoc;
						expectDerivedAgree(doc, current(draft) as BlueprintDoc);
						rewire(doc);
						expectDerivedAgree(doc, current(draft) as BlueprintDoc);
					});
					const rewired = produce(settled, (draft) => {
						rewire(draft as unknown as BlueprintDoc);
					});
					expectDerivedAgree(rewired, structuredClone(rewired));
					expect(
						outcome(() =>
							extractLookupReferenceOccurrences(
								rewired,
								PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
							),
						),
					).toEqual(plainOccurrences(rewired));
				}),
				{ numRuns, seed: 20261116 },
			);
		},
		60_000,
	);

	it.each(corpora)(
		"makes the reader's next %s document as a copy and a fresh hydration do",
		async (_name, arbitrary, numRuns) => {
			await fc.assert(
				fc.property(arbitrary, (draw) => {
					const open = hydratePersistedBlueprint(toPersistableDoc(draw));
					const settled = freeze(
						hydratePersistedBlueprint(toPersistableDoc(draw)),
						true,
					);
					const before = structuredClone(settled);
					/* The open document takes the copy and the hydration, as every
					 * document did before; the settled one shares what the change
					 * leaves alone. */
					const copied = cloned(open, change);
					const shared = cloned(settled, change);
					expect(shared).toEqual(copied);
					expect(Object.isFrozen(shared)).toBe(true);
					expect(settled).toEqual(before);
					const unchanged = cloned(settled, () => {});
					expect(unchanged).not.toBe(settled);
					expect(unchanged).toEqual(cloned(open, () => {}));
				}),
				{ numRuns, seed: 20261116 },
			);
		},
		60_000,
	);

	it.each(corpora)(
		"reads an emitted %s app's forms the same way however often their texts are met",
		async (_name, arbitrary, numRuns) => {
			await fc.assert(
				fc.property(arbitrary, (draw) => {
					rebuildFieldParent(draw);
					const expanded = outcome(() =>
						expandDoc(draw, { assets: manifestFor(draw) }),
					);
					if (!("value" in expanded)) return;
					const app = expanded.value;
					const sources = Object.values(app._attachments).filter(
						(text): text is string => typeof text === "string",
					);
					const needsItemsets = sources.some((text) =>
						holdsItemset(parseXml(text).children),
					);
					expect(addOnsNeededBy(app).includes("advanced_itemsets")).toBe(
						needsItemsets,
					);
					/* The served JSON, as acceptance reads an emission: equal texts
					 * in other string objects. */
					const served = JSON.parse(JSON.stringify(app)) as unknown;
					const blocks = outcome(() => publishedCaseBlocks(app));
					expect(outcome(() => publishedCaseBlocks(served))).toEqual(blocks);
					expect(outcome(() => publishedCaseBlocks(app))).toEqual(blocks);
					const identity = outcome(() => sourceIdentity(app));
					expect(outcome(() => sourceIdentity(served))).toEqual(identity);
					expect(outcome(() => sourceIdentity(app))).toEqual(identity);
				}),
				{ numRuns, seed: 20261116 },
			);
		},
		60_000,
	);
});

describe("answers held by a form's text", () => {
	it("answers a text met again with the answer it first gave, and holds no more than its bound", () => {
		const held = new HeldByText<{ readonly length: number }>(10);
		let asked = 0;
		const answer = (text: string) => {
			asked += 1;
			return Object.freeze({ length: text.length });
		};
		const first = held.of("abcd", answer);
		expect(held.of(`ab${"cd"}`, answer)).toBe(first);
		expect(asked).toBe(1);
		held.of("efghij", answer);
		expect(asked).toBe(2);
		/* Past ten characters the oldest text is dropped and asked afresh. */
		held.of("k", answer);
		expect(held.of("abcd", answer)).not.toBe(first);
		expect(held.of("abcd", answer)).toEqual(first);
		expect(asked).toBe(4);
		expect(FORM_TEXTS_HELD_CHARACTERS).toBeGreaterThan(32 * 1024 * 1024);
	});
});

describe("answers held by a reading", () => {
	it("mints each id as a search from the first suffix does, beside the ids taken and given", async () => {
		const name = fc.constantFrom(
			"Visit",
			"visit",
			"Visit 2",
			"",
			"!",
			"a",
			"A",
		);
		await fc.assert(
			fc.property(
				fc.array(fc.constantFrom("visit", "visit_2", "visit_3", "a", "menu")),
				fc.array(
					fc.oneof(
						name.map((one) => ({ take: one })),
						fc
							.constantFrom("visit_4", "visit", "a_2", "menu_2")
							.map((one) => ({ add: one })),
					),
				),
				(given, asks) => {
					const fast = new SlugsTaken(given);
					const plain = new Set<string>(given);
					for (const ask of asks) {
						if ("add" in ask) {
							fast.add(ask.add);
							plain.add(ask.add);
							continue;
						}
						const expected = uniqueSlug(ask.take, "menu", plain);
						plain.add(expected);
						expect(fast.take(ask.take, "menu")).toBe(expected);
					}
				},
			),
			{ numRuns: 300, seed: 20261116 },
		);
	});

	it("reads a text with the grammar as a fresh read does, however often it is met, each read its own tree", async () => {
		const texts = fc.oneof(
			fc.constantFrom(
				"/data/age > 5 and /data/name != ''",
				"count(instance('casedb')/casedb/case[@case_type = 'x']) > 0",
				"if(#form/a = 'b', 1, 2)",
				"concat(",
				"",
				"  ",
			),
			fc.string({
				unit: fc.constantFrom("a", "/", "(", ")", "'", " ", "=", "1", "[", "]"),
			}),
		);
		await fc.assert(
			fc.property(texts, (text) => {
				const plain = plainFormSyntax(text);
				const first = readFormSyntax(text);
				expect(first).toEqual(plain);
				const again = readFormSyntax(text);
				expect(again).toEqual(plain);
				if (typeof again === "object" && Object.keys(again).length > 0)
					expect(again).not.toBe(first);
			}),
			{ numRuns: 300, seed: 20261116 },
		);
	});

	it.each(corpora)(
		"says whether a %s document is settled throughout as a fresh walk does, asked again",
		async (_name, arbitrary, numRuns) => {
			await fc.assert(
				fc.property(arbitrary, (draw) => {
					rebuildFieldParent(draw);
					const settled = freeze(structuredClone(draw), true);
					const open = structuredClone(draw);
					/* Frozen at the root around parts still open, as a reader's
					 * candidate of an open document is. */
					const mixed = Object.freeze({ ...settled, forms: open.forms });
					const holdsMap = Object.freeze({
						...settled,
						refIndex: new Map(),
					}) as unknown as BlueprintDoc;
					for (const doc of [settled, open, mixed, holdsMap, settled, mixed])
						expect(isDeeplySettled(doc)).toBe(settledThroughout(doc));
					expect(isDeeplySettled(mixed.modules)).toBe(true);
					/* The open part frozen through by hand: the mixed document is
					 * settled now, as a fresh walk finds. */
					freeze(open, true);
					expect(isDeeplySettled(mixed)).toBe(settledThroughout(mixed));
					expect(isDeeplySettled(mixed)).toBe(true);
					produce(settled, (draft) => {
						expect(isDeeplySettled(draft)).toBe(false);
						expect(isDeeplySettled(draft.modules)).toBe(false);
					});
				}),
				{ numRuns, seed: 20261116 },
			);
		},
		60_000,
	);
});

describe("the gate's verdict and its candidate's export readiness from one run", () => {
	const context: LookupValidationContext = {
		kind: "available",
		projectId: "derived-once",
		projectRevision: "0" as LookupRevision,
		definitions: [],
	};

	it.each(corpora)(
		"gives over a %s document's construction batch the verdict and readiness fresh runs give",
		async (_name, arbitrary, numRuns) => {
			await fc.assert(
				fc.property(arbitrary, (draw) => {
					rebuildFieldParent(draw);
					const empty = emptyBlueprintDoc(draw.appId);
					const batch = outcome(() => diffDocsToMutations(empty, draw));
					if (!("value" in batch)) return;
					const steps = mutationCommitVerdictSteps(empty, batch.value, context);
					let step = steps.next();
					while (!step.done) step = steps.next();
					const judged = step.value;
					const fresh = mutationCommitVerdict(empty, batch.value, context);
					expect(judged.verdict.ok).toBe(fresh.ok);
					if (!fresh.ok) {
						expect(judged.verdict).toMatchObject({ findings: fresh.findings });
						expect("readiness" in judged).toBe(false);
						return;
					}
					if (!("readiness" in judged))
						throw new Error("An admitted candidate gives its readiness.");
					expect(judged.verdict.nextDoc).toEqual(fresh.nextDoc);
					/* No file is held, so every media reference is a finding, in
					 * the boundary's own order. */
					expect(judged.readiness(new Map())).toEqual(
						exportReadinessFindings(fresh.nextDoc, context, new Map()),
					);
				}),
				{ numRuns: Math.min(numRuns, 15), seed: 20261116 },
			);
		},
		60_000,
	);
});

/** A parsed node as plain data: its kind, name, attributes, text and children in order. */
function treeOf(node: AnyNode): unknown {
	if (isTag(node))
		return {
			name: node.name,
			attribs: { ...node.attribs },
			children: node.children.map(treeOf),
		};
	if ("children" in node)
		return { type: node.type, children: node.children.map(treeOf) };
	return { type: node.type, data: "data" in node ? node.data : null };
}

/** Every node of a tree frozen, its attributes and its child list. */
function frozenThroughout(node: AnyNode): boolean {
	return (
		Object.isFrozen(node) &&
		(!isTag(node) || Object.isFrozen(node.attribs)) &&
		(!("children" in node) ||
			(Object.isFrozen(node.children) && node.children.every(frozenThroughout)))
	);
}

/** `held.expansionSteps` driven whole. */
function heldExpansion(
	held: HeldExpansions,
	doc: BlueprintDoc,
	facts: unknown,
): ReturnType<typeof expandDoc> {
	const steps = held.expansionSteps(doc, facts, () => expandDocSteps(doc));
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

describe("a request's parses and emissions, held", () => {
	it.each(corpora)(
		"parses each %s form text as a fresh parse does, once, frozen throughout",
		async (_name, arbitrary, numRuns) => {
			await fc.assert(
				fc.property(arbitrary, (draw) => {
					rebuildFieldParent(draw);
					const app = outcome(() => expandDoc(draw));
					if (!("value" in app)) return;
					const texts = Object.values(app.value._attachments).filter(
						(text): text is string => typeof text === "string",
					);
					for (const text of [...texts, "<h:html", "<a/>"]) {
						const held = heldXmlParse(text);
						const fresh = outcome(() => parseXml(text));
						if ("issue" in held) {
							expect("threw" in fresh).toBe(true);
							continue;
						}
						if (!("value" in fresh))
							throw new Error("A parse the held one gave.");
						expect(treeOf(held.doc)).toEqual(treeOf(fresh.value));
						expect(frozenThroughout(held.doc)).toBe(true);
						/* A text met again, as another string, is the same parse. */
						expect(heldXmlParse(text.slice(0))).toBe(held);
					}
				}),
				{ numRuns: Math.min(numRuns, 15), seed: 20261116 },
			);
		},
		60_000,
	);

	it.each(corpora)(
		"answers a %s document's emission only for the same settled document under the same facts",
		async (_name, arbitrary, numRuns) => {
			await fc.assert(
				fc.property(arbitrary, (draw) => {
					rebuildFieldParent(draw);
					const fresh = outcome(() => expandDoc(draw));
					if (!("value" in fresh)) return;
					const held = new HeldExpansions();
					const facts = { overrides: [{ uuid: "a" }], naming: [] };
					const settled = freeze(structuredClone(draw), true);
					const first = heldExpansion(held, settled, facts);
					expect(first).toEqual(fresh.value);
					/* Another settled copy, equal throughout, under equal facts: held. */
					const again = freeze(structuredClone(draw), true);
					expect(heldExpansion(held, again, structuredClone(facts))).toBe(
						first,
					);
					/* Other facts, or a document that differs anywhere: emitted afresh. */
					expect(
						heldExpansion(held, again, { ...facts, naming: [{ id: "t" }] }),
					).not.toBe(first);
					const renamed = freeze(
						{ ...structuredClone(draw), appName: `${draw.appName} again` },
						true,
					);
					const renamedEmission = heldExpansion(held, renamed, facts);
					expect(renamedEmission).not.toBe(first);
					expect(renamedEmission).toEqual(expandDoc(renamed));
					/* An open document's emission is never held. */
					const open = structuredClone(draw);
					const openHeld = new HeldExpansions();
					const openFirst = heldExpansion(openHeld, open, facts);
					expect(heldExpansion(openHeld, open, facts)).not.toBe(openFirst);
					/* A held emission is frozen: no reader can write what the next one reads. */
					expect(Object.isFrozen(first)).toBe(true);
					expect(Object.isFrozen(first.modules)).toBe(true);
				}),
				{ numRuns: Math.min(numRuns, 10), seed: 20261116 },
			);
		},
		60_000,
	);
});
