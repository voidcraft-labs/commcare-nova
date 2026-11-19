import "server-only";

/**
 * The reference document of a deployment, `D_ref`: the Nova document the
 * stored baseline's source describes, as a publish now would send it had
 * nobody changed the app's content since. And `usablePair`, the one rule of
 * whether a deployment's baseline and revision are a pair a comparison can
 * stand on.
 *
 * A change in Nova is measured against this document. A server's own writes
 * after the publish (a hold a publish recorded, a repair a deploy ran, a
 * move of the app to another Project) are part of it, and so is everything
 * a publish never sends, taken from the head: the kinds no reading holds,
 * the worker setup, where the app runs and its logo.
 */

import { produce } from "immer";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { readAppChangeStreamRowsSince } from "@/lib/db/appChangeStream";
import {
	type AdmittedDurableAppChange,
	parsePersistedAppChangeEnvelope,
} from "@/lib/db/persistedJson";
import { getAppDb } from "@/lib/db/pg";
import { EDITOR_APP_CHANGE_KINDS } from "@/lib/db/types";
import {
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, PersistableDoc, Uuid } from "@/lib/domain";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { CasePropertyRename } from "@/lib/publish/hqChangesKinds";
import type { AppBaseline, DeploymentResource } from "../types";

export type ReferenceDocument =
	| {
			readonly kind: "ok";
			/** `D_ref`. */
			readonly doc: BlueprintDoc;
			/**
			 * `doc` less the second of each pair of worker or location properties that
			 * hold one slug: the property the published document did not hold. The
			 * document both readings' identity map is made from, so the slug binds to
			 * the property CommCare HQ's app means by it.
			 */
			readonly identityDoc: BlueprintDoc;
			/** The net of the `renameCaseProperties` commands people made after the reference. */
			readonly renamesSince: readonly CasePropertyRename[];
			/** The members who changed the app after the reference, by user id. */
			readonly actors: readonly string[];
	  }
	/** A later `blueprint-migration` row does not apply to the document at the reference. */
	| { readonly kind: "nova-updated" }
	/** The app moved to another Project after a person changed it and before a publish. */
	| { readonly kind: "app-moved" };

const EDITOR_KINDS: ReadonlySet<string> = new Set(EDITOR_APP_CHANGE_KINDS);

function headAhead(appId: string, novaRevision: number, seq: number): string {
	return `Nova was asked for the reference document of app ${appId} at revision ${novaRevision}, and the head it was handed is at ${seq}, before it. Pass the head read after the deployment's baseline, which no publish writes ahead of the app.`;
}

function foldBaselineInRange(appId: string, seq: number): string {
	return `App ${appId} holds a fold baseline at sequence ${seq}, after the revision its deployment's baseline describes. \`usablePair\` answers false for such a pair, so the caller answers \`unavailable\` before it asks for a reference document.`;
}

export async function loadReferenceDocument(input: {
	readonly appId: string;
	readonly novaRevision: number;
	readonly head: { readonly doc: BlueprintDoc; readonly seq: number };
}): Promise<ReferenceDocument> {
	const { appId, novaRevision, head } = input;
	if (head.seq === novaRevision)
		return {
			kind: "ok",
			doc: head.doc,
			identityDoc: head.doc,
			renamesSince: [],
			actors: [],
		};
	if (head.seq < novaRevision)
		throw new Error(headAhead(appId, novaRevision, head.seq));

	/* 1. The published document. */
	const db = await getAppDb();
	const published = await loadCanonicalBlueprintAtSequence(db, {
		appId,
		seq: novaRevision,
		expectedDigest: null,
	});

	/* 2. What a server wrote after it, and who changed the app. */
	const rows = (await readAppChangeStreamRowsSince(db, appId, novaRevision))
		.map((row) =>
			parsePersistedAppChangeEnvelope({
				seq: row.seq,
				batchId: row.batch_id,
				runId: row.run_id,
				actorId: row.actor_id,
				kind: row.kind,
				mutationsText: row.mutations_text,
				fromProjectId: row.from_project_id,
				toProjectId: row.to_project_id,
			}),
		)
		.filter((row) => row.seq <= head.seq);
	const folded = foldServerRows(appId, published.doc, rows);
	if (folded.kind !== "ok") return folded;

	/* 3. What a publish never sends, from the head. */
	const doc = withHeadUnsent(folded.doc, head.doc);
	return {
		kind: "ok",
		doc,
		identityDoc: withoutSecondOfASlug(doc, folded.doc),
		renamesSince: netRenames(rows),
		actors: actorsOf(rows),
	};
}

