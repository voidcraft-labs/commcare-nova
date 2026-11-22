import type { InstallationProfileBinding } from "@/lib/commcare/wireIdentity";
/**
 * The corpus's documents and where each comes from.
 *
 * A corpus document is one admitted Nova document with what Nova's publish
 * reads beside it (its Project's lookup data and uploaded media), under an
 * id that is the same on every run and machine: its source and its name, or
 * its generator, seed and index. Six sources feed the corpus:
 *
 * - the native producers' documents (`./producers.ts`);
 * - the workforce documents, producer documents that also hold the worker,
 *   organization and automation entities no producer holds
 *   (`./workforce.ts`);
 * - the admitted expander corpus, which `lib/commcare/__tests__/expander.test.ts`
 *   writes through `expanderEvidence.ts::captureExpanderEvidence` when run as
 *   a Vitest writer (`readExpanderCapture`);
 * - the targeted documents, each built to show one defect part's symptom
 *   with fixed values (`TARGETED_MODULE`);
 * - a fixed-seed sample of the compiler fuzz generators, which
 *   `./__tests__/fuzzSample.test.ts` writes when run as a Vitest writer
 *   (`readFuzzSample`);
 * - the apps CommCare HQ's own pages, models and form builder made, retained
 *   under `proof/hq-apps/<base>/` by the lane and held to HQ at its pin
 *   (`./hqAuthored.ts`): each document is Nova's first reading of a base, its
 *   A is HQ's own app and its B is Nova's publish over it as over an app
 *   Nova brought in (`HqAuthoredFacts`).
 *
 * The expander and fuzz sources are Vitest writers because the modules they
 * rest on import Vitest, which loads only inside Vitest's runner.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import type {
	ColumnFieldWordRow,
	WireIdentityOverride,
} from "@/lib/commcare/wireIdentity";
import type { AdoptedKeyedCaseId } from "@/lib/deployment/adoption";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import type { FirstPublishChangeId } from "@/lib/publish/firstPublishChangeIds";
import {
	DEFAULT_ADVANCED_SAMPLE_SIZE,
	DEFAULT_EXPRESSION_SAMPLE_SIZE,
} from "./defaults";
import type { UploadedMedia } from "./publish";

/** Where a corpus document comes from. */
export type CorpusSource =
	| {
			readonly kind: "producer";
			/** The native proof family whose producer emits it (`proof/native/families.py`). */
			readonly family: string;
			readonly scenario: string;
	  }
	| {
			readonly kind: "workforce";
			/** The producer document it is built over (`./workforce.ts::WORKFORCE_BASES`). */
			readonly base: string;
	  }
	| {
			readonly kind: "expander";
			/** The tests of `expander.test.ts` that expand it, first one first. */
			readonly tests: readonly string[];
	  }
	| {
			readonly kind: "fuzz";
			readonly generator: FuzzGenerator;
			readonly seed: number;
			readonly index: number;
	  }
	| {
			readonly kind: "targeted";
			/** The register rows or harness contracts the document is built to show. */
			readonly rows: readonly string[];
			/**
			 * Present, and `true`, for a migration witness: a targeted document
			 * whose A is the retained export of the app from before a migration
			 * (`proof/migrations/<id>/`) and whose B is Nova's republish of the
			 * migrated document over it.
			 */
			readonly migrationWitness?: true;
	  }
	| {
			readonly kind: "hq-authored";
			/** The base's id: its directory under `proof/hq-apps/` and its entry of `proof/matrix`. */
			readonly base: string;
	  };

