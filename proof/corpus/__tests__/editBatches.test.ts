/**
 * The proof corpus's edit batches: every kept batch is one Nova's own commit
 * gate admits, that changes the document, and that Nova's publish accepts; a
 * removal removes something the document holds; the corpus draws every
 * mutation kind the reducer defines; and a batch is fixed by its document,
 * the seed and, for a fixed document, the fixed list alone.
 *
 * The fixed documents are the reference-bearing wire fixtures, so the census
 * includes batches whose touched entities have readers, plus documents
 * holding the worker, organization, automation and language entities no
 * fixture holds, so every removal kind has something to remove. The sample
 * is a fixed-seed draw of the two compiler fuzz generators.
 * Finite samples establish regressions, not that every edit of every
 * document is covered.
 */

import * as fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { arithmeticFixture } from "@/lib/commcare/__tests__/arithmeticFixture";
import {
	caseCaptureFixture,
	caseCaptureScenarios,
} from "@/lib/commcare/__tests__/caseCaptureFixture";
import {
	caseListEmissionFixture,
	caseListEmissionScenarios,
} from "@/lib/commcare/__tests__/caseListEmissionFixture";
import {
	caseOperationFixture,
	operationScenarios,
} from "@/lib/commcare/__tests__/caseOperationFixture";
import {
	compilerNavigationFixture,
	navigationScenarios,
} from "@/lib/commcare/__tests__/compilerNavigationFixture";
import { connectWireFixtures } from "@/lib/commcare/__tests__/connectWireFixtures";
import {
	endpointScenarios,
	endpointWireFixture,
} from "@/lib/commcare/__tests__/endpointWireFixture";
import {
	extensionCaseFixture,
	extensionScenarios,
} from "@/lib/commcare/__tests__/extensionCaseFixture";
import {
	formLinkWireFixture,
	formLinkWireScenarios,
} from "@/lib/commcare/__tests__/formLinkWireFixture";
import {
	localizationScenarios,
	localizationWireFixture,
} from "@/lib/commcare/__tests__/localizationWireFixture";
import { lookupAppFixture } from "@/lib/commcare/__tests__/lookupAppFixtures";
import { mediaManifest } from "@/lib/commcare/__tests__/mediaWireFixtures";
import {
	nestedMenuScenarios,
	nestedMenuWireFixture,
} from "@/lib/commcare/__tests__/nestedMenuWireFixture";
import {
	relationInstanceFixture,
	relationInstanceScenarios,
} from "@/lib/commcare/__tests__/relationInstanceFixture";
import {
	searchEmissionFixture,
	searchEmissionScenarios,
} from "@/lib/commcare/__tests__/searchEmissionFixture";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import {
	tileFixture,
	tileScenarios,
} from "@/lib/commcare/__tests__/tileFixture";
import { usercaseWriteFixture } from "@/lib/commcare/__tests__/usercaseWriteFixture";
import {
	workerSlugs,
	workerWireFixture,
} from "@/lib/commcare/__tests__/workerWireFixture";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import {
	LOCATION_SCENARIOS,
	locationOwnerFixture,
} from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { runValidation } from "@/lib/commcare/validator/runner";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	rebuildFieldParent,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	asMediaAssetId,
	type BlueprintDoc,
	blueprintDocSchema,
	effectiveAppLocalization,
	type Form,
	MAX_MEDIA_EXPORT_ASSETS,
	type PersistableDoc,
	proseText,
} from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import type { AssetMimeType } from "@/lib/domain/multimedia";
import { classifyStoredMediaBytes } from "@/lib/media/validate";
import { heldPlacement } from "../../targeted/documents/heldPlacement";
import { lookupContextOf } from "../documents";
import {
	admitEditBatch,
	afterFirstPublish,
	censusFloorFailures,
	type EditBatchOutcome,
	type EditCensus,
	type EditCorpus,
	type EditCorpusDocument,
	editBatchCorpus,
	editBatchFor,
	formatCensus,
	hydrateAdmittedDocument,
	MEDIA_MIME,
	publishFindings,
	writtenEditBatch,
	writtenEditOverRecord,
} from "../editBatches";
import { Minter, Rng, uuidTokensOf } from "../editContext";
import { type Candidate, EDIT_KIND_GENERATORS } from "../editKinds";
import {
	WORKFORCE_BASES,
	workforceDocument,
	workforceDocumentId,
} from "../workforce";

