/**
 * How a targeted document is made: an editor's document, built from nothing
 * by Nova's own planners and admitted by Nova's commit gate.
 *
 * A targeted document is written as the document it must be (a `buildDoc`
 * spec, `lib/__tests__/docHelpers.ts`, with every identity named), and it is
 * then made the way any editor makes one: Nova's diff planner
 * (`lib/doc/diffDocsToMutations.ts::diffDocsToMutations`) turns the empty
 * document every app starts from (`lib/doc/scaffolds.ts::emptyBlueprintDoc`)
 * into it as one mutation batch, and Nova's commit gate
 * (`lib/doc/commitVerdicts.ts::mutationCommitVerdict`) admits that batch
 * under the document's lookup data or refuses it. What the gate commits is the
 * corpus document; it must be exactly the document written, so a planner that
 * dropped or reshaped anything stops the corpus here, by name.
 *
 * A targeted document whose symptom needs an edit (Nova's next publish of
 * another document over the first) writes D′ too, and is made the same way:
 * Nova's diff planner turns D into D′ as one batch, which Nova's commit gate
 * admits over D, and what it commits must be exactly D′ as written. That
 * batch is the document's edit (`CorpusDocument.edit`).
 *
 * A held placement (a query repeat's `placement`, `HELD_FIELD_KEYS`; a case
 * operation's `placement`; a form's `ownClosePlacement`) is no editor's
 * choice: a publish records it, or a migration writes it for an app already
 * published. A document written with one (a migration witness, holding what
 * the cutover writes for its published app, or a document whose D stands
 * for a published app) is planned without it, and every hold is then laid on
 * the committed document as the recording writes it, which the gate must
 * admit whole. An edit changes a hold only as an editor's edit does: the
 * written edit's content is planned with D's holds left as they are, the
 * moves it needs are planned by `lib/doc/identityMoves.ts::withIdentityMoves`
 * over D's holds as the latest recording, and the commit kernel's rule
 * (`lib/db/placementAuthority.ts::placementChangeRefusal`) must admit the
 * result as an editor's save. D′ written with any other hold is refused.
 *
 * Every identity a document holds is named from the document's id
 * (`targetedUuid`), never drawn from `buildDoc`'s counter, so a targeted
 * document is the same whatever was built before it in the process.
 */

import { isDeepStrictEqual } from "node:util";
import { testUuid } from "@/__tests__/helpers/uuid";
import { placementChangeRefusal } from "@/lib/db/placementAuthority";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { withIdentityMoves } from "@/lib/doc/identityMoves";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type CasePlacement,
	type Column,
	declaresAndroid,
	type OwnClosePlacement,
	type PersistableDoc,
	type Uuid,
} from "@/lib/domain";
import type { QueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import {
	type CorpusDocument,
	checkDocumentFileName,
	type HqSideSaves,
	lookupContextOf,
	type ProjectSettings,
	storedDocument,
} from "../corpus/documents";
import type { UploadedMedia } from "../corpus/publish";
import type { Expected } from "./expected";

/** The identity named `name` in the targeted document `documentId`. */
export function targetedUuid(documentId: string, name: string): Uuid {
	return testUuid(`targeted:${documentId}:${name}`);
}

/** What a targeted document is: the document written, and what the corpus writes beside it. */
export interface TargetedSpec {
	/** The corpus id, `targeted-<what it shows>`. */
	readonly id: string;
	/** The work item 12 rows, findings by defect number, or harness contracts it shows. */
	readonly rows: readonly string[];
	/** The document as written; it must be the one Nova's gate admits. */
	readonly doc: BlueprintDoc;
	readonly lookup?: LookupFixtureDataSnapshot;
	/** The uploaded media the document names, as Nova's media store holds it. */
	readonly media?: ReadonlyMap<string, UploadedMedia>;
	/** The hand-fixed values the intent check holds Core to (`expected.json`). */
	readonly expected: Expected;
	/** Files the expectations read (their restores), by name in the document's directory. */
	readonly files?: Readonly<Record<string, string>>;
	/** A flag whose configuration the symptom needs (`minimum` plus it). */
	readonly singleFlags?: readonly string[];
	/** Privileges every configuration grants beyond those the content needs. */
	readonly privileges?: readonly string[];
	/** Project-space settings every configuration holds (`CorpusDocument.projectSettings`). */
	readonly projectSettings?: ProjectSettings;
	/** What a person saves in HQ over A before Nova's next publish (`hq-side.json`). */
	readonly hqSide?: HqSideSaves;
	/** D′, where the symptom shows on Nova's publish of an edit: the document after it, as written. */
	readonly edit?: BlueprintDoc;
	/** Exact authored commands when endpoint snapshots cannot recover semantic intent.
	 * The production gate must admit them and their result must equal `edit`.
	 */
	readonly editMutations?: readonly Mutation[];
	/**
	 * Present where the document is a migration witness: its A is the
	 * retained export of the app from before a migration
	 * (`proof/migrations/<id>/`) and its B is Nova's republish of the migrated
	 * document over it. The document's source carries it, which names its
	 * source `targeted-migration:<rows>`.
	 */
	readonly migrationWitness?: true;
}

/** Two stored documents' first difference, as a JSON path, for a refusal that names it. */
function firstDifference(a: unknown, b: unknown, path = ""): string {
	if (isDeepStrictEqual(a, b)) return "";
	if (
		typeof a === "object" &&
		a !== null &&
		typeof b === "object" &&
		b !== null &&
		Array.isArray(a) === Array.isArray(b)
	) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
		for (const key of keys) {
			const found = firstDifference(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
				`${path}/${key}`,
			);
			if (found !== "") return found;
		}
	}
	return path === "" ? "/" : path;
}