/** What an `hq-authored` document carries beside D: what Nova's reading of the base gave. */
export interface HqAuthoredFacts {
	/** The HQ id of every menu and form D holds, and each form's `xmlns`. Dense: one row an entity. */
	readonly identity: readonly WireIdentityOverride[];
	/** HQ's source answer the capture's peer starts from: `proof/hq-apps/<base>/app-source.json`. */
	readonly source: unknown;
	/** The first-publish register ids that apply under `declaration`. */
	readonly firstPublish: readonly string[];
	/** Where each of `firstPublish` stands on the reading, in the same order
	 *  (`lib/deployment/reading/firstPublishChanges.ts::firstPublishChangePlaces`). */
	readonly firstPublishPlaces: readonly {
		readonly id: string;
		readonly places: readonly string[];
	}[];
	/** The declaration D was read under: the base's own, or the reading's preselected one. */
	readonly declaration: {
		readonly runsOnlyOn: "web-apps" | "android" | null;
		readonly splitDatetime: boolean;
	};
	/** HQ's path for each asset D references, by asset id. Empty where A maps no file. */
	readonly mediaPaths: ReadonlyMap<string, string>;
	/**
	 * Each create keyed by an answer D keeps, with the prefix its cases stand
	 * under in A: the rows a bring-in of A records
	 * (`lib/deployment/targetIdentity.ts::resolveTargetIdentity`'s keyed creates), which every
	 * publish over A and its local archive print the create under. Empty
	 * where D keeps none.
	 */
	readonly keyedCaseIds: readonly AdoptedKeyedCaseId[];
	/**
	 * Each case list column D keeps whose field A stores under the word Nova
	 * does not write, by screen: the rows a bring-in of A records
	 * (`resolveTargetIdentity`'s column words), which every publish over A and
	 * its local archive print the column under. Empty where A holds none.
	 */
	readonly columnWords: readonly ColumnFieldWordRow[];
	readonly installationProfiles?: readonly InstallationProfileBinding[];
	/**
	 * Absolute path of the base's retained directory (`proof/hq-apps/<base>/`),
	 * whose files the entry writer copies into the document's `authored/` and
	 * whose `base.json` gives the document its one configuration.
	 */
	readonly retained: string;
	/**
	 * Absolute path of the base's hand directory (`proof/matrix/hand/<base>/`):
	 * its value expectations and the restore they run over, which the entry
	 * writer writes into the document's `expected.json` and directory.
	 */
	readonly hand: string;
}

/** Independent compiler fuzz streams the corpus samples. */
export const FUZZ_GENERATORS = [
	"xform",
	"suite",
	"expression",
	"advanced",
] as const;
export type FuzzGenerator = (typeof FUZZ_GENERATORS)[number];

/** One admitted document with what Nova's publish reads beside it. */
export interface CorpusDocument {
	/** Stable across runs and machines; names the document's directory. */
	readonly id: string;
	readonly source: CorpusSource;
	/** The stored document; it parses under the strict schema. */
	readonly doc: PersistableDoc;
	/** The Project's lookup data: every table the document references, with its rows. */
	readonly lookup?: LookupFixtureDataSnapshot;
	/** Each uploaded asset the document references, by asset id. */
	readonly media?: ReadonlyMap<string, UploadedMedia>;
	/** A targeted document's hand-fixed intent values, written as `expected.json`. */
	readonly expected?: unknown;
	/**
	 * Further files a targeted document's expectations read, written into its
	 * directory under these names: the restores an expectation names
	 * (`expected.json`'s `restore`), the case data and lookup rows Core runs
	 * it over.
	 */
	readonly files?: Readonly<Record<string, string>>;
	/** The flags a reproduction names for the document, each a `singleFlag` configuration. */
	readonly singleFlags?: readonly string[];
	/**
	 * Privileges (constants in `corehq/privileges.py`) a reproduction needs the
	 * project space to hold beyond those the document's content needs, such
	 * as Web Apps for an app whose symptom shows only there. Every
	 * configuration of the document grants them.
	 */
	readonly privileges?: readonly string[];
	/**
	 * Project-space settings every configuration of the document holds
	 * (`./configurations.ts`), such as sync cases on form entry for a
	 * reproduction whose symptom shows only under it.
	 */
	readonly projectSettings?: ProjectSettings;
	/**
	 * What a person saves in HQ over Nova's first publish before its next
	 * one, written as `hq-side.json` (`HqSideSaves`): the unit saves it over
	 * A through HQ's own views before A is built, so B and B-edit are
	 * published over it.
	 */
	readonly hqSide?: HqSideSaves;
	/**
	 * A targeted document's own edit: D′ as written, which Nova's planner
	 * makes from D and Nova's commit gate admits (`proof/targeted/build.ts`).
	 * Every other document's edit is drawn by the edit generator.
	 */
	readonly edit?: TargetedEdit;
	/** Present exactly for an `hq-authored` document. */
	readonly hqAuthored?: HqAuthoredFacts;
}