const SEED = 20260930;
const FUZZ_SAMPLES_PER_GENERATOR = 60;

/**
 * The two nested-menu scenarios whose HQ projection Nova's publish refuses
 * (`hqNestedSelectionFindings`); every other scenario is a corpus document.
 */
const PUBLISH_REFUSED_NESTED = new Set(["same-smaller", "parent-multiple"]);

function stored(id: string, doc: BlueprintDoc): EditCorpusDocument {
	return { id, doc: toPersistableDoc(doc) };
}

/** `targeted-held-placement`'s D as its first publish stores it: Update's
 *  own case held in Case Management's slot, Weigh's in its Save to Case
 *  block. */
function heldPlacementInput(): EditCorpusDocument {
	const { id, doc } = heldPlacement();
	return {
		id,
		doc: afterFirstPublish(id, hydratePersistedBlueprint(doc), undefined).doc,
	};
}

function fixedDocuments(): EditCorpusDocument[] {
	const documents: EditCorpusDocument[] = [];
	documents.push(stored("arithmetic", arithmeticFixture().doc));
	for (const scenario of operationScenarios) {
		documents.push(
			stored(`case-operation-${scenario}`, caseOperationFixture(scenario)),
		);
	}
	for (const scenario of navigationScenarios) {
		documents.push(
			stored(`navigation-${scenario}`, compilerNavigationFixture(scenario)),
		);
	}
	for (const scenario of formLinkWireScenarios) {
		documents.push(
			stored(`form-link-${scenario}`, formLinkWireFixture(scenario)),
		);
	}
	for (const scenario of localizationScenarios) {
		documents.push(
			stored(`localization-${scenario}`, localizationWireFixture(scenario)),
		);
	}
	for (const scenario of endpointScenarios) {
		documents.push(
			stored(`endpoint-${scenario}`, endpointWireFixture(scenario)),
		);
	}
	for (const slug of workerSlugs) {
		documents.push(stored(`worker-${slug}`, workerWireFixture(slug).doc));
	}
	for (const scenario of searchEmissionScenarios) {
		documents.push(
			stored(`search-${scenario}`, searchEmissionFixture(scenario)),
		);
	}
	for (const scenario of extensionScenarios) {
		documents.push(
			stored(`extension-${scenario}`, extensionCaseFixture(scenario)),
		);
	}
	for (const scenario of tileScenarios) {
		documents.push(stored(`tile-${scenario}`, tileFixture(scenario)));
	}
	for (const type of ["survey", "followup"] as const) {
		documents.push(stored(`usercase-${type}`, usercaseWriteFixture(type)));
	}
	for (const scenario of caseListEmissionScenarios) {
		documents.push(
			stored(`case-list-${scenario}`, caseListEmissionFixture(scenario).doc),
		);
	}
	for (const scenario of caseCaptureScenarios) {
		documents.push(stored(`capture-${scenario}`, caseCaptureFixture(scenario)));
	}
	for (const scenario of relationInstanceScenarios) {
		documents.push(
			stored(`relation-${scenario}`, relationInstanceFixture(scenario)),
		);
	}
	for (const { name, doc } of connectWireFixtures()) {
		documents.push(stored(`connect-${name}`, doc));
	}
	for (const scenario of nestedMenuScenarios) {
		if (PUBLISH_REFUSED_NESTED.has(scenario)) continue;
		documents.push(
			stored(`nested-${scenario}`, nestedMenuWireFixture(scenario)),
		);
	}
	for (const scenario of LOCATION_SCENARIOS) {
		documents.push(
			stored(`location-owner-${scenario}`, locationOwnerFixture(scenario)),
		);
	}
	// The corpus's workforce documents, over this list's documents of the
	// same ids: the only ones holding roles, personas, place properties,
	// automations and a worker property nothing reads.
	const byId = new Map(documents.map((document) => [document.id, document]));
	for (const baseId of WORKFORCE_BASES) {
		const base = byId.get(baseId);
		if (base === undefined) throw new Error(`No fixed document ${baseId}.`);
		documents.push(
			stored(workforceDocumentId(baseId), workforceDocument(base)),
		);
	}
	// The one document whose D holds placements, as a published app's does:
	// the only host of a move of a held placement.
	documents.push(heldPlacementInput());
	for (const reversed of [false, true]) {
		const fixture = lookupAppFixture(reversed);
		documents.push({
			id: `lookup-${reversed ? "reversed" : "ordered"}`,
			doc: toPersistableDoc(fixture.doc),
			lookup: {
				projectId: fixture.context.projectId,
				projectRevision: fixture.context.projectRevision,
				definitions: [fixture.table],
				rowsByTable: new Map([[fixture.table.id, fixture.rows]]),
			},
		});
	}
	return documents;
}

