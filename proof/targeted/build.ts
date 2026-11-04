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
 * A query repeat's held placement (`placement`, `HELD_FIELD_KEYS`) is no
 * editor's choice, and no mutation an editor sends writes one: a publish
 * records it, or a migration writes it for an app already published. A
 * document written with one (a migration witness, holding what the cutover
 * writes for its published app) is planned without it, and the hold is then
 * laid on the committed document as the migration writes it, which the gate
 * must admit whole. An edit never changes a hold.
 *
 * Every identity a document holds is named from the document's id
 * (`targetedUuid`), never drawn from `buildDoc`'s counter, so a targeted
 * document is the same whatever was built before it in the process.
 */

import { isDeepStrictEqual } from "node:util";
import { testUuid } from "@/__tests__/helpers/uuid";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	declaresAndroid,
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

/** The placement each query repeat of `doc` holds, by its uuid. */
function heldPlacements(doc: BlueprintDoc): Map<Uuid, QueryRepeatPlacement> {
	const holds = new Map<Uuid, QueryRepeatPlacement>();
	for (const field of Object.values(doc.fields)) {
		if (
			field.kind === "repeat" &&
			field.repeat_mode === "query_bound" &&
			field.placement !== undefined
		)
			holds.set(field.uuid, field.placement);
	}
	return holds;
}

/** `doc` with each query repeat holding the placement `holds` names, and the
 * others holding none. */
function withPlacements(
	doc: BlueprintDoc,
	holds: ReadonlyMap<Uuid, QueryRepeatPlacement>,
): BlueprintDoc {
	if (holds.size === 0 && heldPlacements(doc).size === 0) return doc;
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
		const placement = holds.get(uuid);
		fields[uuid] = placement === undefined ? unheld : { ...unheld, placement };
	}
	return { ...doc, fields };
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
	const unheld = new Map<Uuid, QueryRepeatPlacement>();
	const planFrom = withPlacements(from, unheld);
	const mutations =
		authored ?? diffDocsToMutations(planFrom, withPlacements(to, unheld));
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
	if (holds.size > 0) {
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
					.join("; ")}); hold only a placement its query repeat can take.`,
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
	if (
		spec.edit !== undefined &&
		!isDeepStrictEqual(heldPlacements(spec.doc), heldPlacements(spec.edit))
	) {
		throw new Error(
			`The edit of the targeted document ${spec.id} changes a query repeat's held placement, which no editor's edit writes; hold the same placements in both documents.`,
		);
	}
	const edit =
		spec.edit === undefined
			? undefined
			: planned(
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
