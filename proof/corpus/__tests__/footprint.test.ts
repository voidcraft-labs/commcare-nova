/**
 * The corpus's fixed sources, as the lane builds them in this process, give
 * every mutation kind a batch, and each batch's footprint holds every
 * module and form whose wire the batch changes.
 *
 * Both properties read one edit-batch corpus, drawn once as the emission
 * draws the fixed floor's (`editBatchCorpus` over the fixed list at the
 * corpus's seed): the producers' documents Nova's publish takes, and the
 * workforce documents built over them (`../workforce.ts`). The lane's fixed
 * floor also holds the expander and targeted documents, which do not build
 * in this process.
 *
 * Every kind lands. Contract: the corpus draws every mutation kind the
 * reducer defines, and the lane's emission stops, naming the kind, when one
 * lands on no fixed document (`../emitCorpus.ts`, `requireEveryKind`). The
 * plausible failure is a producer fixture, a workforce entity or an
 * edit-kind generator changing so that some kind has nothing to edit, or
 * only refusals, on every fixed document; the lane would stop at emission,
 * after building the image and HQ's apps, and this fails first, in ordinary
 * CI. It counts the generator's admissions (`censusFloorFailures`). The
 * lane's floor counts the batches it writes (`landed`): it also leaves out
 * an edit Nova's direct upload or local export refuses beyond the checks
 * the generator applies, and its expander and targeted documents change how
 * kinds are balanced, so the lane's own floor remains the guard.
 * The paired refusal is the same producers without the workforce documents:
 * exactly the five removal kinds whose only targets those documents hold
 * then land nowhere.
 *
 * The footprint. Contract: proof 5 (locality) compares, between the builds
 * of D and D′, each module and form outside the batch's footprint, so the
 * footprint must name every module and form whose emitted wire the batch
 * can change. The plausible failure is a footprint that misses one (a
 * reader the reference index keeps under a key the footprint does not ask
 * about, a form's module, a no-matches form's hidden module, an app-wide
 * edit, a form whose wire Nova derives from its module's settings or from
 * its parent module's form list), which proof 5 would then report as a
 * locality defect that is not one. Nova's own exports are the observation:
 * when Nova's app JSON for a module or form, or a form's XForm or entry in
 * Nova's local archive, differs between D and D′, what HQ builds and what a
 * device runs differ too.
 *
 * Each document is expanded before and after its batch, with media on and
 * each referenced asset at its own wire path, as distinct uploads are, and
 * compiled into its local archive. The expansions are compared per module
 * (its JSON without its forms), per form (its JSON and its XForm source)
 * and for the app itself (its JSON without its modules and form sources),
 * with the identities Nova mints on each expansion (module and form
 * `unique_id`, form `xmlns`) replaced by the Nova uuid at their position in
 * the wire layout (`../footprint.ts::wireLayout`). The archives are compared
 * per form (its XForm and its suite `<entry>`), parsed, where every module
 * and form both sides hold keeps its position, so the archive's positional
 * ids name the same entities on both sides. When the app's own part differs
 * the footprint must say the batch reaches the app (`app`); the plausible
 * failures there are a media edit, whose question or menu is in the
 * footprint, also changing the app's media map while the footprint says the
 * app is untouched, and a language-catalog or Connect-type edit changing
 * the app's `langs`, `translations` or `auto_gps_capture`.
 *
 * Beside the corpus, single edits show each of the footprint's derivations
 * (`../footprint.ts`) reaching exactly what Nova writes from what they
 * edit. The plausible failures are a module setting Nova writes into forms'
 * wire that the footprint does not read, or reads for too few forms, and a
 * setting read too broadly: a whole expression where only the instances it
 * reaches enter the entries, a whole case list where only the search's
 * inputs and supporting-case need do, a datum's setting reaching forms
 * whose entries hold no case datum, a whole form list where only the
 * datums its forms share or its first form's do, or a link to a form whose
 * frame the setting never enters. Either would leave proof 5 reporting a
 * change the batch made, or never checking forms the batch left alone. So
 * each derivation has an edit whose forms change and must be in the
 * footprint, paired with an edit near it that changes none of some forms,
 * which the footprint must leave out:
 *
 * - what names a module's case selection (its selection, the module it
 *   selects under, its case type) reaches its case-loading forms and those
 *   of the modules selecting under it, not its registration or survey form;
 * - what else the selection datum holds (its filter, owner exclusion, kept
 *   tile, opening on Search, and the inline search of a module that opens
 *   on Search) reaches the same forms, not those nested under it; within
 *   the inline search, a search input's name, a subtitle and a calculated
 *   column's need for related cases reach them, and a label, a title, or a
 *   column leaving the list or the detail does not;
 * - what only its own case datum holds (its detail screen, its tile
 *   grouping) reaches its case-loading forms, not its registration form;
 * - the instances its filter and owner exclusion reach reach every form of
 *   the module, and an edit that keeps them (a literal, another worker
 *   field) reaches the case-loading forms alone; the instances its search
 *   button condition and calculated columns reach reach every form, and an
 *   edit that keeps them reaches none;
 * - its place under a menu reaches its forms, not the menu's;
 * - what the modules nested under it read of its forms (the computed and
 *   selection datums they align with, the datums its forms share) reaches
 *   their forms when it changes (its selection, a worker-record write or a
 *   child case on its first form, a form added beside them) and only then
 *   (a form's name, a follow-up turning into a close, another form's
 *   worker-record write, another property of the child case), and only the
 *   nested forms that hold it (a selection datum only a case-loading entry
 *   aligns); a link that opens a form so reached is reached too;
 * - a worker property's slug reaches the case-loading forms of a module
 *   whose filter, or whose search input on a module that opens on Search,
 *   reads it, not those of one whose display condition, search button
 *   condition, calculated column, or search input on a module that opens on
 *   its list does, and not a link that opens one of them;
 * - a new language reaches the app.
 *
 * Dropping any one of these derivations fails at least one control, and so
 * does widening one to what an earlier footprint read.
 */

import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { type AnyNode, type Element, isTag } from "domhandler";
import { beforeAll, describe, expect, it } from "vitest";
import type { HqApplication } from "@/lib/commcare";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	type AssetManifest,
	type ResolvedMediaAsset,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { parseXml } from "@/lib/commcare/xmlParse";
import { caseSearchConfigPatchMutations } from "@/lib/doc/caseSearchConfigPatchMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { formScaffoldMutations } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	blueprintDocSchema,
	effectiveCaseSearchConfig,
	type FormType,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { type MediaSlotKind, walkAssetRefs } from "@/lib/domain/mediaRefs";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { DEFAULT_CORPUS_SEED } from "../defaults";
import type { CorpusDocument } from "../documents";
import {
	censusFloorFailures,
	type EditBatchOutcome,
	type EditCensus,
	editBatchCorpus,
	formatCensus,
	publishFindings,
} from "../editBatches";
import { uuidTokensOf } from "../editContext";
import { batchFootprint, type WireModule, wireLayout } from "../footprint";
import { producerDocuments } from "../producers";
import { workforceDocuments } from "../workforce";

const SLOT_FILES: Record<
	MediaSlotKind,
	Pick<ResolvedMediaAsset, "mimeType" | "extension">
> = {
	image: { mimeType: "image/png", extension: ".png" },
	audio: { mimeType: "audio/wav", extension: ".wav" },
	video: { mimeType: "video/mp4", extension: ".mp4" },
};

/**
 * Every asset the document references, each at its own wire path, as
 * distinct uploads resolve. The expander writes references and the media
 * map from paths alone; the local archive bundles each asset's bytes,
 * which here are its id.
 */