/** Project-space settings a configuration holds beyond its flags and privileges. */
export interface ProjectSettings {
	/** HQ's sync cases on form entry (`CaseSearchConfig.sync_cases_on_form_entry`). */
	readonly syncCasesOnFormEntry?: boolean;
	/** CommTrack on for the project space (`Domain.commtrack_enabled`). */
	readonly commtrack?: boolean;
}

/** A targeted document's edit: the batch Nova's planner made from D to D′, and D′ as the gate committed it. */
export interface TargetedEdit {
	readonly mutations: readonly Mutation[];
	readonly nextDoc: PersistableDoc;
}

/**
 * What a person saves in HQ over A, each through the HQ view a person's
 * save reaches (`proof/observe/hqside.py`), in this order:
 *
 * - `uiTranslations`: on the app's UI translations page, each language's
 *   texts by key, saved beside the texts A holds for that language
 *   (`views/apps.py::edit_app_ui_translations`);
 * - `appAttributes`: on the app's settings page, each attribute's value,
 *   in the page's one save (`views/settings.py::edit_commcare_settings`,
 *   which stores each through `views/apps.py::edit_app_attr` with `all`);
 * - `buildProfiles`: on the app's language profiles page, each profile's
 *   id, name and language codes (`views/releases.py::LanguageProfilesView`);
 * - `lookupTable`: the table Nova's publish uploaded under `tag`, as a
 *   person keeps it in HQ: downloaded, given a property on one field, an
 *   attribute and an owner (a mobile worker, a group and a location the
 *   project space holds) on every row, and uploaded through HQ's lookup
 *   upload (`fixtures/upload/run_upload.py::_run_upload`), then described
 *   in HQ's table editor (`fixtures/views.py::update_tables`);
 * - `addOns`: the app's add-ons section as it saves, every slug HQ lists on
 *   or off (`app_manager/js/add_ons.js`, `EditAddOns`, posts each at the
 *   value it shows), which `views/apps.py::edit_add_ons` stores over the
 *   add-ons Nova wrote;
 * - `profileProperties`: on the app's settings page, each setting's value
 *   by key (`views/settings.py::edit_commcare_profile`), beside the settings
 *   A holds: a choice as its text, a switch as `true` or `false`;
 * - `profileFeatures`: on the same page, each profile feature's value by
 *   key, such as the worker activity level `credentials`, beside the
 *   features A holds.
 *
 * and then the saves a person makes to the app's content, each through the
 * view a person's save reaches (`HqSideContentSaves`).
 *
 * It also states what Nova's next publish over the saves does, which the
 * capture holds (`./publish.ts`): `republish` is `"proceeds"` (it goes
 * through with no stop), `"discards"` (it goes through after the discard a
 * person would confirm), `"stops"` (Nova stops it and offers no discard),
 * with `stopCode`, the publish's failure code, exactly when it stops,
 * `"records"` (Nova stops it over a change of the app it can bring in, its
 * review finds nothing to bring in for the reason `recorded` states and
 * lists the changes its next publish makes, the record moves the pair, and
 * the publish that follows goes through), or `"brings-in"` (Nova stops it,
 * its review lists the change and, by their ids, the changes its next
 * publish makes in HQ (`publishChanges`), the bring-in takes it, and the
 * publish that follows sends `bringsIn`, the document the bring-in must
 * give). On a document that brings its saves in, those listed changes are
 * the one thing besides the registers a check of the next publish accepts
 * (`proof/checks/changes.py`).
 */