function sampledDocuments(): EditCorpusDocument[] {
	const documents: EditCorpusDocument[] = [];
	for (const [index, raw] of fc
		.sample(blueprintDocArbitrary, {
			seed: SEED,
			numRuns: FUZZ_SAMPLES_PER_GENERATOR,
		})
		.entries()) {
		rebuildFieldParent(raw);
		documents.push(stored(`xform-fuzz-${index}`, raw));
	}
	for (const [index, raw] of fc
		.sample(suiteDocArbitrary, {
			seed: SEED,
			numRuns: FUZZ_SAMPLES_PER_GENERATOR,
		})
		.entries()) {
		// The suite fuzz nests its second module under its first inside the
		// property; the corpus document is that nested document.
		const [root, child] = raw.moduleOrder;
		const childModule = child === undefined ? undefined : raw.modules[child];
		if (root !== undefined && childModule !== undefined) {
			childModule.parentModuleUuid = root;
		}
		rebuildFieldParent(raw);
		documents.push(stored(`suite-fuzz-${index}`, raw));
	}
	return documents;
}

/**
 * Whether a removal names something the stored document holds, read from
 * the stored document directly; `undefined` for a kind that removes nothing.
 */
function removesHeldEntity(
	storedDoc: PersistableDoc,
	mutation: Mutation,
): boolean | undefined {
	const catalog = storedDoc.caseTypes ?? [];
	switch (mutation.kind) {
		case "removeLanguage":
			return effectiveAppLocalization(
				storedDoc.localization,
			).languageOrder.includes(mutation.code);
		case "retireCaseType":
			return catalog.some((ct) => ct.name === mutation.caseType);
		case "removeCaseProperty":
			return catalog.some(
				(ct) =>
					ct.name === mutation.caseType &&
					ct.properties.some((p) => p.name === mutation.property),
			);
		case "removeEntryPoint":
			return uuidTokensOf(storedDoc).has(mutation.entryPointUuid);
		case "removeModule":
		case "removeForm":
		case "removeFormLink":
		case "removeField":
		case "removeOption":
		case "removeColumn":
		case "removeSearchInput":
		case "removeUserProperty":
		case "removeUserType":
		case "removePersona":
		case "removeOrganizationLevel":
		case "removeLocationProperty":
		case "removeAutomation":
			return uuidTokensOf(storedDoc).has(mutation.uuid);
		default:
			return undefined;
	}
}

/** Every kept batch, as JSON, keyed by document: what determinism compares. */
function batchesByDocument(
	outcomes: readonly EditBatchOutcome[],
): Record<string, string> {
	return Object.fromEntries(
		outcomes.map((outcome) => [
			outcome.documentId,
			JSON.stringify(
				outcome.batch === undefined
					? null
					: {
							intendedKind: outcome.batch.intendedKind,
							mutations: outcome.batch.mutations,
							touched: outcome.batch.touched,
						},
			),
		]),
	);
}

function pick(
	batches: Record<string, string>,
	documents: readonly EditCorpusDocument[],
): Record<string, string | undefined> {
	return Object.fromEntries(documents.map((d) => [d.id, batches[d.id]]));
}