function distinctManifest(doc: BlueprintDoc): AssetManifest {
	const manifest = new Map<ResolvedMediaAsset["assetId"], ResolvedMediaAsset>();
	for (const ref of walkAssetRefs(doc)) {
		const file = SLOT_FILES[ref.slotKind];
		const contentHash = createHash("sha256").update(ref.assetId).digest("hex");
		manifest.set(ref.assetId, {
			assetId: ref.assetId,
			kind: ref.slotKind,
			...file,
			contentHash,
			wirePath: wirePathFor(contentHash, file.extension),
			bytes: Buffer.from(ref.assetId),
		});
	}
	return manifest;
}

/** The key the app's own part of the expansion sits under in `Wire.upload`. */
const APP = "app";

/** One side of a batch as Nova exports it. */
interface Wire {
	/** Each module's and form's app JSON (a form's with its XForm source) by Nova uuid, and the app's own part (`APP`). */
	readonly upload: ReadonlyMap<string, string>;
	/** Each form's local XForm and suite entry, by Nova uuid. */
	readonly local: ReadonlyMap<string, string>;
	readonly layout: readonly WireModule[];
}

function elements(node: AnyNode): Element[] {
	if (!isTag(node) && !("children" in node)) return [];
	const children = "children" in node ? node.children : [];
	return [
		...(isTag(node) ? [node] : []),
		...children.flatMap((child) => elements(child)),
	];
}

/**
 * Each form's local wire: its XForm and its `<entry>` in the suite (the
 * entry whose `<command>` is the form's `m<i>-f<j>`), parsed and printed.
 */
function localWire(
	archive: Buffer,
	layout: readonly WireModule[],
	scrub: (text: string) => string,
): Map<string, string> {
	const zip = new AdmZip(archive);
	const entries = new Map<string, string>();
	for (const element of elements(parseXml(zip.readAsText("suite.xml")))) {
		if (element.name !== "entry") continue;
		const command = element.children.find(
			(child): child is Element => isTag(child) && child.name === "command",
		);
		if (command?.attribs.id !== undefined) {
			entries.set(command.attribs.id, serializeXml(element));
		}
	}
	const wire = new Map<string, string>();
	layout.forEach((module, m) => {
		module.forms.forEach((form, f) => {
			const xform = zip.readAsText(`modules-${m}/forms-${f}.xml`);
			const entry = entries.get(`m${m}-f${f}`);
			if (entry === undefined) throw new Error(`No suite entry m${m}-f${f}.`);
			wire.set(form, scrub(`${serializeXml(parseXml(xform))}\n${entry}`));
		});
	});
	return wire;
}

/**
 * Nova's exports of `doc`: the upload's app JSON and the local archive, each
 * module and form by Nova uuid, with the identities Nova mints on each
 * expansion replaced.
 */
function wireOf(
	doc: BlueprintDoc,
	lookup: LookupFixtureDataSnapshot | undefined,
): Wire {
	const assets = distinctManifest(doc);
	const naming =
		lookup === undefined ? undefined : lookupWireNaming(lookup.definitions);
	const app: HqApplication = expandDoc(doc, {
		assets,
		...(naming !== undefined && { lookupNaming: naming }),
	});
	const layout = wireLayout(doc);
	expect(app.modules).toHaveLength(layout.length);
	const minted = new Map<string, string>();
	app.modules.forEach((module, m) => {
		const placed = layout[m];
		if (placed === undefined) throw new Error(`No wire module at ${m}.`);
		minted.set(module.unique_id, `module:${placed.uuid}`);
		expect(module.forms).toHaveLength(placed.forms.length);
		module.forms.forEach((form, f) => {
			const uuid = placed.forms[f];
			minted.set(form.unique_id, `form:${uuid}`);
			if (form.xmlns) minted.set(form.xmlns, `xmlns:${uuid}`);
		});
	});
	const scrub = (text: string) => {
		let out = text;
		for (const [token, name] of minted) out = out.split(token).join(name);
		return out;
	};
	const upload = new Map<string, string>();
	const { modules: _modules, _attachments, ...own } = app;
	upload.set(
		APP,
		scrub(
			JSON.stringify({
				...own,
				_attachments: Object.keys(_attachments).filter(
					(path) => !path.endsWith(".xml"),
				),
			}),
		),
	);
	app.modules.forEach((module, m) => {
		const placed = layout[m];
		if (placed === undefined) return;
		const { forms, ...rest } = module;
		upload.set(placed.uuid, scrub(JSON.stringify(rest)));
		forms.forEach((form, f) => {
			const uuid = placed.forms[f];
			if (uuid === undefined) return;
			const source = app._attachments[`${form.unique_id}.xml`];
			upload.set(
				uuid,
				scrub(JSON.stringify(form)) +
					scrub(typeof source === "string" ? source : ""),
			);
		});
	});
	const archive = compileCcz(app, doc.appName, doc, {
		assets,
		...(lookup !== undefined &&
			naming !== undefined && {
				lookup: {
					naming,
					fixtures: buildLookupFixtures(naming, lookup.rowsByTable),
				},
			}),
	});
	return { upload, local: localWire(archive, layout, scrub), layout };
}

/**
 * Whether every module and form both layouts hold sits at the same
 * position in each, so the archive's positional ids (`m<i>`, `m<i>-f<j>`)
 * name the same entity on both sides.
 */
function positionsKept(
	before: readonly WireModule[],
	after: readonly WireModule[],
): boolean {
	const places = (layout: readonly WireModule[]) =>
		new Map(
			layout.flatMap((module, m) => [
				[module.uuid, `${m}`] as const,
				...module.forms.map((form, f) => [form, `${m}.${f}`] as const),
			]),
		);
	const was = places(before);
	const now = places(after);
	return [...was].every(
		([uuid, place]) => !now.has(uuid) || now.get(uuid) === place,
	);
}

/**
 * Every module and form whose upload wire, or whose local wire where
 * positions are kept, differs between `before` and `after`; and whether
 * the app's own part does, and whether the local wire was compared.
 */
function changedWire(before: Wire, after: Wire) {
	const changed = new Set<string>();
	for (const [uuid, wire] of before.upload) {
		if (uuid === APP) continue;
		const now = after.upload.get(uuid);
		if (now !== undefined && now !== wire) changed.add(uuid);
	}
	const localCompared = positionsKept(before.layout, after.layout);
	if (localCompared) {
		for (const [uuid, wire] of before.local) {
			const now = after.local.get(uuid);
			if (now !== undefined && now !== wire) changed.add(uuid);
		}
	}
	return {
		changed,
		app: before.upload.get(APP) !== after.upload.get(APP),
		localCompared,
	};
}

/** The batches the corpus draws over these fixed documents, at the corpus's seed. */
function fixedEditCorpus(documents: readonly CorpusDocument[]): {
	readonly outcomes: readonly EditBatchOutcome[];
	readonly census: EditCensus;
} {
	return editBatchCorpus(
		{
			fixed: documents.map((document) => ({
				id: document.id,
				doc: document.doc,
				...(document.lookup !== undefined && { lookup: document.lookup }),
			})),
			sampled: [],
		},
		DEFAULT_CORPUS_SEED,
	);
}

let producers: CorpusDocument[] = [];

beforeAll(() => {
	producers = producerDocuments();
});