export type HqSideSaves = HqSideSaveKinds &
	(
		| {
				readonly republish: "proceeds" | "discards";
				readonly stopCode?: never;
				readonly recorded?: never;
				readonly bringsIn?: never;
				readonly publishChanges?: never;
				readonly alsoPublishesOver?: never;
		  }
		| {
				readonly republish: "stops";
				readonly stopCode: string;
				readonly recorded?: never;
				readonly bringsIn?: never;
				readonly publishChanges?: never;
				readonly alsoPublishesOver?: never;
		  }
		| {
				readonly republish: "records";
				readonly stopCode?: never;
				readonly recorded: HqSideRecorded;
				readonly bringsIn?: never;
				readonly publishChanges?: never;
				readonly alsoPublishesOver?: never;
		  }
		| {
				readonly republish: "brings-in";
				readonly stopCode?: never;
				readonly recorded?: never;
				/** The document Nova's bring-in of the saves must give, as stored. */
				readonly bringsIn: PersistableDoc;
				/**
				 * The changes Nova's next publish makes in HQ that its review of
				 * the saves lists, by their ids in the register's order
				 * (`lib/publish/firstPublishChangeIds.ts`), each shown by its
				 * sentence (`lib/deployment/hqChanges/review.ts::publishChangeSentences`).
				 */
				readonly publishChanges: readonly FirstPublishChangeId[];
				/**
				 * Present, and `true`, where the capture also runs the person's
				 * other choice over the same saves, publishing over the change:
				 * the publish stops, the discard of the change goes through, and
				 * HQ's map holds the document of Nova's own bytes at every path
				 * the publish sends (`./publish.ts::PublishedOverRecord`).
				 */
				readonly alsoPublishesOver?: true;
		  }
	);

/**
 * What Nova's review of a person's saves answers where it finds nothing to
 * bring in (`HqChangesReview`'s `nothing` arm): the reason, and the changes
 * Nova's next publish makes in HQ that it lists, by their ids in the
 * register's order (`lib/publish/firstPublishChangeIds.ts`), each shown by
 * its sentence (`lib/deployment/hqChanges/review.ts::publishChangeSentences`).
 */
export interface HqSideRecorded {
	readonly reason: "reads-the-same" | "already-here";
	readonly publishChanges: readonly FirstPublishChangeId[];
}

/** The saves of `HqSideSaves`, each through the HQ view a person's save reaches. */
export interface HqSideSaveKinds extends HqSideContentSaves {
	readonly uiTranslations?: Readonly<
		Record<string, Readonly<Record<string, string>>>
	>;
	readonly appAttributes?: Readonly<Record<string, boolean | string>>;
	readonly buildProfiles?: readonly {
		readonly practice_worker_id?: string;
		readonly id: string;
		readonly name: string;
		readonly langs: readonly string[];
	}[];
	readonly lookupTable?: {
		readonly tag: string;
		/** A property the person gives one field, and each row's value of it. */
		readonly fieldProperty: {
			readonly field: string;
			readonly property: string;
			readonly value: string;
		};
		/** An attribute the person gives every row, and its value on each row, in the table's order. */
		readonly rowAttribute: {
			readonly name: string;
			readonly values: readonly string[];
		};
		/** The owners the person gives every row: names HQ resolves in the project space. */
		readonly owners: {
			readonly user: string;
			readonly group: string;
			readonly location: { readonly name: string; readonly siteCode: string };
		};
		readonly description: string;
	};
	readonly addOns?: Readonly<Record<string, boolean>>;
	readonly profileProperties?: Readonly<Record<string, string | boolean>>;
	readonly profileFeatures?: Readonly<Record<string, string>>;
}

/** A form of the app CommCare HQ holds, by its menu's place and its own place in that menu, from 0. */
export interface HqFormPlace {
	readonly module: number;
	readonly form: number;
}