/** Every placement `doc` holds: each query repeat's, each case operation's
 * and each form's own close's, keyed by the uuid of what holds it. */
interface Holds {
	readonly repeats: ReadonlyMap<Uuid, QueryRepeatPlacement>;
	readonly operations: ReadonlyMap<Uuid, CasePlacement>;
	readonly ownCloses: ReadonlyMap<Uuid, OwnClosePlacement>;
}

const NO_HOLDS: Holds = {
	repeats: new Map(),
	operations: new Map(),
	ownCloses: new Map(),
};

function heldPlacements(doc: BlueprintDoc): Holds {
	const repeats = new Map<Uuid, QueryRepeatPlacement>();
	for (const field of Object.values(doc.fields)) {
		if (
			field.kind === "repeat" &&
			field.repeat_mode === "query_bound" &&
			field.placement !== undefined
		)
			repeats.set(field.uuid, field.placement);
	}
	const operations = new Map<Uuid, CasePlacement>();
	const ownCloses = new Map<Uuid, OwnClosePlacement>();
	for (const form of Object.values(doc.forms)) {
		if (form.ownClosePlacement !== undefined)
			ownCloses.set(form.uuid, form.ownClosePlacement);
		for (const operation of form.caseOperations ?? [])
			if (operation.placement !== undefined)
				operations.set(operation.uuid, operation.placement);
	}
	return { repeats, operations, ownCloses };
}

function holdsAnything(holds: Holds): boolean {
	return (
		holds.repeats.size > 0 ||
		holds.operations.size > 0 ||
		holds.ownCloses.size > 0
	);
}

/** `doc` with each query repeat, case operation and own close holding the
 * placement `holds` names, and the others holding none. */