describe("proof corpus edit batches", () => {
	let corpus: EditCorpus;
	let outcomes: readonly EditBatchOutcome[];
	let census: EditCensus;

	beforeAll(() => {
		corpus = { fixed: fixedDocuments(), sampled: sampledDocuments() };
		({ outcomes, census } = editBatchCorpus(corpus, SEED));
	});

	// One commit verdict and one validation per document: about a second
	// locally, and CI runners take about four times as long as a laptop for
	// the compiler fuzz corpora.
	it("keeps only batches Nova's commit gate admits that change the document, and D′ is a document Nova's publish accepts", {
		timeout: 30_000,
	}, () => {
		const byId = new Map(
			[...corpus.fixed, ...corpus.sampled].map((d) => [d.id, d]),
		);
		let kept = 0;
		for (const outcome of outcomes) {
			const batch = outcome.batch;
			if (batch === undefined) continue;
			kept += 1;
			const input = byId.get(outcome.documentId);
			if (input === undefined) throw new Error(outcome.documentId);
			// Re-verified from the stored document and the batch's JSON, not
			// from anything the generator computed.
			const doc = hydratePersistedBlueprint(
				blueprintDocSchema.parse(input.doc),
			);
			const wire = JSON.parse(JSON.stringify(batch.mutations)) as Mutation[];
			const verdict = mutationCommitVerdict(
				doc,
				wire,
				lookupContextOf(input.lookup),
			);
			expect(
				verdict.ok,
				`${outcome.documentId} ${batch.intendedKind}: ${
					verdict.ok ? "" : JSON.stringify(verdict.findings.map((f) => f.code))
				}`,
			).toBe(true);
			if (!verdict.ok) continue;
			const next = toPersistableDoc(verdict.nextDoc);
			expect(next).toEqual(toPersistableDoc(batch.nextDoc));
			expect(
				next,
				`${outcome.documentId} ${batch.intendedKind} leaves the document as it was`,
			).not.toEqual(toPersistableDoc(doc));
			expect(blueprintDocSchema.safeParse(next).success).toBe(true);
			expect(
				runValidation(verdict.nextDoc, lookupContextOf(input.lookup)),
			).toEqual([]);
			expect(publishFindings(verdict.nextDoc, input.lookup)).toEqual([]);
			expect(batch.kinds).toEqual(wire.map((m) => m.kind));
			expect(batch.kinds).toContain(batch.intendedKind);
			for (const mutation of wire) {
				if (mutation.kind !== batch.intendedKind) continue;
				expect(
					removesHeldEntity(input.doc, mutation) ?? true,
					`${outcome.documentId} ${mutation.kind} removes something the document does not hold`,
				).toBe(true);
			}
		}
		expect(kept).toBe(corpus.fixed.length + corpus.sampled.length);
	});

	it("draws every mutation kind the reducer defines, and reaches readers", () => {
		expect(
			censusFloorFailures(census),
			`Kinds no kept batch was drawn for, with the refusals each met:\n${formatCensus(census)}`,
		).toEqual([]);
		expect(
			census.batchesWithReaders,
			`No kept batch touched an entity the reference index says something reads:\n${formatCensus(census)}`,
		).toBeGreaterThan(0);
		// A planner, the commit gate or a publish check that raises instead of
		// answering is a Nova defect this corpus reached; it is never a refusal.
		expect(census.errors).toEqual([]);
	});

	// Two more corpus runs: a few seconds locally.
	it("gives each document the same batch whatever order the corpus arrives in and however large the sample is", {
		timeout: 30_000,
	}, () => {
		const batches = batchesByDocument(outcomes);
		const half = corpus.sampled.slice(0, FUZZ_SAMPLES_PER_GENERATOR / 2);
		const smaller = editBatchCorpus(
			{ fixed: [...corpus.fixed].reverse(), sampled: [...half].reverse() },
			SEED,
		);
		const smallerBatches = batchesByDocument(smaller.outcomes);
		expect(pick(smallerBatches, corpus.fixed)).toEqual(
			pick(batches, corpus.fixed),
		);
		expect(pick(smallerBatches, half)).toEqual(pick(batches, half));
		// A sampled document's batch is its own: the corpus adds nothing to it.
		const [alone] = half;
		if (alone === undefined) throw new Error("The sample is empty.");
		expect(batchesByDocument([editBatchFor(alone, SEED)])).toEqual(
			pick(batches, [alone]),
		);
		const reseeded = editBatchCorpus(corpus, SEED + 1);
		expect(batchesByDocument(reseeded.outcomes)).not.toEqual(batches);
	});
});