/**
 * The saves a person makes to an app's content in HQ, made in this order
 * after the saves of `HqSideSaveKinds`, each through the view a person's
 * save reaches (`proof/observe/hqside.py`):
 *
 * - `formLabel`: one question's label reworded in the app's first language
 *   in HQ's form builder (`proof/editors/vellum.py::open_and_save`, which
 *   opens the form, makes the edit and presses the builder's own Save).
 *   `edit` says how the edit was made: `page`, by working the builder's
 *   page as a person does, or `builder-model`, by setting the question's
 *   label through the builder's own object for it where the page cannot be
 *   worked so; the builder's own Save writes the form either way;
 * - `formResave`: a form opened in HQ's form builder and saved with no
 *   change;
 * - `questions`: a form's questions changed, posted as the form builder
 *   posts a save (`views/forms.py::patch_xform`: a patch from the source HQ
 *   holds to `xform`, with the source's `sha1`);
 * - `formAttribute`: a form's own settings, each posted by name to
 *   `views/forms.py::edit_form_attr` as the form settings page posts them;
 * - `formActions`: a form's case management, each case property in
 *   `update` saved from the question at its path, posted as the Case
 *   Management tab posts it (`views/forms.py::edit_form_actions`: the
 *   actions as HQ holds them, and the mappings as a `case_mapping_diff`);
 * - `moduleAttribute`: a menu's name in the app's first language, posted to
 *   `views/modules.py::edit_module_attr`;
 * - `moduleDetail`: a column added at the end of a menu's case list, posted
 *   as the Case List page posts its columns
 *   (`views/modules.py::edit_module_detail_screens`, `type` `case`, every
 *   column and the list's own settings as HQ holds them, then `column`);
 * - `formsAddedAndRemoved`: a menu's form at `removed` deleted
 *   (`views/forms.py::delete_form`), then a survey added at its end
 *   (`views/forms.py::new_form`), given its questions in the form builder
 *   (`patch_xform`, to `added.xform`);
 * - `order`: a menu moved (`views/apps.py::rearrange`, key `modules`) and a
 *   form moved within its menu (key `forms`), each from one place to
 *   another;
 * - `mediaReplaced`: the file at a path the app already holds replaced, as
 *   HQ's media page uploads a picture there
 *   (`hqmedia/views.py::ProcessImageFileUploadView`, posted with the path).
 */
export interface HqSideContentSaves {
	readonly formLabel?: HqFormPlace & {
		/** The question's path in the form, `/data/...`. */
		readonly question: string;
		readonly label: string;
		readonly edit: "page" | "builder-model";
	};
	readonly formResave?: HqFormPlace;
	readonly questions?: HqFormPlace & {
		/** The form's whole XForm after the save. */
		readonly xform: string;
	};
	readonly formAttribute?: HqFormPlace & {
		readonly attributes: Readonly<Record<string, string>>;
	};
	readonly formActions?: HqFormPlace & {
		/** Each case property, saved from the question at the path it names. */
		readonly update: Readonly<Record<string, string>>;
	};
	readonly moduleAttribute?: {
		readonly module: number;
		readonly name: string;
	};
	readonly moduleDetail?: {
		readonly module: number;
		/** The column as the Case List page posts it, every key HQ stores of it. */
		readonly column: Readonly<Record<string, unknown>>;
	};
	readonly formsAddedAndRemoved?: {
		readonly module: number;
		/** The place of the form deleted, before anything is added. */
		readonly removed: number;
		readonly added: {
			/** The survey's name, as `views/forms.py::new_form` gives it. */
			readonly name: string;
			/** Its whole XForm after the form builder's save. */
			readonly xform: string;
		};
	};
	readonly order?: {
		readonly modules?: { readonly from: number; readonly to: number };
		readonly forms?: {
			readonly module: number;
			readonly from: number;
			readonly to: number;
		};
	};
	readonly mediaReplaced?: {
		/** The path the app holds the file at, `jr://file/...`. */
		readonly path: string;
		readonly mimeType: string;
		/** The new file's bytes. */
		readonly base64: string;
	};
}

/**
 * The module the targeted documents come from, relative to the worktree:
 * `proof/targeted/index.ts`, exporting `targetedDocuments(): CorpusDocument[]`
 * (each with a `targeted` source and its `expected` values). The corpus
 * includes them in its fixed floor when the module exists. A targeted
 * document carries no generated edit batch, only the edit it writes itself
 * (`CorpusDocument.edit`): its symptom is fixed by what it holds, and the
 * fixed floor's batches are balanced over the other documents alone, so
 * adding a targeted document changes no other document's batch
 * (`./emitCorpus.ts`).
 */
export const TARGETED_MODULE = "proof/targeted/index.ts";

/**
 * The names a document's own files (`CorpusDocument.files`) may take: a
 * plain file name in its directory that none of the corpus's own files
 * (`./emitCorpus.ts`'s layout) takes.
 */
const DOCUMENT_FILE_NAME = /^[a-z0-9][a-z0-9-]*\.(xml|json)$/;
const LAYOUT_FILES = new Set([
	"document.json",
	"configurations.json",
	"verdict.json",
	"expected.json",
	"hq-side.json",
	"inputs.json",
	"first-publish.json",
]);