describe("the corpus's fixed sources", () => {
	/** The producers' documents Nova's publish takes: the emitter edits only those. */
	let publishable: CorpusDocument[] = [];
	/** Those, and the workforce documents built over the producers. */
	let fixed: CorpusDocument[] = [];
	let outcomes: readonly EditBatchOutcome[];
	let census: EditCensus;

	// One edit-batch corpus over about 160 documents, which every test here reads.
	beforeAll(() => {
		publishable = producers.filter(
			(document) =>
				publishFindings(
					hydratePersistedBlueprint(blueprintDocSchema.parse(document.doc)),
					document.lookup,
				).length === 0,
		);
		fixed = [...publishable, ...workforceDocuments(producers)];
		({ outcomes, census } = fixedEditCorpus(fixed));
	});

	it("give every mutation kind the reducer defines a batch", () => {
		expect(
			censusFloorFailures(census),
			`Kinds no fixed document carries a batch of:\n${formatCensus(census)}`,
		).toEqual([]);
	});

	// A second edit-batch corpus over about 150 documents: a few seconds on
	// a laptop, and CI runners are slower.
	it("give no batch to exactly the five removal kinds whose only targets the workforce documents hold, without those documents", {
		timeout: 30_000,
	}, () => {
		const without = fixedEditCorpus(publishable);
		expect(
			censusFloorFailures(without.census)
				.map((failure) => failure.kind)
				.sort(),
		).toEqual([
			"removeAutomation",
			"removeLocationProperty",
			"removePersona",
			"removeUserProperty",
			"removeUserType",
		]);
	});

	it("hold in each batch's footprint every module and form whose wire the batch changes, on the upload and in the local archive", {
		// Two expansions and two archives per batch, over about 160 documents.
		timeout: 60_000,
	}, () => {
		const byId = new Map(fixed.map((document) => [document.id, document]));
		const escaped: string[] = [];
		let changed = 0;
		let appChanged = 0;
		let localCompared = 0;
		for (const outcome of outcomes) {
			const batch = outcome.batch;
			const document = byId.get(outcome.documentId);
			if (batch === undefined || document === undefined) continue;
			const before = hydratePersistedBlueprint(
				blueprintDocSchema.parse(document.doc),
			);
			const footprint = batchFootprint(
				before,
				batch.nextDoc,
				batch.mutations,
				document.lookup,
			);
			const inside = new Set([
				...footprint.entities,
				...footprint.modules,
				...footprint.forms,
			]);
			const diff = changedWire(
				wireOf(before, document.lookup),
				wireOf(batch.nextDoc, document.lookup),
			);
			if (diff.localCompared) localCompared += 1;
			if (diff.app) {
				appChanged += 1;
				if (!footprint.app) {
					escaped.push(
						`${outcome.documentId} (${batch.kinds.join(", ")}) changed the app's own wire, and its footprint says the app is untouched`,
					);
				}
			}
			for (const uuid of diff.changed) {
				changed += 1;
				if (!inside.has(uuid)) {
					escaped.push(
						`${outcome.documentId} (${batch.kinds.join(", ")}) changed ${uuid} outside its footprint`,
					);
				}
			}
		}
		expect(escaped).toEqual([]);
		// The edits did change wire, so the checks above compared something.
		expect(changed).toBeGreaterThan(50);
		expect(appChanged).toBeGreaterThan(5);
		expect(localCompared).toBeGreaterThan(outcomes.length / 2);
	});
});

describe("an edit batch's footprint", () => {
	it("reaches the readers of what a batch names, where only they change", () => {
		const byId = new Map(producers.map((d) => [d.id, d]));
		const hydrated = (id: string) => {
			const document = byId.get(id);
			if (document === undefined)
				throw new Error(`No producer document ${id}.`);
			return hydratePersistedBlueprint(blueprintDocSchema.parse(document.doc));
		};
		const worker = hydrated("worker-is_supervisor");
		const [property] = worker.userPropertyOrder ?? [];
		const caseList = hydrated("case-list-local");
		const weight = caseList.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((entry) => entry.name === "weight");
		if (property === undefined || weight === undefined) {
			throw new Error(
				"The worker and case list fixtures lost the property each reads.",
			);
		}
		const cases: {
			name: string;
			doc: BlueprintDoc;
			mutations: Mutation[];
			onlyThroughReaders: boolean;
		}[] = [
			{
				// The module's display condition and a question's relevance read the property by slug.
				name: "a worker property's slug",
				doc: worker,
				mutations: [
					{
						kind: "updateUserProperty",
						uuid: property,
						patch: { slug: "renamed_property" },
					},
				],
				onlyThroughReaders: true,
			},
			{
				// The case list sorts on the property by its type.
				name: "a sorted case property's type",
				doc: caseList,
				mutations: [
					{
						kind: "setCaseProperty",
						caseType: "patient",
						property: { ...weight, data_type: "int" },
					},
				],
				onlyThroughReaders: true,
			},
			{
				name: "a case property's name",
				doc: caseList,
				mutations: [
					{
						kind: "renameCaseProperties",
						renames: [{ caseType: "patient", from: "phone", to: "telephone" }],
					},
				],
				onlyThroughReaders: false,
			},
		];
		for (const { name, doc, mutations, onlyThroughReaders } of cases) {
			const verdict = mutationCommitVerdict(
				doc,
				mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!verdict.ok) {
				throw new Error(
					`The commit gate refused the edit of ${name}: ${verdict.findings.map((f) => f.code).join(", ")}.`,
				);
			}
			const footprint = batchFootprint(doc, verdict.nextDoc, verdict.mutations);
			const inside = new Set([
				...footprint.entities,
				...footprint.modules,
				...footprint.forms,
			]);
			const named = new Set<string>(uuidTokensOf(verdict.mutations));
			const changed = [
				...changedWire(
					wireOf(doc, undefined),
					wireOf(verdict.nextDoc, undefined),
				).changed,
			];
			expect(changed.length, name).toBeGreaterThan(0);
			expect(
				changed.filter((uuid) => !inside.has(uuid)),
				name,
			).toEqual([]);
			if (onlyThroughReaders) {
				// Nothing the batch names is among what changed: only its readers carry it there.
				expect(
					changed.filter((uuid) => named.has(uuid)),
					name,
				).toEqual([]);
			}
		}
	});
});

