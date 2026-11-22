import { produce } from "immer";
import { z } from "zod";
import type { AdmittedDurableAppChange } from "@/lib/db/persistedJson";
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
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
	type Uuid,
} from "@/lib/domain";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import type { CasePropertyRename } from "@/lib/publish/hqChangesKinds";
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

export function foldBaselineInRange(appId: string, seq: number): string {
	return `The comparison for app ${appId} changed at fold ${seq}. Read the deployment’s current published revision and fold binding again.`;
}

/** What survives a schema conversion. The worker setup is overlaid only when a
 * comparison needs it. An editor row can have an empty visible effect while
 * still making a subsequent Project move unavailable. */
export type FoldedDeploymentReference =
	| {
			readonly kind: "ok";
			readonly doc: BlueprintDoc;
			readonly projectId: string;
			readonly editorBefore: boolean;
			readonly renamesSince: readonly CasePropertyRename[];
			readonly actors: readonly string[];
	  }
	| Exclude<ReferenceDocument, { kind: "ok" }>;

export const storedReferenceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("ok"),
		doc: blueprintDocSchema,
		projectId: z.string().min(1),
		editorBefore: z.boolean(),
		actors: z.array(z.string().min(1)),
		renamesSince: z.array(
			z.strictObject({
				caseType: z.string(),
				from: z.string(),
				to: z.string(),
			}),
		),
	}),
	z.strictObject({ kind: z.literal("nova-updated") }),
	z.strictObject({ kind: z.literal("app-moved") }),
]);

export function projectDeploymentReference(
	folded: FoldedDeploymentReference,
	head: BlueprintDoc,
): ReferenceDocument {
	if (folded.kind !== "ok") return folded;
	const doc = withHeadUnsent(folded.doc, head);
	return {
		kind: "ok",
		doc,
		identityDoc: withoutSecondOfASlug(doc, folded.doc),
		renamesSince: folded.renamesSince,
		actors: folded.actors,
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

export function foldServerRows(
	appId: string,
	prior: Extract<FoldedDeploymentReference, { kind: "ok" }>,
	rows: readonly AdmittedDurableAppChange[],
): FoldedDeploymentReference {
	let { doc, projectId, editorBefore } = prior;
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
				if (row.fromProjectId !== projectId)
					throw new Error(
						"A Project move does not start in the published app’s Project.",
					);
				if (editorBefore) return { kind: "app-moved" };
				projectId = row.toProjectId;
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
				editorBefore = true;
				break;
		}
	}
	return {
		kind: "ok",
		doc,
		projectId,
		editorBefore,
		actors: actorsOf(rows, prior.actors),
		renamesSince: netRenames(rows, prior.renamesSince),
	};
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
	prior: readonly CasePropertyRename[],
): readonly CasePropertyRename[] {
	const renames = prior.map((rename) => ({ ...rename }));
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
	prior: readonly string[],
): readonly string[] {
	const actors = [...prior];
	for (const row of rows) {
		if (!EDITOR_KINDS.has(row.kind) && row.kind !== "hq-changes") continue;
		if (!actors.includes(row.actorId)) actors.push(row.actorId);
	}
	return actors;
}