/** Refuse a document file name that leaves the document's directory or takes a corpus file's name. */
export function checkDocumentFileName(documentId: string, name: string): void {
	if (!DOCUMENT_FILE_NAME.test(name) || LAYOUT_FILES.has(name)) {
		throw new Error(
			`The corpus document ${documentId} names its own file ${JSON.stringify(name)}; a document's own file is a plain lower-case .xml or .json name in its directory that no corpus file (${[...LAYOUT_FILES].join(", ")}) takes.`,
		);
	}
}

/**
 * The uploaded assets of a media manifest, as Nova's media store holds them.
 * Built-in icons resolve from Nova's shipped catalog, so they are not
 * uploads and are left out.
 */
export function uploadedMedia(
	manifest: AssetManifest,
): ReadonlyMap<string, UploadedMedia> | undefined {
	const media = new Map<string, UploadedMedia>();
	for (const [assetId, asset] of manifest) {
		if (!mediaAssetIdSchema.safeParse(assetId).success) continue;
		if (asset.bytes === undefined) {
			throw new Error(
				`The media manifest names the uploaded asset ${assetId} without its bytes, so the corpus cannot publish it as Nova's upload stored it.`,
			);
		}
		media.set(assetId, {
			kind: asset.kind,
			mimeType: asset.mimeType,
			extension: asset.extension,
			bytes: Buffer.from(asset.bytes),
		});
	}
	return media.size === 0 ? undefined : media;
}

/**
 * The lookup context a document is validated under with this lookup data:
 * its tables (a stored document's whole Project, or the tables a publish
 * reads), or no tables available when there is none.
 */
export function lookupContextOf(
	lookup: LookupFixtureDataSnapshot | undefined,
): LookupValidationContext {
	return lookup === undefined
		? LOOKUP_CONTEXT_UNAVAILABLE
		: {
				kind: "available",
				projectId: lookup.projectId,
				projectRevision: lookup.projectRevision,
				definitions: lookup.definitions,
			};
}

/** A hydrated document in its stored form, rebuilt as plain JSON. */
export function storedDocument(doc: BlueprintDoc): PersistableDoc {
	return JSON.parse(JSON.stringify(toPersistableDoc(doc))) as PersistableDoc;
}

// ── Captures written by the Vitest writers ──────────────────────────

/** One document a Vitest writer wrote: the stored document and its uploaded media. */
const writtenDocumentSchema = z.strictObject({
	doc: z.record(z.string(), z.unknown()),
	media: z
		.record(
			z.string(),
			z.strictObject({
				kind: z.enum(["image", "audio", "video"]),
				mimeType: z.string(),
				extension: z.string(),
				base64: z.string(),
			}),
		)
		.optional(),
});

export type WrittenDocument = z.input<typeof writtenDocumentSchema>;

/** A document with its uploaded media, in the form a Vitest writer writes it. */
export function writtenDocument(
	doc: PersistableDoc,
	media: ReadonlyMap<string, UploadedMedia> | undefined,
): WrittenDocument {
	return {
		doc: doc as unknown as Record<string, unknown>,
		...(media !== undefined && {
			media: Object.fromEntries(
				[...media].map(([id, asset]) => [
					id,
					{
						kind: asset.kind,
						mimeType: asset.mimeType,
						extension: asset.extension,
						base64: asset.bytes.toString("base64"),
					},
				]),
			),
		}),
	};
}

function readWritten(
	value: unknown,
	where: string,
): {
	doc: PersistableDoc;
	media?: ReadonlyMap<string, UploadedMedia>;
} {
	const parsed = writtenDocumentSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`${where} is not a document the corpus's Vitest writers write (a stored doc and its media): ${parsed.error.message}`,
		);
	}
	const media =
		parsed.data.media === undefined
			? undefined
			: new Map(
					Object.entries(parsed.data.media).map(([id, asset]) => [
						id,
						{
							kind: asset.kind,
							mimeType: asset.mimeType,
							extension: asset.extension,
							bytes: Buffer.from(asset.base64, "base64"),
						} satisfies UploadedMedia,
					]),
				);
	return {
		doc: parsed.data.doc as unknown as PersistableDoc,
		...(media !== undefined && { media }),
	};
}