describe("turning Connect on", () => {
	const proposals = (input: EditCorpusDocument) => {
		const doc = hydrateAdmittedDocument(input);
		return EDIT_KIND_GENERATORS.setConnectType({
			doc,
			known: uuidTokensOf(input.doc),
			rng: new Rng(`connect\u0000${input.id}`),
			mint: new Minter(`connect\u0000${input.id}`, SEED),
		});
	};
	const mutationsOf = (candidate: Candidate | undefined) => {
		if (candidate === undefined || !("mutations" in candidate))
			throw new Error("Expected the generator to propose a batch.");
		return candidate.mutations;
	};

	it("turns Connect on as the builder commits it, narrowing the app to Android in the same batch, and is refused where the content cannot run on Android", () => {
		const both = stored("arithmetic", arithmeticFixture().doc);
		const [first] = proposals(both);
		const mutations = mutationsOf(first);
		expect(mutations[0]).toEqual({
			kind: "setAppSettings",
			settings: { runsOnlyOn: "android" },
		});
		expect(
			mutations.some((mutation) => mutation.kind === "setConnectType"),
		).toBe(true);
		const admitted = admitEditBatch(both, mutations);
		expect(admitted.ok).toBe(true);
		if (admitted.ok)
			expect(admitted.nextDoc.appSettings.runsOnlyOn).toBe("android");

		const android = stored(
			"case-operation-sequence",
			caseOperationFixture("sequence"),
		);
		expect(
			mutationsOf(proposals(android)[0]).some(
				(mutation) => mutation.kind === "setAppSettings",
			),
		).toBe(false);

		const readsSearch = stored(
			"search-inline",
			searchEmissionFixture("inline"),
		);
		const refused = admitEditBatch(
			readsSearch,
			mutationsOf(proposals(readsSearch)[0]),
		);
		expect(refused.ok).toBe(false);
		if (!refused.ok)
			expect(refused.codes).toContain("PLATFORM_FEATURE_UNAVAILABLE");
	});
});

/**
 * Contract: a corpus edit that changes a held placement is one an editor can
 * commit: the move its own change needs, planned as an editor's batch plans
 * it, and nothing the commit kernel's placement rule refuses. The plausible
 * failures: a generator whose batch strands a hold without its move (the
 * gate refuses it), a kept batch that records a hold where none needs moving
 * (the commit gate alone admits it, and only the kernel's rule refuses it),
 * and a written edit that moves a hold landing as another kind, so the kind
 * would never land on the corpus.
 */