function withPlacements(doc: BlueprintDoc, holds: Holds): BlueprintDoc {
	if (!holdsAnything(holds) && !holdsAnything(heldPlacements(doc))) return doc;
	const fields = Object.create(null) as BlueprintDoc["fields"];
	for (const [uuid, field] of Object.entries(doc.fields) as [
		Uuid,
		BlueprintDoc["fields"][Uuid],
	][]) {
		if (field.kind !== "repeat" || field.repeat_mode !== "query_bound") {
			fields[uuid] = field;
			continue;
		}
		const { placement: _held, ...unheld } = field;
		const placement = holds.repeats.get(uuid);
		fields[uuid] = placement === undefined ? unheld : { ...unheld, placement };
	}
	const forms = Object.create(null) as BlueprintDoc["forms"];
	for (const [uuid, form] of Object.entries(doc.forms) as [
		Uuid,
		BlueprintDoc["forms"][Uuid],
	][]) {
		const { ownClosePlacement: _heldClose, ...unheldForm } = form;
		const ownClose = holds.ownCloses.get(uuid);
		forms[uuid] = {
			...unheldForm,
			...(ownClose !== undefined && { ownClosePlacement: ownClose }),
			...(form.caseOperations !== undefined && {
				caseOperations: form.caseOperations.map((operation) => {
					const { placement: _heldOperation, ...unheld } = operation;
					const placement = holds.operations.get(operation.uuid);
					return (
						placement === undefined ? unheld : { ...unheld, placement }
					) as typeof operation;
				}),
			}),
		};
	}
	return { ...doc, fields, forms };
}

/**
 * `to` as Nova's diff planner makes it from `from` and Nova's commit gate
 * admits it: the batch and the document committed. Throws, naming what
 * refused it, when the gate refuses the batch or commits anything but `to`.
 */
function planned(
	subject: string,
	from: BlueprintDoc,
	to: BlueprintDoc,
	lookup: LookupFixtureDataSnapshot | undefined,
	authored?: readonly Mutation[],
): { readonly mutations: Mutation[]; readonly committed: PersistableDoc } {
	const holds = heldPlacements(to);
	const planFrom = withPlacements(from, NO_HOLDS);
	const mutations =
		authored ?? diffDocsToMutations(planFrom, withPlacements(to, NO_HOLDS));
	const verdict = mutationCommitVerdict(
		planFrom,
		mutations,
		lookupContextOf(lookup),
	);
	if (!verdict.ok) {
		throw new Error(
			`Nova's commit gate refused ${subject} (${verdict.findings
				.map((finding) => `${finding.code}: ${finding.message}`)
				.join(
					"; ",
				)}), so it is not a document an editor could make; change what it holds.`,
		);
	}
	let next = verdict.nextDoc;
	if (holdsAnything(holds)) {
		// The holds as a migration writes them, admitted whole.
		const held = mutationCommitVerdict(
			withPlacements(next, holds),
			[],
			lookupContextOf(lookup),
		);
		if (!held.ok) {
			throw new Error(
				`Nova's commit gate refused the placements ${subject} holds (${held.findings
					.map((finding) => `${finding.code}: ${finding.message}`)
					.join(
						"; ",
					)}); hold only a placement its query repeat, case operation or own close can take.`,
			);
		}
		next = held.nextDoc;
	}
	const committed = storedDocument(next);
	const written = storedDocument(to);
	if (!isDeepStrictEqual(committed, written)) {
		throw new Error(
			`Nova's planner and gate made ${subject} differ from the document written, first at ${firstDifference(written, committed)}; write the document as Nova stores it.`,
		);
	}
	// The batch as the gate admitted it, in its canonical form.
	return { mutations: [...verdict.mutations], committed };
}

/**
 * D′ as an editor makes it from D: the content of the edit (Nova's diff
 * planner from D to D′ with D's holds, or the commands written for it), the
 * moves that content needs appended by `withIdentityMoves` over D's holds as
 * the latest recording, admitted by Nova's commit gate over D and by the
 * commit kernel's placement rule as an editor's save. Throws, naming what
 * refused it, when either refuses the batch or it commits anything but
 * `to`, a D′ that holds a placement no move of the edit gives included.
 */