/** The record `captureExpanderEvidence` writes for each document it captured. */
const expanderManifestSchema = z.array(
	z.strictObject({
		id: z.string().regex(/^[0-9a-f]{20}$/),
		tests: z.array(z.string()).min(1),
		localForms: z.array(z.string()),
		document: z.string(),
	}),
);

/**
 * The expander corpus's documents, from the directory
 * `captureExpanderEvidence` wrote when `expander.test.ts` ran whole as a
 * Vitest writer. Each is named by the first test that expands it and its
 * place among that test's documents, so the name holds as long as the test
 * does; the capture's own id is a hash of the document, which moves with
 * every identity `buildDoc` mints before it.
 */
export async function readExpanderCapture(
	directory: string,
): Promise<CorpusDocument[]> {
	const manifestPath = join(directory, "manifest.json");
	const manifest = expanderManifestSchema.parse(
		JSON.parse(await readFile(manifestPath, "utf8")),
	);
	const ordinal = new Map<string, number>();
	const documents: CorpusDocument[] = [];
	for (const record of manifest) {
		const [first] = record.tests;
		if (first === undefined) continue;
		const index = ordinal.get(first) ?? 0;
		ordinal.set(first, index + 1);
		const written = readWritten(
			JSON.parse(await readFile(join(directory, record.document), "utf8")),
			`The expander capture's ${record.document}`,
		);
		documents.push({
			id: `expander-${slug(first)}-${shortHash(first)}-${index}`,
			source: { kind: "expander", tests: record.tests },
			...written,
		});
	}
	return documents;
}

/** The fuzz sample's index, as `./__tests__/fuzzSample.test.ts` writes it. */
const fuzzIndexSchema = z.strictObject({
	seed: z.number().int(),
	size: z.number().int().nonnegative(),
	documents: z.array(
		z.strictObject({
			id: z.string(),
			generator: z.enum(FUZZ_GENERATORS),
			index: z.number().int().nonnegative(),
			file: z.string(),
		}),
	),
});

/** The fuzz sample's documents, from the directory its Vitest writer wrote. */
export async function readFuzzSample(
	directory: string,
): Promise<CorpusDocument[]> {
	const index = fuzzIndexSchema.parse(
		JSON.parse(await readFile(join(directory, "index.json"), "utf8")),
	);
	const documents: CorpusDocument[] = [];
	for (const entry of index.documents) {
		const written = readWritten(
			JSON.parse(await readFile(join(directory, entry.file), "utf8")),
			`The fuzz sample's ${entry.file}`,
		);
		documents.push({
			id: entry.id,
			source: {
				kind: "fuzz",
				generator: entry.generator,
				seed: index.seed,
				index: entry.index,
			},
			...written,
		});
	}
	return documents;
}

/** The id of the `index`th document the named fuzz generator draws at `seed`. */
export function fuzzDocumentId(
	generator: FuzzGenerator,
	seed: number,
	index: number,
): string {
	return `fuzz-${generator}-${seed}-${index}`;
}

/**
 * How many of a sample of `size` each generator draws: the first half (the
 * larger, for an odd size) from the XForm generator, the rest from the suite
 * generator, plus the separate expression and advanced samples, each a stream
 * of its own. Each generator's draws in a smaller sample are a prefix of its
 * draws in a larger one, so a smaller sample is a subset of every larger one
 * (not a prefix of it: the XForm draws come first).
 */
export function fuzzSplit(size: number): Record<FuzzGenerator, number> {
	return {
		xform: Math.ceil(size / 2),
		suite: Math.floor(size / 2),
		expression: DEFAULT_EXPRESSION_SAMPLE_SIZE,
		advanced: DEFAULT_ADVANCED_SAMPLE_SIZE,
	};
}

function slug(text: string): string {
	const words = text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
	let out = "";
	for (const word of words) {
		const next = out === "" ? word : `${out}-${word}`;
		if (next.length > 48) break;
		out = next;
	}
	return out === "" ? "test" : out;
}

function shortHash(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of Buffer.from(text, "utf8")) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