describe("a held placement", () => {
	const input = heldPlacementInput();
	const doc = () => hydrateAdmittedDocument(input);
	const formNamed = (name: string) => {
		const form = Object.values(doc().forms).find((f) => f.name === name);
		if (form === undefined) throw new Error(`No form ${name}.`);
		return form;
	};
	const ownOf = (form: Form | undefined) => {
		const own = form?.caseOperations?.[0];
		if (own?.action !== "own") throw new Error("The form holds its own case.");
		return own;
	};

	it("moves a held placement as an editor's batch moves it, and refuses one that records a hold", () => {
		const update = formNamed("Update");
		const weigh = formNamed("Weigh");
		const [first] = EDIT_KIND_GENERATORS.holdPlacements({
			doc: doc(),
			known: uuidTokensOf(input.doc),
			rng: new Rng(`holds\u0000${input.id}`),
			mint: new Minter(`holds\u0000${input.id}`, SEED),
		});
		if (first === undefined || !("mutations" in first))
			throw new Error("Expected the generator to propose a batch.");
		const moved = admitEditBatch(input, first.mutations);
		expect(moved.ok).toBe(true);
		if (!moved.ok) return;
		// The move rides last, as the identity-move planner appends it, and
		// takes Update's own case to its Save to Case block.
		expect(moved.mutations.at(-1)).toEqual({
			kind: "holdPlacements",
			holds: [
				{
					target: "case-operation",
					formUuid: update.uuid,
					operationUuid: ownOf(update).uuid,
					placement: {
						kind: "save-to-case",
						path: ["nova_operations", "patient"],
					},
				},
			],
		});
		expect(ownOf(moved.nextDoc.forms[weigh.uuid])).toEqual(ownOf(weigh));

		// Recording Update's Save to Case block with no change that needs it:
		// the commit gate admits it, and the kernel's rule refuses it.
		const recorded: Mutation[] = [
			{
				kind: "holdPlacements",
				holds: [
					{
						target: "case-operation",
						formUuid: update.uuid,
						operationUuid: ownOf(update).uuid,
						placement: {
							kind: "save-to-case",
							path: ["nova_operations", "patient"],
						},
					},
				],
			},
		];
		expect(
			mutationCommitVerdict(doc(), recorded, LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(true);
		expect(admitEditBatch(input, recorded)).toEqual({
			ok: false,
			codes: ["kernel:placement-change"],
		});

		// The written edit of `targeted-held-placement`, made again over the
		// held D as the emitter makes it, stands for the move.
		const { edit } = heldPlacement();
		if (edit === undefined) throw new Error("The document writes its edit.");
		const over = writtenEditOverRecord(
			input.id,
			doc(),
			edit.mutations,
			undefined,
		);
		expect(
			writtenEditBatch(input.id, SEED, doc(), over.mutations, over.nextDoc)
				.intendedKind,
		).toBe("holdPlacements");
		expect(over.mutations[0]?.kind).toBe("updateForm");
	});
});

describe("a batch that leaves the document as it was", () => {
	it("is refused even though the commit gate admits it, and the same birth alone is kept", () => {
		const input = stored("arithmetic", arithmeticFixture().doc);
		const persona = testUuid("no-op-persona");
		const birth: Mutation[] = [
			{ kind: "addPersona", persona: { uuid: persona, name: "Asha" } },
		];
		const roundTrip: Mutation[] = [
			...birth,
			{ kind: "removePersona", uuid: persona },
		];
		expect(
			mutationCommitVerdict(
				hydrateAdmittedDocument(input),
				roundTrip,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(true);
		expect(admitEditBatch(input, roundTrip)).toEqual({
			ok: false,
			codes: ["no-op"],
		});
		expect(admitEditBatch(input, birth).ok).toBe(true);
	});
});

describe("the publish-side checks the commit gate does not cover", () => {
	it("refuses a batch that takes the app past the media export budget, and keeps one that reaches it", () => {
		const input = stored("arithmetic", arithmeticFixture().doc);
		const doc = hydrateAdmittedDocument(input);
		const moduleUuid = doc.moduleOrder[0];
		const formUuid =
			moduleUuid === undefined ? undefined : doc.formOrder[moduleUuid]?.[0];
		if (formUuid === undefined || collectAssetRefs(doc).size > 0) {
			throw new Error(
				"The arithmetic fixture should have a form and no media for this check.",
			);
		}
		// One picture per new label question: `count` distinct images.
		const pictures = (count: number): Mutation[] =>
			Array.from({ length: count }, (_, index) => ({
				kind: "addField",
				parentUuid: formUuid,
				field: {
					kind: "label",
					uuid: testUuid(`budget-question-${index}`),
					id: `budget_picture_${index}`,
					label: proseText(`Picture ${index}`),
					label_media: {
						image: asMediaAssetId(testUuid(`budget-image-${index}`)),
					},
				},
			}));
		expect(admitEditBatch(input, pictures(MAX_MEDIA_EXPORT_ASSETS)).ok).toBe(
			true,
		);
		expect(
			admitEditBatch(input, pictures(MAX_MEDIA_EXPORT_ASSETS + 1)),
		).toEqual({ ok: false, codes: ["publish:MEDIA_EXPORT_TOO_LARGE"] });
	});

	it("refuses a document whose HQ projection Nova's publish refuses, and admits its publishable sibling", () => {
		const refused = nestedMenuWireFixture("same-smaller");
		expect(
			mutationCommitVerdict(refused, [], LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(true);
		expect(() =>
			hydrateAdmittedDocument(stored("nested-same-smaller", refused)),
		).toThrow(/HQ_NESTED_SELECTION_UNREPRESENTABLE/);
		expect(() =>
			hydrateAdmittedDocument(
				stored("nested-same", nestedMenuWireFixture("same")),
			),
		).not.toThrow();
	});

	it("does not keep a batch the commit gate admits but Nova's publish refuses, and keeps its publishable twin", () => {
		const raw = fc
			.sample(blueprintDocArbitrary, { seed: SEED, numRuns: 40 })
			.find((doc) => doc.logo !== undefined);
		if (raw === undefined) throw new Error("No sampled document has a logo.");
		rebuildFieldParent(raw);
		const input = stored("logo", raw);
		const doc = hydrateAdmittedDocument(input);
		const logo = doc.logo;
		const moduleUuid = doc.moduleOrder[0];
		if (logo === undefined || moduleUuid === undefined) {
			throw new Error("The sampled document lost its logo or module.");
		}
		const module = doc.modules[moduleUuid];
		const withAudio = (audioLabel: string): Mutation[] => [
			{
				kind: "setModuleMedia",
				uuid: moduleUuid,
				icon: module?.icon ?? null,
				audioLabel: asMediaAssetId(audioLabel),
			},
		];
		// The logo's image asset as the menu's audio label: the commit gate has
		// no media rows to judge it by, the export boundary does.
		expect(
			mutationCommitVerdict(doc, withAudio(logo), LOOKUP_CONTEXT_UNAVAILABLE)
				.ok,
		).toBe(true);
		expect(admitEditBatch(input, withAudio(logo))).toEqual({
			ok: false,
			codes: ["publish:MEDIA_KIND_MISMATCH"],
		});
		const fresh = admitEditBatch(
			input,
			withAudio("0b7d4f7e-5a1c-5b2e-9c3d-4e5f60718293"),
		);
		expect(fresh.ok).toBe(true);
	});
});

describe("the corpus's stand-in media rows", () => {
	it("give each slot kind the variant the classifier gives the corpus's own file of that kind", async () => {
		const files = [...mediaManifest().values()];
		for (const [kind, standIn] of Object.entries(MEDIA_MIME)) {
			const file = files.find(
				(asset) => asset.kind === kind && asset.mimeType === standIn.mimeType,
			);
			if (file?.bytes === undefined) {
				throw new Error(`The corpus manifest holds no ${kind} file.`);
			}
			expect(
				await classifyStoredMediaBytes(file.bytes, {
					mimeType: standIn.mimeType as AssetMimeType,
					extension: standIn.extension,
				}),
				kind,
			).toBe(standIn.mediaFormat);
		}
	});
});

/**
 * Contract: the corpus's otherwise edit is one an editor can commit, so it
 * lands only where a destination may not run. The plausible failures: a
 * generator that sets an otherwise beside destinations that all run every
 * time (the gate refuses it, `FORM_OTHERWISE_UNREACHABLE`, and the kind lands
 * on no document), and one that sets the otherwise the form already holds
 * (a batch that changes nothing).
 */
describe("an otherwise", () => {
	const proposals = (input: EditCorpusDocument) =>
		EDIT_KIND_GENERATORS.setFormOtherwise({
			doc: hydrateAdmittedDocument(input),
			known: uuidTokensOf(input.doc),
			rng: new Rng(`otherwise\u0000${input.id}`),
			mint: new Minter(`otherwise\u0000${input.id}`, SEED),
		});
	/** The batch the generator proposes for the form named `name`. */
	const batchFor = (input: EditCorpusDocument, name: string) => {
		const form = Object.values(input.doc.forms).find(
			(candidate) => candidate.name === name,
		);
		if (form === undefined) throw new Error(`No form ${name}.`);
		const found = proposals(input).find(
			(candidate) =>
				"mutations" in candidate &&
				candidate.mutations.some(
					(mutation) =>
						mutation.kind === "setFormOtherwise" &&
						mutation.formUuid === form.uuid,
				),
		);
		if (found === undefined || !("mutations" in found))
			throw new Error(`Expected a batch for ${name}.`);
		return found.mutations;
	};
	const kinds = (mutations: readonly Mutation[]) =>
		mutations.map((mutation) => mutation.kind);

	it("sets an otherwise only on a form with a conditional link", () => {
		// A conditional destination beside the menu as its otherwise: the
		// otherwise changes, and nothing else does.
		const conditional = stored(
			"form-link-module",
			formLinkWireFixture("module"),
		);
		const changed = batchFor(conditional, "Register frog");
		expect(kinds(changed)).toEqual(["setFormOtherwise"]);
		expect(changed[0]).toMatchObject({ otherwise: { kind: "destination" } });
		expect(changed[0]).not.toMatchObject({
			otherwise: { destination: "module" },
		});
		expect(admitEditBatch(conditional, changed).ok).toBe(true);

		// Every destination runs every time: no otherwise is reachable, so the
		// batch first gives the form a destination with a condition.
		const everyTime = stored(
			"form-link-unconditional",
			formLinkWireFixture("unconditional"),
		);
		const born = batchFor(everyTime, "Register frog");
		expect(kinds(born)[0]).toBe("addFormLink");
		expect(kinds(born).at(-1)).toBe("setFormOtherwise");
		expect(born[0]).toMatchObject({ link: { condition: {} } });
		expect(admitEditBatch(everyTime, born).ok).toBe(true);
		// Without that destination, the gate refuses the otherwise alone.
		expect(
			admitEditBatch(
				everyTime,
				born.filter((mutation) => mutation.kind === "setFormOtherwise"),
			).ok,
		).toBe(false);
	});
});