describe("the footprint's derivations", () => {
	interface Derivation {
		readonly name: string;
		readonly document: string;
		/** Edits that make D from the fixture, where the derivation needs a setting the fixture lacks. */
		readonly setup?: (doc: BlueprintDoc) => Mutation[];
		readonly batch: (doc: BlueprintDoc) => Mutation[];
		/** The forms Nova rewrites from the edit: each changes, and the footprint holds it. */
		readonly reaches: (doc: BlueprintDoc) => readonly Uuid[];
		/** The forms the edit leaves alone: each keeps its wire, and the footprint leaves it out. */
		readonly leaves: (doc: BlueprintDoc) => readonly Uuid[];
		/** Whether the edit reaches the app's own record, where the case says. */
		readonly app?: boolean;
	}

	const moduleNamed = (doc: BlueprintDoc, name: string): Uuid => {
		const uuid = doc.moduleOrder.find((m) => doc.modules[m]?.name === name);
		if (uuid === undefined) throw new Error(`No module named ${name}.`);
		return uuid;
	};
	const formsOf = (doc: BlueprintDoc, name: string): Uuid[] => [
		...(doc.formOrder[moduleNamed(doc, name)] ?? []),
	];
	const admit = (doc: BlueprintDoc, mutations: Mutation[]) => {
		const verdict = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) {
			throw new Error(
				`The commit gate refused the edit: ${verdict.findings.map((f) => f.code).join(", ")}.`,
			);
		}
		return verdict;
	};
	const flag = asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f607");
	const readsFlag = {
		kind: "eq",
		left: {
			kind: "term",
			term: { kind: "session-user-property", userPropertyUuid: flag },
		},
		right: { kind: "term", term: { kind: "literal", value: "y" } },
	} as const;
	const addFlag: Mutation = {
		kind: "addUserProperty",
		property: { uuid: flag, slug: "has_flag", label: "Has flag" },
	};
	const renameFlag: Mutation[] = [
		{ kind: "updateUserProperty", uuid: flag, patch: { slug: "flag_renamed" } },
	];
	/** A condition that reads nothing at run time: it reaches no instance. */
	const literalOnly = {
		kind: "eq",
		left: { kind: "term", term: { kind: "literal", value: "on" } },
		right: { kind: "term", term: { kind: "literal", value: "on" } },
	} as const;
	/** The search module's case search, with its search button shown under `condition`. */
	const searchButton =
		(module: string, condition: typeof readsFlag | typeof literalOnly) =>
		(doc: BlueprintDoc): Mutation[] => {
			const uuid = moduleNamed(doc, module);
			const current = doc.modules[uuid];
			const search =
				current === undefined ? undefined : effectiveCaseSearchConfig(current);
			if (current === undefined || search === undefined) {
				throw new Error(`${module} has no case search.`);
			}
			return caseSearchConfigPatchMutations(uuid, current.caseSearchConfig, {
				...search,
				searchButtonDisplayCondition: condition,
			});
		};
	const otherFlag = asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f609");
	const addOtherFlag: Mutation = {
		kind: "addUserProperty",
		property: { uuid: otherFlag, slug: "has_other_flag", label: "Other flag" },
	};
	const calculatedColumn = asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f608");
	/** A calculated column, placed on the tile, that shows one worker property. */
	const flagColumn = (property: Uuid) =>
		({
			uuid: calculatedColumn,
			kind: "calculated",
			header: "Flag",
			expression: {
				kind: "term",
				term: { kind: "session-user-property", userPropertyUuid: property },
			},
			tile: { x: 0, y: 2, width: 4, height: 1 },
		}) as const;
	/** A calculated column on `module`'s case list that shows the worker's flag. */
	const addFlagColumn =
		(module: string) =>
		(doc: BlueprintDoc): Mutation[] => [
			{
				kind: "addColumn",
				moduleUuid: moduleNamed(doc, module),
				column: flagColumn(flag),
				afterInList: null,
				afterInDetail: null,
			},
		];
	const columnsOf = (doc: BlueprintDoc, module: string) =>
		doc.modules[moduleNamed(doc, module)]?.caseListConfig?.columns ?? [];
	/** Hide `module`'s columns named by `which` from its detail. */
	const hideInDetail =
		(module: string, which: (header: string) => boolean) =>
		(doc: BlueprintDoc): Mutation[] =>
			columnsOf(doc, module)
				.filter(
					(column) =>
						column.visibleInDetail !== false &&
						"header" in column &&
						which(column.header),
				)
				.map((column) => ({
					kind: "updateColumn",
					moduleUuid: moduleNamed(doc, module),
					uuid: column.uuid,
					visibilityPatch: { surface: "detail", visible: false },
				}));
	/** The one module of a nested-menu app that is nested under no other. */
	const rootModule = (doc: BlueprintDoc): Uuid => {
		const roots = doc.moduleOrder.filter(
			(uuid) => doc.modules[uuid]?.parentModuleUuid === undefined,
		);
		const [root] = roots;
		if (root === undefined || roots.length !== 1) {
			throw new Error(`Expected one root module, found ${roots.length}.`);
		}
		return root;
	};
	const formOfType = (
		doc: BlueprintDoc,
		module: string,
		type: string,
	): Uuid[] => formsOf(doc, module).filter((f) => doc.forms[f]?.type === type);
	/** Rename `module`'s search input `name`. */
	const renameInput =
		(module: string, name: string) =>
		(doc: BlueprintDoc): Mutation[] => {
			const moduleUuid = moduleNamed(doc, module);
			const input = doc.modules[moduleUuid]?.caseListConfig?.searchInputs.find(
				(entry) => entry.name === name,
			);
			if (input === undefined) {
				throw new Error(`${module} has no search input ${name}.`);
			}
			const { uuid, ...content } = input;
			return [
				{
					kind: "updateSearchInput",
					moduleUuid,
					uuid,
					searchInput: { ...content, name: `${name}_renamed` },
				},
			];
		};
	/** Turn on `module`'s case search, with nothing else set. */
	const enableSearch =
		(module: string) =>
		(doc: BlueprintDoc): Mutation[] => {
			const uuid = moduleNamed(doc, module);
			return caseSearchConfigPatchMutations(
				uuid,
				doc.modules[uuid]?.caseSearchConfig,
				{},
			);
		};

	/** A filter on `caseType`'s `property` equal to `value`: it reaches the case database alone. */
	const literalFilter = (caseType: string, property: string, value: string) =>
		({
			kind: "eq",
			left: { kind: "term", term: { kind: "prop", caseType, property } },
			right: { kind: "term", term: { kind: "literal", value } },
		}) as const;
	/** Set `module`'s case list filter. */
	const setFilter =
		(
			module: string,
			filter: typeof readsFlag | ReturnType<typeof literalFilter>,
		) =>
		(doc: BlueprintDoc): Mutation[] => [
			{
				kind: "setCaseListMeta",
				uuid: moduleNamed(doc, module),
				patch: { filter },
			},
		];
	/** `module`'s case search with `patch` over its effective configuration. */
	const patchSearch =
		(module: string, patch: Record<string, unknown>) =>
		(doc: BlueprintDoc): Mutation[] => {
			const uuid = moduleNamed(doc, module);
			const current = doc.modules[uuid];
			const search =
				current === undefined ? undefined : effectiveCaseSearchConfig(current);
			if (current === undefined || search === undefined) {
				throw new Error(`${module} has no case search.`);
			}
			return caseSearchConfigPatchMutations(uuid, current.caseSearchConfig, {
				...search,
				...patch,
			});
		};
	/** Exclude the owners a worker-record field names from `module`'s cases. */
	const excludeOwners =
		(module: string, field: string) =>
		(doc: BlueprintDoc): Mutation[] => {
			const uuid = moduleNamed(doc, module);
			return caseSearchConfigPatchMutations(
				uuid,
				doc.modules[uuid]?.caseSearchConfig,
				{
					searchActionEnabled: false,
					excludedOwnerIds: {
						kind: "term",
						term: { kind: "session-user", field },
					},
				},
			);
		};
	/** An after-submit link from `source` to `target`, a form of `module`. */
	const linkTo = (source: Uuid, module: Uuid, target: Uuid): Mutation => ({
		kind: "addFormLink",
		formUuid: source,
		link: {
			uuid: asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f60c"),
			target: { type: "form", moduleUuid: module, formUuid: target },
		},
	});
	/** A new form of `type` after `module`'s others, and its uuid. */
	const addForm = (doc: BlueprintDoc, module: string, type: FormType) => {
		const added = formScaffoldMutations(doc, moduleNamed(doc, module), type);
		if (added === null) throw new Error(`No form scaffold for ${module}.`);
		return added;
	};
	/** A survey form added after `module`'s others. */
	const addSurvey =
		(module: string) =>
		(doc: BlueprintDoc): Mutation[] =>
			addForm(doc, module, "survey").mutations;
	/** A link from `from`'s first form to the first form of `to`, a module nested under it. */
	const linkToNested = (doc: BlueprintDoc, from: string, to: string) => {
		const [source] = formsOf(doc, from);
		const [target] = formsOf(doc, to);
		if (source === undefined || target === undefined) {
			throw new Error(`${from} or ${to} holds no form.`);
		}
		return linkTo(source, moduleNamed(doc, to), target);
	};
	/** A question on `module`'s form at `index` that writes the worker's flag to the worker's record. */
	const writeFlagOn =
		(module: string, index: number) =>
		(doc: BlueprintDoc): Mutation[] => {
			const form = formsOf(doc, module)[index];
			if (form === undefined)
				throw new Error(`${module} has no form ${index}.`);
			return [
				{
					kind: "addField",
					parentUuid: form,
					field: {
						uuid: asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f60b"),
						id: "worker_flag",
						kind: "text",
						label: proseText("Worker flag"),
						caseWrite: { caseType: "commcare-user", property: "has_flag" },
					},
				},
			];
		};
	/** The question that names the child case `module`'s first form creates. */
	const childNamer = (doc: BlueprintDoc, module: string): Uuid => {
		const [form] = formsOf(doc, module);
		const namer = Object.values(doc.fields).find(
			(field) =>
				"caseWrite" in field &&
				field.caseWrite?.property === "case_name" &&
				field.caseWrite.caseType !==
					doc.modules[moduleNamed(doc, module)]?.caseType &&
				doc.fieldParent?.[field.uuid] === form,
		);
		if (namer === undefined) {
			throw new Error(`${module}'s first form names no child case.`);
		}
		return namer.uuid;
	};
	/** Set a search-first module's first search input's default to the worker's flag. */
	const flagDefault =
		(module: string) =>
		(doc: BlueprintDoc): Mutation[] => {
			const uuid = moduleNamed(doc, module);
			const input = doc.modules[uuid]?.caseListConfig?.searchInputs[0];
			if (input === undefined || input.kind === "hidden") {
				throw new Error(`${module} has no visible search input.`);
			}
			const { uuid: inputUuid, ...content } = input;
			return [
				{
					kind: "updateSearchInput",
					moduleUuid: uuid,
					uuid: inputUuid,
					searchInput: {
						...content,
						default: {
							kind: "term",
							term: { kind: "session-user-property", userPropertyUuid: flag },
						},
					},
				} as Mutation,
			];
		};

	/**
	 * Clear the display conditions of `module`'s forms: a form that reads its
	 * case to decide whether it shows needs its module to select the case
	 * before any form, which a registration form beside it ends.
	 */
	const showFormsAlways = (doc: BlueprintDoc, module: string): Mutation[] =>
		formsOf(doc, module).map((form) => ({
			kind: "updateForm",
			uuid: form,
			patch: { displayCondition: null },
		}));
	/** An XPath expression that is one literal. */
	const literalXPath = (text: string) => ({
		parts: [{ kind: "text" as const, text }],
	});
	/** Declare `to`, a case type with `from`'s properties. */
	const copyCaseType = (
		doc: BlueprintDoc,
		from: string,
		to: string,
	): Mutation[] => {
		const source = doc.caseTypes?.find((type) => type.name === from);
		if (source === undefined) throw new Error(`No case type ${from}.`);
		return [
			{ kind: "declareCaseType", caseType: to },
			...source.properties.map(
				(property): Mutation => ({
					kind: "addCaseProperty",
					caseType: to,
					property,
				}),
			),
		];
	};
	/** The text question that names the case `form` registers. */
	const caseNamer = (doc: BlueprintDoc, form: Uuid | undefined): Uuid => {
		const namer = Object.values(doc.fields).find(
			(field) =>
				field.kind === "text" &&
				field.caseWrite?.property === "case_name" &&
				doc.fieldParent?.[field.uuid] === form,
		);
		if (namer === undefined) throw new Error("The form names no case.");
		return namer.uuid;
	};
	const cases: Derivation[] = [
		// What names a module's case selection: its case-loading forms and those of the modules selecting under it.
		{
			name: "a module's case selection reaches its forms",
			document: "case-operation-relation",
			batch: (doc) => [
				{
					kind: "setCaseListMeta",
					uuid: moduleNamed(doc, "Patients"),
					patch: { selection: { kind: "multiple", maximum: 10 } },
				},
			],
			reaches: (doc) => formsOf(doc, "Patients"),
			leaves: () => [],
			app: false,
		},
		{
			name: "a module's case selection reaches none of its forms that load no case",
			document: "tile",
			batch: (doc) => [
				{
					kind: "setCaseListMeta",
					uuid: moduleNamed(doc, "Visits"),
					patch: { selection: { kind: "multiple", maximum: 4 } },
				},
			],
			reaches: (doc) => formOfType(doc, "Visits", "followup"),
			leaves: (doc) => formOfType(doc, "Visits", "registration"),
		},
		{
			name: "a module's name reaches none of its forms",
			document: "case-operation-relation",
			batch: (doc) => [
				{
					kind: "renameModule",
					uuid: moduleNamed(doc, "Patients"),
					newId: "Patients and visits",
				},
			],
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Patients"),
			app: false,
		},
		{
			name: "a module's case type reaches its forms",
			document: "search-remote",
			setup: (doc) => copyCaseType(doc, "patient", "client"),
			batch: (doc) => [
				{
					kind: "updateModule",
					uuid: moduleNamed(doc, "Followup"),
					patch: { caseType: "client" },
				},
			],
			reaches: (doc) => formsOf(doc, "Followup"),
			leaves: () => [],
		},
		{
			name: "a module's case type reaches none of its survey forms",
			document: "tile",
			setup: (doc) => [
				...copyCaseType(doc, "visit", "stop"),
				...addSurvey("Visits")(doc),
			],
			batch: (doc) => [
				{
					kind: "updateModule",
					uuid: moduleNamed(doc, "Visits"),
					patch: { caseType: "stop" },
				},
				{
					kind: "updateField",
					uuid: caseNamer(doc, formOfType(doc, "Visits", "registration")[0]),
					targetKind: "text",
					patch: { caseWrite: { caseType: "stop", property: "case_name" } },
				},
			],
			reaches: (doc) => [
				...formOfType(doc, "Visits", "followup"),
				...formOfType(doc, "Visits", "registration"),
			],
			leaves: (doc) => formOfType(doc, "Visits", "survey"),
		},
		{
			name: "a module's selection under another module reaches its case-loading forms, and not its registration form",
			document: "nested-menu-parent",
			setup: (doc) => [
				...showFormsAlways(doc, "Child care"),
				...addForm(doc, "Child care", "registration").mutations,
			],
			batch: (doc) => [
				{
					kind: "updateModule",
					uuid: moduleNamed(doc, "Child care"),
					patch: { parentCaseModuleUuid: null },
				},
			],
			reaches: (doc) => formOfType(doc, "Child care", "followup"),
			leaves: (doc) => formOfType(doc, "Child care", "registration"),
		},
		{
			name: "a module's selection under another module reaches its forms, and none of that module's",
			document: "search-parent",
			batch: (doc) => [
				{
					kind: "updateModule",
					uuid: moduleNamed(doc, "Followup"),
					patch: { parentCaseModuleUuid: null },
				},
			],
			reaches: (doc) => formsOf(doc, "Followup"),
			leaves: (doc) => formsOf(doc, "Followup2"),
		},
		{
			name: "a module's case selection reaches the forms of a module that selects its cases under it",
			document: "search-parent",
			batch: (doc) => [
				{
					kind: "setCaseListMeta",
					uuid: moduleNamed(doc, "Followup2"),
					patch: { selection: { kind: "multiple", maximum: 5 } },
				},
			],
			reaches: (doc) => [
				...formsOf(doc, "Followup"),
				...formsOf(doc, "Followup2"),
			],
			leaves: () => [],
		},
		// What else the selection datum holds: the same forms, and no frame.
		{
			name: "a module's opening on Search reaches its forms",
			document: "search-remote",
			batch: patchSearch("Followup", { searchFirst: true }),
			reaches: (doc) => formsOf(doc, "Followup"),
			leaves: () => [],
		},
		{
			name: "a case list filter that reaches the case database alone reaches none of its module's forms that load no case",
			document: "tile",
			setup: setFilter("Visits", literalFilter("visit", "village", "north")),
			batch: setFilter("Visits", literalFilter("visit", "village", "south")),
			reaches: (doc) => formOfType(doc, "Visits", "followup"),
			leaves: (doc) => formOfType(doc, "Visits", "registration"),
		},
		{
			name: "a case list filter that reads the worker reaches every form of its module, whose entries declare the session",
			document: "tile",
			setup: () => [addFlag],
			batch: setFilter("Visits", readsFlag),
			reaches: (doc) => formsOf(doc, "Visits"),
			leaves: () => [],
		},
		{
			name: "a module's owner exclusion reaches every form of its module, whose entries declare the session",
			document: "tile",
			batch: excludeOwners("Visits", "excluded_owners"),
			reaches: (doc) => formsOf(doc, "Visits"),
			leaves: () => [],
		},
		{
			name: "an owner exclusion that reads another worker field reaches none of its module's forms that load no case",
			document: "tile",
			setup: excludeOwners("Visits", "excluded_owners"),
			batch: excludeOwners("Visits", "blocked_owners"),
			reaches: (doc) => formOfType(doc, "Visits", "followup"),
			leaves: (doc) => formOfType(doc, "Visits", "registration"),
		},
		{
			name: "a module's tile kept on screen reaches its case-loading forms, and not its registration form",
			document: "tile",
			batch: (doc) => [
				{
					kind: "setCaseListMeta",
					uuid: moduleNamed(doc, "Visits"),
					patch: { tile: { persistOnForms: true } },
				},
			],
			reaches: (doc) => formOfType(doc, "Visits", "followup"),
			leaves: (doc) => formOfType(doc, "Visits", "registration"),
		},
		{
			name: "a parent module's case list filter reaches the forms of the module nested under it",
			document: "nested-menu-parent",
			batch: setFilter(
				"Parents",
				literalFilter("gold-fish", "care_status", "active"),
			),
			reaches: (doc) => formsOf(doc, "Child care"),
			leaves: () => [],
		},
		{
			name: "a case list filter reaches none of the forms whose links open a form of a module that selects its cases under it",
			document: "nested-menu-parent",
			setup: (doc) => {
				const registration = addForm(doc, "Parents", "registration");
				const [target] = formsOf(doc, "Child care");
				if (target === undefined) throw new Error("Child care holds no form.");
				return [
					...setFilter(
						"Parents",
						literalFilter("gold-fish", "care_status", "active"),
					)(doc),
					...showFormsAlways(doc, "Parents"),
					...registration.mutations,
					{
						kind: "addFormLink",
						formUuid: registration.formUuid,
						link: {
							uuid: asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f610"),
							target: {
								type: "form",
								moduleUuid: moduleNamed(doc, "Child care"),
								formUuid: target,
							},
							// The registration creates the parent alone, so the
							// link names the child it opens.
							datums: [
								{ name: "case_id", xpath: literalXPath("'a-parent'") },
								{ name: "case_id_guppy", xpath: literalXPath("'a-child'") },
							],
						},
					},
				];
			},
			batch: setFilter(
				"Parents",
				literalFilter("gold-fish", "care_status", "paused"),
			),
			reaches: (doc) => [
				...formOfType(doc, "Parents", "followup"),
				...formsOf(doc, "Child care"),
			],
			leaves: (doc) => formOfType(doc, "Parents", "registration"),
		},
		{
			name: "a module's case list filter reaches the forms of a module that selects its cases under it",
			document: "search-parent",
			batch: setFilter(
				"Followup2",
				literalFilter("parent_case", "case_name", "active"),
			),
			reaches: (doc) => [
				...formsOf(doc, "Followup"),
				...formsOf(doc, "Followup2"),
			],
			leaves: () => [],
		},
		{
			name: "a menu's case list filter reaches none of the forms of the module nested under it, which keeps its own selection",
			document: "nested-menu-same",
			batch: (doc) => {
				const root = rootModule(doc);
				const caseType = doc.modules[root]?.caseType;
				if (caseType === undefined)
					throw new Error("The root has no case type.");
				return [
					{
						kind: "setCaseListMeta",
						uuid: root,
						patch: {
							filter: literalFilter(caseType, "care_status", "active"),
						},
					},
				];
			},
			reaches: (doc) => [...(doc.formOrder[rootModule(doc)] ?? [])],
			leaves: (doc) => formsOf(doc, "Child care"),
		},
		{
			name: "a menu's owner exclusion reaches none of the forms of the module nested under it",
			document: "nested-menu-different",
			batch: excludeOwners("Parents", "excluded_owners"),
			reaches: (doc) => formsOf(doc, "Parents"),
			leaves: (doc) => formsOf(doc, "Child care"),
		},
		{
			name: "a worker property's slug reaches the forms of a module whose case list filter reads it",
			document: "nested-menu-different",
			setup: (doc) => [addFlag, ...setFilter("Child care", readsFlag)(doc)],
			batch: () => renameFlag,
			reaches: (doc) => formsOf(doc, "Child care"),
			leaves: () => [],
		},
		{
			name: "a worker property's slug reaches none of the forms of a module whose display condition reads it",
			document: "nested-menu-different",
			setup: (doc) => [
				addFlag,
				{
					kind: "updateModule",
					uuid: moduleNamed(doc, "Child care"),
					patch: { displayCondition: readsFlag },
				},
			],
			batch: () => renameFlag,
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Child care"),
		},
		// The inline search of a module that opens on Search: its own forms, all case-loading.
		{
			name: "a search input's name reaches the forms of a module that opens on Search",
			document: "search-inline",
			batch: renameInput("Followup", "first_name"),
			reaches: (doc) => formsOf(doc, "Followup"),
			leaves: () => [],
		},
		{
			name: "a search input's label reaches none of the forms of a module that opens on Search",
			document: "search-inline",
			batch: (doc) => {
				const moduleUuid = moduleNamed(doc, "Followup");
				const input = doc.modules[moduleUuid]?.caseListConfig?.searchInputs[0];
				if (input === undefined)
					throw new Error("Followup has no search input.");
				const { uuid, ...content } = input;
				return [
					{
						kind: "updateSearchInput",
						moduleUuid,
						uuid,
						searchInput: { ...content, label: "Given name" },
					},
				];
			},
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Followup"),
		},
		{
			name: "a search screen subtitle reaches the forms of a module that opens on Search",
			document: "search-inline",
			batch: patchSearch("Followup", {
				searchScreenSubtitle: "Look up a patient",
			}),
			reaches: (doc) => formsOf(doc, "Followup"),
			leaves: () => [],
		},
		{
			name: "a search screen title reaches none of the forms of a module that opens on Search",
			document: "search-inline",
			batch: patchSearch("Followup", { searchScreenTitle: "Find a patient" }),
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Followup"),
		},
		{
			name: "a calculated column that stops reading a related case reaches the forms of a module that opens on Search",
			document: "case-list-inline",
			batch: (doc) => {
				const column = columnsOf(doc, "Patients & visits").find(
					(entry) => "header" in entry && entry.header === "Household rank",
				);
				if (column === undefined || column.kind !== "calculated") {
					throw new Error("The inline search fixture lost its related column.");
				}
				const {
					uuid,
					tile: _tile,
					sort: _sort,
					visibleInList: _list,
					visibleInDetail: _detail,
					...content
				} = column;
				return [
					{
						kind: "updateColumn",
						moduleUuid: moduleNamed(doc, "Patients & visits"),
						uuid,
						column: {
							...content,
							expression: {
								kind: "term",
								term: { kind: "prop", caseType: "patient", property: "weight" },
							},
						},
					},
				];
			},
			reaches: (doc) => formsOf(doc, "Patients & visits"),
			leaves: () => [],
		},
		{
			name: "one column leaving the detail of a module that opens on Search reaches none of its forms",
			document: "case-list-inline",
			batch: hideInDetail("Patients & visits", (header) => header === "Born"),
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Patients & visits"),
		},
		{
			name: "one column leaving the list of a module that opens on Search reaches none of its forms",
			document: "case-list-inline",
			batch: (doc) =>
				columnsOf(doc, "Patients & visits")
					.filter((column) => "header" in column && column.header === "Born")
					.map((column) => ({
						kind: "updateColumn",
						moduleUuid: moduleNamed(doc, "Patients & visits"),
						uuid: column.uuid,
						visibilityPatch: { surface: "list", visible: false },
					})),
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Patients & visits"),
		},
		{
			name: "a worker property's slug reaches the forms of a module that opens on Search whose search input default reads it",
			document: "search-remote",
			setup: (doc) => [
				addFlag,
				...patchSearch("Followup", { searchFirst: true })(doc),
				...flagDefault("Followup")(doc),
			],
			batch: () => renameFlag,
			reaches: (doc) => formsOf(doc, "Followup"),
			leaves: () => [],
		},
		{
			name: "a worker property's slug reaches none of the forms of a module that opens on its list whose search input default reads it",
			document: "search-remote",
			setup: (doc) => [addFlag, ...flagDefault("Followup")(doc)],
			batch: () => renameFlag,
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Followup"),
		},
		{
			name: "a search input's name reaches none of the forms of a module whose case list filter reads it, which opens on its list",
			document: "prompt-guards",
			batch: (doc) => {
				const filter =
					doc.modules[moduleNamed(doc, "Followup")]?.caseListConfig?.filter;
				const read = doc.modules[
					moduleNamed(doc, "Followup")
				]?.caseListConfig?.searchInputs.find((input) =>
					JSON.stringify(filter).includes(input.uuid),
				);
				if (read === undefined) throw new Error("The filter reads no input.");
				return renameInput("Followup", read.name)(doc);
			},
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Followup"),
		},
		// What only the module's own case-loading entries hold.
		{
			name: "a module's detail screen going away reaches its case-loading forms, and not its registration form",
			document: "tile",
			batch: hideInDetail("Visits", () => true),
			reaches: (doc) => formOfType(doc, "Visits", "followup"),
			leaves: (doc) => formOfType(doc, "Visits", "registration"),
		},
		{
			name: "one column leaving a detail that keeps others reaches none of its module's forms",
			document: "tile",
			batch: hideInDetail("Visits", (header) => header === "Village"),
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Visits"),
		},
		{
			name: "a module's detail screen reaches none of the forms of a module that selects its cases under it",
			document: "search-parent",
			batch: hideInDetail("Followup2", () => true),
			reaches: (doc) => formsOf(doc, "Followup2"),
			leaves: (doc) => formsOf(doc, "Followup"),
		},
		{
			name: "a module's tile grouping reaches its case-loading forms, and not its registration form",
			document: "tile-grouped-two",
			batch: (doc) => [
				{
					kind: "setCaseListMeta",
					uuid: moduleNamed(doc, "Visits"),
					patch: { tile: {} },
				},
			],
			reaches: (doc) => formOfType(doc, "Visits", "followup"),
			leaves: (doc) => formOfType(doc, "Visits", "registration"),
		},
		{
			name: "a tile grouping's header rows reach none of its module's forms",
			document: "tile-grouped-two",
			setup: (doc) =>
				columnsOf(doc, "Visits")
					.filter(
						(column) =>
							"header" in column &&
							["Village", "Last visit"].includes(column.header),
					)
					.map((column) => ({
						kind: "updateColumn",
						moduleUuid: moduleNamed(doc, "Visits"),
						uuid: column.uuid,
						tilePatch: {
							...column.tile,
							x: column.tile?.x ?? 0,
							y: 3,
							width: 2,
							height: 1,
						},
					})),
			batch: (doc) => [
				{
					kind: "setCaseListMeta",
					uuid: moduleNamed(doc, "Visits"),
					patch: {
						tile: { grouping: { identifier: "parent", headerRows: 3 } },
					},
				},
			],
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Visits"),
		},
		{
			name: "a tile cell's placement reaches none of its module's forms",
			document: "tile",
			batch: (doc) => {
				const [first] = columnsOf(doc, "Visits");
				if (first === undefined) throw new Error("Visits has no column.");
				return [
					{
						kind: "updateColumn",
						moduleUuid: moduleNamed(doc, "Visits"),
						uuid: first.uuid,
						tilePatch: { x: 0, y: 0, width: 3, height: 1 },
					},
				];
			},
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Visits"),
		},
		// The instances every entry of the module declares.
		{
			name: "a search button condition that reads the worker reaches its module's forms",
			document: "tile",
			setup: (doc) => [addFlag, ...enableSearch("Visits")(doc)],
			batch: searchButton("Visits", readsFlag),
			reaches: (doc) => formsOf(doc, "Visits"),
			leaves: () => [],
		},
		{
			name: "a search button condition that reads nothing reaches none of its module's forms",
			document: "search-remote",
			batch: searchButton("Followup", literalOnly),
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Followup"),
		},
		{
			name: "a worker property's slug reaches none of the forms of a module whose search button condition reads it",
			document: "search-remote",
			setup: (doc) => [addFlag, ...searchButton("Followup", readsFlag)(doc)],
			batch: () => renameFlag,
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Followup"),
		},
		{
			name: "a calculated column that reads the worker reaches its module's forms",
			document: "tile",
			setup: () => [addFlag],
			batch: addFlagColumn("Visits"),
			reaches: (doc) => formsOf(doc, "Visits"),
			leaves: () => [],
		},
		{
			name: "a worker property's slug reaches none of the forms of a module whose calculated column reads it",
			document: "tile",
			setup: (doc) => [addFlag, ...addFlagColumn("Visits")(doc)],
			batch: () => renameFlag,
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Visits"),
		},
		{
			name: "a calculated column's expression reaches none of its module's forms where it reaches the same instances",
			document: "tile",
			setup: (doc) => [addFlag, addOtherFlag, ...addFlagColumn("Visits")(doc)],
			batch: (doc) => {
				const { uuid, tile, ...content } = flagColumn(otherFlag);
				return [
					{
						kind: "updateColumn",
						moduleUuid: moduleNamed(doc, "Visits"),
						uuid,
						column: content,
					},
				];
			},
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Visits"),
		},
		// Menus and the modules nested under them.
		{
			name: "a module's place under another menu reaches its forms, and none of that menu's",
			document: "nested-menu-different",
			batch: (doc) => [
				{
					kind: "moveModule",
					uuid: moduleNamed(doc, "Child care"),
					parentModuleUuid: null,
					after: moduleNamed(doc, "Parents"),
				},
			],
			reaches: (doc) => formsOf(doc, "Child care"),
			leaves: (doc) => formsOf(doc, "Parents"),
		},
		{
			name: "a module's place under a menu whose case it selects too reaches its forms",
			document: "nested-menu-same",
			batch: (doc) => [
				{
					kind: "moveModule",
					uuid: moduleNamed(doc, "Child care"),
					parentModuleUuid: null,
					after: moduleNamed(doc, "Parents"),
				},
			],
			reaches: (doc) => formsOf(doc, "Child care"),
			leaves: (doc) => formsOf(doc, "Parents"),
		},
		{
			name: "a menu's case selection reaches the nested module's case-loading form through the datum it aligns with alone",
			document: "nested-menu-different",
			setup: (doc) => [
				...addSurvey("Parents")(doc),
				...showFormsAlways(doc, "Child care"),
				...addForm(doc, "Child care", "registration").mutations,
			],
			batch: (doc) => [
				{
					kind: "setCaseListMeta",
					uuid: moduleNamed(doc, "Parents"),
					patch: { selection: { kind: "multiple", maximum: 5 } },
				},
			],
			reaches: (doc) => [
				...formOfType(doc, "Parents", "followup"),
				...formOfType(doc, "Child care", "followup"),
			],
			leaves: (doc) => [
				...formOfType(doc, "Parents", "survey"),
				...formOfType(doc, "Child care", "registration"),
			],
		},
		{
			name: "a menu's case selection reaches the forms of the module nested under it",
			document: "nested-menu-same",
			batch: (doc) => [
				{
					kind: "setCaseListMeta",
					uuid: rootModule(doc),
					patch: { selection: { kind: "multiple", maximum: 5 } },
				},
			],
			reaches: (doc) => [
				...formsOf(doc, "Child care"),
				...(doc.formOrder[rootModule(doc)] ?? []),
			],
			leaves: () => [],
		},
		{
			name: "a module's form list reaches its own forms' entries and those of the module nested under it",
			document: "nested-menu-previous",
			batch: addSurvey("Parents"),
			reaches: (doc) => [
				...formsOf(doc, "Parents"),
				...formsOf(doc, "Child care"),
			],
			leaves: () => [],
		},
		{
			name: "a form added beside a menu's forms that share no datum reaches none of their forms or the nested module's",
			document: "nested-menu-previous",
			setup: addSurvey("Parents"),
			batch: addSurvey("Parents"),
			reaches: () => [],
			leaves: (doc) => [
				...formsOf(doc, "Parents"),
				...formsOf(doc, "Child care"),
			],
		},
		{
			name: "a parent form's name reaches none of the nested module's forms",
			document: "nested-menu-previous",
			batch: (doc) => {
				const [form] = formsOf(doc, "Parents");
				if (form === undefined) throw new Error("Parents holds no form.");
				return [{ kind: "renameForm", uuid: form, newId: "Visit a parent" }];
			},
			reaches: () => [],
			leaves: (doc) => formsOf(doc, "Child care"),
		},
		{
			name: "a menu's first form turning from follow-up to close reaches none of the nested module's forms",
			document: "nested-menu-same",
			batch: (doc) => {
				const [form] = formsOf(doc, "Parents");
				if (form === undefined) throw new Error("Parents holds no form.");
				return [{ kind: "updateForm", uuid: form, patch: { type: "close" } }];
			},
			reaches: (doc) => formsOf(doc, "Parents"),
			leaves: (doc) => formsOf(doc, "Child care"),
		},
		{
			name: "a worker-record write on a menu's first form reaches the nested module's forms",
			document: "nested-menu-previous",
			setup: () => [addFlag],
			batch: writeFlagOn("Parents", 0),
			reaches: (doc) => [
				...formsOf(doc, "Parents"),
				...formsOf(doc, "Child care"),
			],
			leaves: () => [],
		},
		{
			name: "a worker-record write on the first of a menu's forms that share no datum reaches the nested module's forms",
			document: "nested-menu-previous",
			setup: (doc) => [addFlag, ...addSurvey("Parents")(doc)],
			batch: writeFlagOn("Parents", 0),
			reaches: (doc) => [
				...formsOf(doc, "Parents").slice(0, 1),
				...formsOf(doc, "Child care"),
			],
			leaves: () => [],
		},
		{
			name: "a worker-record write on a menu's first form reaches every form of the nested module, though neither module's forms share a datum",
			document: "nested-menu-same",
			setup: (doc) => [
				addFlag,
				...addSurvey("Parents")(doc),
				...showFormsAlways(doc, "Child care"),
				...addForm(doc, "Child care", "registration").mutations,
			],
			batch: writeFlagOn("Parents", 0),
			reaches: (doc) => [
				...formOfType(doc, "Parents", "followup"),
				...formsOf(doc, "Child care"),
			],
			leaves: (doc) => formOfType(doc, "Parents", "survey"),
		},
		{
			name: "a worker-record write on a menu's second form reaches none of the nested module's forms",
			document: "nested-menu-previous",
			setup: (doc) => [addFlag, ...addSurvey("Parents")(doc)],
			batch: writeFlagOn("Parents", 1),
			reaches: (doc) => formsOf(doc, "Parents").slice(1),
			leaves: (doc) => formsOf(doc, "Child care"),
		},
		{
			name: "a child case leaving a menu's first form reaches the nested module's forms",
			document: "nested-menu-previous",
			batch: (doc) => {
				const [form] = formsOf(doc, "Parents");
				if (form === undefined) throw new Error("Parents holds no form.");
				return [
					{
						kind: "addField",
						parentUuid: form,
						field: {
							uuid: asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f60f"),
							id: "visit_note",
							kind: "text",
							label: proseText("Visit note"),
						},
					},
					{ kind: "removeField", uuid: childNamer(doc, "Parents") },
				];
			},
			reaches: (doc) => [
				...formsOf(doc, "Parents"),
				...formsOf(doc, "Child care"),
			],
			leaves: () => [],
		},
		{
			name: "a child case moving into a repeat on a menu's first form reaches the nested module's forms",
			document: "nested-menu-previous",
			batch: (doc) => {
				const [form] = formsOf(doc, "Parents");
				if (form === undefined) throw new Error("Parents holds no form.");
				const repeat = asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f60d");
				return [
					{
						kind: "addField",
						parentUuid: form,
						field: {
							uuid: repeat,
							id: "fry",
							kind: "repeat",
							repeat_mode: "user_controlled",
							label: proseText("Fry"),
						},
					},
					{
						kind: "moveField",
						uuid: childNamer(doc, "Parents"),
						toParentUuid: repeat,
						after: null,
					},
				];
			},
			reaches: (doc) => [
				...formsOf(doc, "Parents"),
				...formsOf(doc, "Child care"),
			],
			leaves: () => [],
		},
		{
			name: "another property of a menu's first form's child case reaches none of the nested module's forms",
			document: "nested-menu-previous",
			batch: (doc) => {
				const [form] = formsOf(doc, "Parents");
				if (form === undefined) throw new Error("Parents holds no form.");
				return [
					{
						kind: "addField",
						parentUuid: form,
						field: {
							uuid: asUuid("0198a2c4-5d6e-7f80-8a91-b2c3d4e5f60e"),
							id: "child_status",
							kind: "text",
							label: proseText("Child status"),
							caseWrite: { caseType: "guppy", property: "care_status" },
						},
					},
				];
			},
			reaches: (doc) => formsOf(doc, "Parents"),
			leaves: (doc) => formsOf(doc, "Child care"),
		},
		{
			name: "a worker-record write on a menu's first form reaches the forms whose links open the nested module's forms",
			document: "nested-menu-same",
			setup: (doc) => {
				const second = addForm(doc, "Parents", "followup");
				const [target] = formsOf(doc, "Child care");
				if (target === undefined) throw new Error("Child care holds no form.");
				return [
					addFlag,
					...second.mutations,
					linkTo(second.formUuid, moduleNamed(doc, "Child care"), target),
				];
			},
			batch: writeFlagOn("Parents", 0),
			reaches: (doc) => [
				...formsOf(doc, "Parents"),
				...formsOf(doc, "Child care"),
			],
			leaves: () => [],
		},
		{
			name: "a worker property's slug reaches none of the forms whose links open a form of a module whose case list filter reads it",
			document: "nested-menu-same",
			setup: (doc) => [
				addFlag,
				...setFilter("Child care", readsFlag)(doc),
				linkToNested(doc, "Parents", "Child care"),
			],
			batch: () => renameFlag,
			reaches: (doc) => formsOf(doc, "Child care"),
			leaves: (doc) => formsOf(doc, "Parents"),
		},
		// The app's own record.
		{
			name: "a new language reaches the app's own record",
			document: "case-operation-relation",
			batch: () => [{ kind: "addLanguage", language: { language: "spa" } }],
			reaches: (doc) => formsOf(doc, "Patients"),
			leaves: () => [],
			app: true,
		},
	];

	it.each(cases)("$name", (derivation) => {
		const fixture = producers.find(
			(document) => document.id === derivation.document,
		);
		if (fixture === undefined) {
			throw new Error(`The producers emit no document ${derivation.document}.`);
		}
		const original = hydratePersistedBlueprint(
			blueprintDocSchema.parse(fixture.doc),
		);
		const before =
			derivation.setup === undefined
				? original
				: admit(original, derivation.setup(original)).nextDoc;
		const verdict = admit(before, derivation.batch(before));
		const footprint = batchFootprint(
			before,
			verdict.nextDoc,
			verdict.mutations,
			fixture.lookup,
		);
		const diff = changedWire(
			wireOf(before, fixture.lookup),
			wireOf(verdict.nextDoc, fixture.lookup),
		);
		expect(diff.localCompared).toBe(true);
		const inside = new Set([
			...footprint.entities,
			...footprint.modules,
			...footprint.forms,
		]);
		expect([...diff.changed].filter((uuid) => !inside.has(uuid))).toEqual([]);
		const reached = derivation.reaches(before);
		const left = derivation.leaves(before);
		expect(reached.length + left.length).toBeGreaterThan(0);
		for (const form of reached) {
			expect(diff.changed.has(form), `${form} changes`).toBe(true);
			expect(footprint.forms, `${form} is in the footprint`).toContain(form);
		}
		for (const form of left) {
			expect(diff.changed.has(form), `${form} keeps its wire`).toBe(false);
			expect(footprint.forms, `${form} stays out`).not.toContain(form);
		}
		if (derivation.app !== undefined) {
			expect(diff.app).toBe(derivation.app);
			expect(footprint.app).toBe(derivation.app);
		}
	});
});