function plannedEdit(
	subject: string,
	from: BlueprintDoc,
	to: BlueprintDoc,
	lookup: LookupFixtureDataSnapshot | undefined,
	authored?: readonly Mutation[],
): { readonly mutations: Mutation[]; readonly committed: PersistableDoc } {
	const recorded = readPlacementHolds(from);
	const content =
		authored ??
		diffDocsToMutations(from, withPlacements(to, heldPlacements(from)));
	const { batch } = withIdentityMoves(from, content, { recorded });
	const verdict = mutationCommitVerdict(from, batch, lookupContextOf(lookup));
	if (!verdict.ok) {
		throw new Error(
			`Nova's commit gate refused ${subject} (${verdict.findings
				.map((finding) => `${finding.code}: ${finding.message}`)
				.join(
					"; ",
				)}), so it is not a document an editor could make; change what it holds.`,
		);
	}
	const refusal = placementChangeRefusal(
		from,
		verdict.nextDoc,
		"autosave",
		recorded,
	);
	if (refusal !== null) {
		throw new Error(
			`The commit kernel refused ${subject} as an editor's save ("${refusal}"); an edit changes a held placement only by a move its own change needs.`,
		);
	}
	const committed = storedDocument(verdict.nextDoc);
	const written = storedDocument(to);
	if (!isDeepStrictEqual(committed, written)) {
		throw new Error(
			`Nova's planner and gate made ${subject} differ from the document written, first at ${firstDifference(written, committed)}; write the document as Nova stores it, each held placement where the moves the edit needs put it.`,
		);
	}
	return { mutations: [...verdict.mutations], committed };
}

/**
 * The targeted document `spec` describes, made from the empty document by
 * Nova's planner and admitted by Nova's commit gate, with its edit where it
 * writes D′. Throws, naming what refused it, when the gate refuses a batch
 * or commits anything but the document written.
 */
export function targetedDocument(spec: TargetedSpec): CorpusDocument {
	if (spec.editMutations !== undefined && spec.edit === undefined) {
		throw new Error(
			`The targeted document ${spec.id} names edit commands without the document they must produce.`,
		);
	}
	const { committed } = planned(
		`the targeted document ${spec.id}`,
		emptyBlueprintDoc(spec.doc.appId),
		spec.doc,
		spec.lookup,
	);
	const edit =
		spec.edit === undefined
			? undefined
			: plannedEdit(
					`the edit of the targeted document ${spec.id}`,
					spec.doc,
					spec.edit,
					spec.lookup,
					spec.editMutations,
				);
	for (const name of Object.keys(spec.files ?? {})) {
		checkDocumentFileName(spec.id, name);
	}
	/* A `.ccz` installs an app on Android and nothing else, so a document
	 * that declares no Android has no local archive, and its expectations
	 * run on HQ's build, which a Web Apps worker meets. */
	if (!declaresAndroid(committed)) {
		for (const expectation of spec.expected.intent) {
			if (expectation.export === "local") {
				throw new Error(
					`The targeted document ${spec.id} declares no Android, so Nova offers no local archive of it; run its expectation ${expectation.id} on HQ's build ("A").`,
				);
			}
		}
	}
	return {
		id: spec.id,
		source: {
			kind: "targeted",
			rows: spec.rows,
			...(spec.migrationWitness === true && { migrationWitness: true }),
		},
		doc: committed,
		...(spec.lookup !== undefined && { lookup: spec.lookup }),
		...(spec.media !== undefined && { media: spec.media }),
		expected: spec.expected,
		...(spec.files !== undefined && { files: spec.files }),
		...(spec.singleFlags !== undefined && { singleFlags: spec.singleFlags }),
		...(spec.privileges !== undefined && { privileges: spec.privileges }),
		...(spec.projectSettings !== undefined && {
			projectSettings: spec.projectSettings,
		}),
		...(spec.hqSide !== undefined && { hqSide: spec.hqSide }),
		...(edit !== undefined && {
			edit: { mutations: edit.mutations, nextDoc: edit.committed },
		}),
	};
}

/**
 * A case list over `columns`, Results and Details both in the order written,
 * with `rest` (search inputs, a filter, a selection, a tile) beside them.
 */
export function caseListOf(
	columns: readonly Column[],
	rest: Partial<Omit<CaseListConfig, "columns">> = {},
): CaseListConfig {
	const order = columns.map((column) => column.uuid);
	return {
		columns: [...columns],
		listColumnOrder: order,
		detailColumnOrder: [...order],
		searchInputs: [],
		...rest,
	};
}