/** `doc` with `mutations` applied by the reducers alone, as a hold is replayed. */
function reduced(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

/** `doc` with `mutations` applied whole, or null where the batch does not apply to it. */
function appliedWhole(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc | null {
	try {
		const prepared = prepareMutationCandidate(
			doc,
			admitMutationBatch(mutations),
		);
		return preparedCandidateHasAdmissionIssue(prepared)
			? null
			: prepared.nextDoc;
	} catch {
		return null;
	}
}

function foldServerRows(
	appId: string,
	published: BlueprintDoc,
	rows: readonly AdmittedDurableAppChange[],
):
	| { readonly kind: "ok"; readonly doc: BlueprintDoc }
	| Exclude<ReferenceDocument, { kind: "ok" }> {
	let doc = published;
	let personBefore = false;
	for (const row of rows) {
		switch (row.kind) {
			case "publish-placement":
				// The reducer leaves a hold alone where its target is missing, so a
				// hold on something made after the publish is not carried.
				doc = reduced(doc, row.mutations);
				break;
			case "blueprint-migration": {
				const next = appliedWhole(doc, row.mutations);
				if (next === null) return { kind: "nova-updated" };
				doc = next;
				break;
			}
			case "project-move": {
				if (personBefore) return { kind: "app-moved" };
				if (row.mutations.length === 0) break;
				const next = appliedWhole(doc, row.mutations);
				if (next === null) return { kind: "app-moved" };
				doc = next;
				break;
			}
			case "fold-baseline":
				throw new Error(foldBaselineInRange(appId, row.seq));
			case "autosave":
			case "mcp":
			case "chat":
			case "hq-changes":
				personBefore = true;
				break;
		}
	}
	return { kind: "ok", doc };
}

/** A record of `doc`'s collection, or an empty one. */
function recordOf<T>(
	record: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
	return recordFromEntries(Object.entries(record ?? NO_ENTRIES));
}

/**
 * One collection of the worker setup: the head's entities in the head's
 * order, then those the published document held that the head no longer
 * does, in the published document's order. `keep` takes, from an entity
 * the published document also holds, what of the published one stands.
 */
function headThenPublished<T extends { readonly uuid: Uuid }>(input: {
	readonly head: Readonly<Record<string, T>> | undefined;
	readonly headOrder: readonly Uuid[] | undefined;
	readonly published: Readonly<Record<string, T>> | undefined;
	readonly publishedOrder: readonly Uuid[] | undefined;
	readonly keep?: (head: T, published: T) => T;
}): { readonly record: Record<string, T>; readonly order: Uuid[] } | null {
	const head = recordOf(input.head);
	const published = recordOf(input.published);
	const record = recordFromEntries<T>([]);
	const order: Uuid[] = [];
	for (const uuid of input.headOrder ?? []) {
		const own = head[uuid];
		if (own === undefined) continue;
		const was = published[uuid];
		record[uuid] =
			was !== undefined && input.keep !== undefined
				? input.keep(own, was)
				: own;
		order.push(uuid);
	}
	for (const uuid of input.publishedOrder ?? []) {
		if (Object.hasOwn(record, uuid)) continue;
		const was = published[uuid];
		if (was === undefined) continue;
		record[uuid] = was;
		order.push(uuid);
	}
	return order.length === 0 ? null : { record, order };
}

/**
 * The published document, with every server write after it, given what a
 * publish to this app never sends from the head: every kind no reading holds with its ordering
 * array; the worker properties, location properties and levels as the
 * head holds them, then those the published document held that the head
 * no longer does, each property under the slug the published document
 * gave it where it held it; where the app runs; and its logo.
 */
export function withHeadUnsent(
	folded: BlueprintDoc,
	head: BlueprintDoc,
): BlueprintDoc {
	const next: Partial<Record<keyof PersistableDoc, unknown>> = {
		...toPersistableDoc(folded),
	};
	const set = (key: keyof PersistableDoc, value: unknown) => {
		if (value === undefined) delete next[key];
		else next[key] = value;
	};
	for (const key of [
		"userTypes",
		"userTypeOrder",
		"personas",
		"personaOrder",
		"automations",
		"automationOrder",
		"logo",
	] as const)
		set(key, head[key]);

	const userProperties = headThenPublished({
		head: head.userProperties,
		headOrder: head.userPropertyOrder,
		published: folded.userProperties,
		publishedOrder: folded.userPropertyOrder,
		keep: (own, was) => ({ ...own, slug: was.slug }),
	});
	set("userProperties", userProperties?.record);
	set("userPropertyOrder", userProperties?.order);
	const locationProperties = headThenPublished({
		head: head.locationProperties,
		headOrder: head.locationPropertyOrder,
		published: folded.locationProperties,
		publishedOrder: folded.locationPropertyOrder,
		keep: (own, was) => ({ ...own, slug: was.slug }),
	});
	set("locationProperties", locationProperties?.record);
	set("locationPropertyOrder", locationProperties?.order);
	const levels = headThenPublished({
		head: head.organizationLevels,
		headOrder: head.organizationLevelOrder,
		published: folded.organizationLevels,
		publishedOrder: folded.organizationLevelOrder,
	});
	set("organizationLevels", levels?.record);
	set("organizationLevelOrder", levels?.order);

	const { runsOnlyOn: _published, ...settings } = folded.appSettings;
	next.appSettings =
		head.appSettings.runsOnlyOn === undefined
			? settings
			: { ...settings, runsOnlyOn: head.appSettings.runsOnlyOn };
	return hydratePersistedBlueprint(next as PersistableDoc);
}

/**
 * `doc` less every worker or location property the published document did
 * not hold whose slug a property it did hold carries in `doc`.
 */
function withoutSecondOfASlug(
	doc: BlueprintDoc,
	published: BlueprintDoc,
): BlueprintDoc {
	const second = (
		record: Readonly<Record<string, { readonly slug: string }>> | undefined,
		held: Readonly<Record<string, unknown>> | undefined,
	): Set<string> => {
		const heldSlugs = new Set(
			Object.entries(record ?? {})
				.filter(([uuid]) => held !== undefined && Object.hasOwn(held, uuid))
				.map(([, property]) => property.slug),
		);
		return new Set(
			Object.entries(record ?? {})
				.filter(
					([uuid, property]) =>
						!(held !== undefined && Object.hasOwn(held, uuid)) &&
						heldSlugs.has(property.slug),
				)
				.map(([uuid]) => uuid),
		);
	};
	const users = second(doc.userProperties, published.userProperties);
	const places = second(doc.locationProperties, published.locationProperties);
	if (users.size === 0 && places.size === 0) return doc;
	const next: Partial<Record<keyof PersistableDoc, unknown>> = {
		...toPersistableDoc(doc),
	};
	const drop = (
		recordKey: "userProperties" | "locationProperties",
		orderKey: "userPropertyOrder" | "locationPropertyOrder",
		out: ReadonlySet<string>,
	) => {
		if (out.size === 0) return;
		next[recordKey] = recordFromEntries(
			Object.entries(doc[recordKey] ?? NO_ENTRIES).filter(
				([uuid]) => !out.has(uuid),
			),
		);
		next[orderKey] = (doc[orderKey] ?? []).filter((uuid) => !out.has(uuid));
	};
	drop("userProperties", "userPropertyOrder", users);
	drop("locationProperties", "locationPropertyOrder", places);
	return hydratePersistedBlueprint(next as PersistableDoc);
}

/**
 * The `renameCaseProperties` commands of the editor rows folded in order: a
 * rename of a name an earlier rename gave continues that rename, so a rename
 * and its rename back cancel. Only the pairs whose two names differ are kept.
 */
function netRenames(
	rows: readonly AdmittedDurableAppChange[],
): readonly CasePropertyRename[] {
	const renames: { caseType: string; from: string; to: string }[] = [];
	for (const row of rows) {
		if (!EDITOR_KINDS.has(row.kind)) continue;
		for (const mutation of row.mutations) {
			if (mutation.kind !== "renameCaseProperties") continue;
			// One command renames simultaneously: each pair is matched against the
			// renames before the command, never against another pair of it.
			const before = renames.map((rename) => ({ ...rename }));
			for (const { caseType, from, to } of mutation.renames) {
				const at = before.findIndex(
					(rename) => rename.caseType === caseType && rename.to === from,
				);
				if (at >= 0) (renames[at] as { to: string }).to = to;
				else renames.push({ caseType, from, to });
			}
		}
	}
	return renames
		.filter((rename) => rename.from !== rename.to)
		.map(({ caseType, from, to }) => ({ caseType, from, to }));
}

/** Each member who made a person's change in the range, once, in the order of their first. */
function actorsOf(
	rows: readonly AdmittedDurableAppChange[],
): readonly string[] {
	const actors: string[] = [];
	for (const row of rows) {
		if (!EDITOR_KINDS.has(row.kind) && row.kind !== "hq-changes") continue;
		if (!actors.includes(row.actorId)) actors.push(row.actorId);
	}
	return actors;
}

/**
 * Whether a deployment's baseline and revision are a pair a comparison can
 * stand on: the baseline holds a source that still verifies (origin `push`,
 * `read` or `changes`), it names a revision, a `push` baseline's revision is
 * the live app mapping's `pushed_revision`, and the app has a fold baseline
 * at or before that revision (`foldSeq`, `greatestFoldBaselineSeq`'s answer).
 */
export function usablePair(
	baseline: AppBaseline | null,
	mapping: Pick<DeploymentResource, "pushedRevision"> | null,
	foldSeq: number | null,
): boolean {
	if (baseline === null) return false;
	if (
		baseline.origin !== "push" &&
		baseline.origin !== "read" &&
		baseline.origin !== "changes"
	)
		return false;
	const revision = baseline.novaRevision;
	if (revision === null) return false;
	if (
		baseline.origin === "push" &&
		(mapping === null || mapping.pushedRevision !== revision)
	)
		return false;
	return foldSeq !== null && revision >= foldSeq;
}
