/**
 * The pure half of the one-off repair for an app whose worker reads the gate
 * now refuses. Two checker rules came in together:
 *
 * - `undeclared-worker-field`: a read, from the session and by name
 *   (`session-user` with no source), of a worker field that is neither a key
 *   CommCare gives every worker nor a worker property the app declares;
 * - `worker-property-read-by-name`: a read by name, from the session or from
 *   the worker's record (`session-user` with `source: "worker-record"`, a
 *   form's `#user/<x>`, which a prose `user-ref` part lowers to), of a slug
 *   the app declares.
 *
 * For each field of the first kind the repair declares a worker property, as
 * a reading of an app from CommCare HQ gives one to a field the app reads
 * (`lib/commcare/reader/worldEntities.ts::worldEntitiesFromReads`):
 * `{ uuid, slug, label: slug }`, not required, no choices.
 * The uuid is derived from the app and the slug, so a dry run and its
 * execution, or a second run, name the same property. Every read by name of a
 * declared slug, declared before or by the repair, from either source, is then
 * rebound to the property's identity: an expression's `session-user` becomes
 * `session-user-property` with the same source, and a prose `user-ref` part
 * becomes `user-property-ref`. Each prints the path its name-backed twin
 * printed (`instance('commcaresession')/session/user/data/<slug>` or
 * `#user/<slug>`), so every export of the app stays the same bytes, which
 * `verifyUndeclaredWorkerFieldRepair` checks with the production emitters
 * before a script may write.
 *
 * The declaration and the rebind are the live planners'
 * (`lib/doc/userMutations.ts::addUserPropertyMutations` and
 * `rebindWorkerReadsByName`), which the builder and the tools run when worker
 * information takes a name a read already uses, so the repair and a later
 * edit rebind one way. They rewrite a translation that was current before
 * the repair the same way as its source and keep it current; one that was
 * already out of date cannot be rewritten by a batch the gate admits, so an
 * app holding a read in one is refused. The census is one walk of the whole
 * persisted document, which reaches every place a read is stored, so a read
 * the planners did not reach refuses the app rather than going unseen.
 *
 * Every refusal here is content-free: it names a reason, never a field name,
 * a label, an expression or any other content of the app.
 */

import AdmZip from "adm-zip";
import { produce } from "immer";
import { v5 as uuidv5 } from "uuid";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	identityLookupWireNaming,
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { userPropertySlugVerdict } from "@/lib/doc/identifierVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	addUserPropertyMutations,
	rebindWorkerReadsByName,
} from "@/lib/doc/userMutations";
import {
	type BlueprintDoc,
	BUILT_IN_USER_PROPERTY_SLUGS,
	collectTranslationUnits,
	type PersistableDoc,
	type UserProperty,
	userPropertySchema,
} from "@/lib/domain";
import { translationSourceFingerprintsEqual } from "@/lib/domain/localization";
import type { Uuid } from "@/lib/domain/uuid";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/** The UUIDv5 namespace of the worker properties this repair declares. */
export const UNDECLARED_WORKER_FIELD_NAMESPACE_UUID =
	"6f1d2c8e-5b7a-4c39-9e21-3a8f0b4d7c55";

const UNDECLARED_WORKER_FIELD_VERSION = "nova-undeclared-worker-field-v1";

/** The worker property the repair declares for `slug` in app `appId`. */
export function undeclaredWorkerFieldPropertyUuid(
	appId: string,
	slug: string,
): Uuid {
	return uuidv5(
		JSON.stringify([UNDECLARED_WORKER_FIELD_VERSION, appId, slug]),
		UNDECLARED_WORKER_FIELD_NAMESPACE_UUID,
	) as Uuid;
}

/** Why a repair cannot be planned or proved. Each is content-free. */
export type UndeclaredWorkerFieldRefusalReason =
	/** Two worker properties of the app hold one slug a read names. */
	| "slug-declared-twice"
	/** The field's name is not a worker property slug Nova admits (its
	 *  grammar, a reserved name, its length). */
	| "slug-not-declarable"
	/** The field's name differs only in capitalization from a slug the app
	 *  declares or another field the repair declares; CommCare treats the two
	 *  as one name. */
	| "slug-collides"
	/** The derived uuid already names another entity of the app. */
	| "uuid-taken"
	/** A translation that is out of date holds a read the repair rebinds; the
	 *  gate admits no write of an out-of-date translation. */
	| "stale-translation-read"
	/** A read the repair rebinds survived the rewrite. */
	| "read-not-rebound"
	/** The repaired document fails the production commit gate. */
	| "gate-refused"
	/** The repaired document cannot be reached by a deterministic batch. */
	| "replay-differs"
	/** An export of the repaired document differs from the original's. */
	| "export-changed";

export class UndeclaredWorkerFieldRefusal extends Error {
	readonly name = "UndeclaredWorkerFieldRefusal";
	constructor(
		readonly reason: UndeclaredWorkerFieldRefusalReason,
		/** Finding codes, for `gate-refused`: codes only, never messages. */
		readonly codes: readonly string[] = [],
	) {
		super(
			codes.length === 0
				? `The repair was refused: ${reason}.`
				: `The repair was refused: ${reason} (${codes.join(", ")}).`,
		);
	}
}

/** One worker read by name: an expression leaf or a prose part. */
interface NamedWorkerRead {
	readonly name: string;
	/** From the session (no source) or from the worker's record. */
	readonly fromSession: boolean;
}

function namedWorkerRead(
	node: Record<string, unknown>,
): NamedWorkerRead | undefined {
	if (node.kind === "session-user" && typeof node.field === "string")
		return { name: node.field, fromSession: node.source === undefined };
	if (node.kind === "user-ref" && typeof node.property === "string")
		return { name: node.property, fromSession: false };
	return undefined;
}

/** Visit every object of `value`, depth first, with the holder and key that
 *  reach it, so a visitor may replace it. */
function visitObjects(
	value: unknown,
	visit: (
		node: Record<string, unknown>,
		holder: Record<string, unknown> | unknown[],
		key: string | number,
	) => boolean,
): void {
	const descend = (
		node: unknown,
		holder: Record<string, unknown> | unknown[],
		key: string | number,
	): void => {
		if (typeof node !== "object" || node === null) return;
		if (Array.isArray(node)) {
			node.forEach((item, index) => {
				descend(item, node, index);
			});
			return;
		}
		const record = node as Record<string, unknown>;
		if (visit(record, holder, key)) return;
		for (const [childKey, child] of Object.entries(record))
			descend(child, record, childKey);
	};
	descend(value, [value], 0);
}

function declaredSlugs(doc: PersistableDoc): Set<string> {
	return new Set(
		Object.values(doc.userProperties ?? {}).map((property) => property.slug),
	);
}

function codeUnitOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** What the repair would change in `doc`, found by one walk of the whole
 *  persisted document. */
export interface WorkerFieldReadCensus {
	/** Custom fields read from the session by name and not declared, each
	 *  once, in code-unit order: the reads `undeclared-worker-field` refuses. */
	readonly undeclared: readonly string[];
	/** How many reads by name, from either source, name a declared slug: the
	 *  reads `worker-property-read-by-name` refuses. */
	readonly declaredReadByName: number;
}

export function workerFieldReadCensus(
	doc: PersistableDoc,
): WorkerFieldReadCensus {
	const declared = declaredSlugs(doc);
	const undeclared = new Set<string>();
	let declaredReadByName = 0;
	visitObjects(doc, (node) => {
		const read = namedWorkerRead(node);
		if (read === undefined) return false;
		if (declared.has(read.name)) declaredReadByName += 1;
		else if (read.fromSession && !BUILT_IN_USER_PROPERTY_SLUGS.has(read.name))
			undeclared.add(read.name);
		return true;
	});
	return {
		undeclared: [...undeclared].sort(codeUnitOrder),
		declaredReadByName,
	};
}

/** Whether `doc` holds a read the gate's two worker rules refuse, which is
 *  what the repair is for. The read-only scan and the migrate both ask this,
 *  so they cannot disagree about which apps need it. */
export function needsWorkerFieldRepair(doc: PersistableDoc): boolean {
	const census = workerFieldReadCensus(doc);
	return census.undeclared.length > 0 || census.declaredReadByName > 0;
}

export interface UndeclaredWorkerFieldRepair {
	/** The repaired document. */
	readonly target: PersistableDoc;
	/** The slugs the repair declares, in the order it appends them. */
	readonly declaredSlugs: readonly string[];
	/** How many reads by name it rebinds to a property's identity. */
	readonly reboundReads: number;
	/** How many current translations it rewrites and keeps current. */
	readonly translationsKeptCurrent: number;
}

/**
 * Declare a worker property for each custom field `before` reads from the
 * session by name and does not declare, and rebind every read by name of a
 * declared slug to its property. A document with nothing to repair comes back
 * unchanged, with nothing declared and nothing rebound.
 */
export function repairUndeclaredWorkerFields(
	before: PersistableDoc,
): UndeclaredWorkerFieldRepair {
	const census = workerFieldReadCensus(before);
	if (census.undeclared.length === 0 && census.declaredReadByName === 0)
		return {
			target: structuredClone(before),
			declaredSlugs: [],
			reboundReads: 0,
			translationsKeptCurrent: 0,
		};

	const bySlug = new Map<string, Uuid>();
	const twice = new Set<string>();
	for (const uuid of before.userPropertyOrder ?? []) {
		const property = before.userProperties?.[uuid];
		if (property === undefined) continue;
		if (bySlug.has(property.slug)) twice.add(property.slug);
		bySlug.set(property.slug, property.uuid);
	}

	const taken = authoredUuids(before);
	const claimed = new Set(bySlug.keys());
	const declared: UserProperty[] = [];
	for (const slug of census.undeclared) {
		const verdict = userPropertySlugVerdict(slug, claimed);
		if (!verdict.ok)
			throw new UndeclaredWorkerFieldRefusal(
				verdict.code === "duplicate" ? "slug-collides" : "slug-not-declarable",
			);
		const property = userPropertySchema.safeParse({
			uuid: undeclaredWorkerFieldPropertyUuid(before.appId, slug),
			slug,
			label: slug,
		});
		if (!property.success)
			throw new UndeclaredWorkerFieldRefusal("slug-not-declarable");
		if (taken.has(property.data.uuid))
			throw new UndeclaredWorkerFieldRefusal("uuid-taken");
		declared.push(property.data);
		claimed.add(slug);
		bySlug.set(slug, property.data.uuid);
	}

	/* A translation's currency is read from the document before any rewrite:
	 * one current then is rewritten with its source and kept current; one out
	 * of date then holds no read the repair rebinds. */
	const beforeDoc = hydratePersistedBlueprint(before);
	const unitsBefore = new Map(
		collectTranslationUnits(beforeDoc).map((unit) => [unit.id, unit]),
	);
	const staleEntries = new Set<object>();
	for (const entries of Object.values(before.localization?.translations ?? {}))
		for (const [unitId, entry] of Object.entries(entries)) {
			const unit = unitsBefore.get(unitId);
			if (
				unit === undefined ||
				!translationSourceFingerprintsEqual(
					entry.sourceFingerprint,
					unit.sourceFingerprint,
				)
			)
				staleEntries.add(entry);
		}

	let reboundReads = 0;
	let staleRead = false;
	visitObjects(before, (node) => {
		if (staleEntries.has(node)) {
			/* An out-of-date translation is left as it is: a read in it that
			 * the repair would rebind refuses the app. */
			visitObjects(node.value, (inner) => {
				const read = namedWorkerRead(inner);
				if (read !== undefined && bySlug.has(read.name)) staleRead = true;
				return read !== undefined;
			});
			return true;
		}
		const read = namedWorkerRead(node);
		if (read === undefined) return false;
		if (!bySlug.has(read.name)) return true;
		if (twice.has(read.name))
			throw new UndeclaredWorkerFieldRefusal("slug-declared-twice");
		reboundReads += 1;
		return true;
	});
	if (staleRead)
		throw new UndeclaredWorkerFieldRefusal("stale-translation-read");

	/* The rebind is the live planners': declaring a property rebinds every
	 * read by name of its slug in the same batch, as the builder and the tools
	 * do, and a slug the app already declared has its reads rebound the same
	 * way. Each step applies before the next is planned, so two slugs read in
	 * one text are rewritten one after the other. */
	let doc = beforeDoc;
	const step = (mutations: readonly Mutation[]): void => {
		doc = produce(doc, (draft) => {
			applyMutations(draft, [...mutations]);
		});
	};
	const declaredSlugSet = new Set(declared.map((property) => property.slug));
	for (const [slug, uuid] of bySlug)
		if (!declaredSlugSet.has(slug) && !twice.has(slug))
			step(rebindWorkerReadsByName(doc, slug, uuid));
	for (const { uuid, ...property } of declared)
		step(addUserPropertyMutations(doc, uuid, property));
	const target = toPersistableDoc(doc);
	let translationsKeptCurrent = 0;
	for (const [language, entries] of Object.entries(
		target.localization?.translations ?? {},
	))
		for (const [unitId, entry] of Object.entries(entries)) {
			const prior = before.localization?.translations[language]?.[unitId];
			if (
				prior !== undefined &&
				!translationSourceFingerprintsEqual(
					entry.sourceFingerprint,
					prior.sourceFingerprint,
				)
			)
				translationsKeptCurrent += 1;
		}

	if (needsWorkerFieldRepair(target))
		throw new UndeclaredWorkerFieldRefusal("read-not-rebound");
	return {
		target,
		declaredSlugs: declared.map((property) => property.slug),
		reboundReads,
		translationsKeptCurrent,
	};
}

/** Every uuid a top-level or nested entity of `doc` holds, so a derived
 *  property uuid cannot collapse into another identity. */
function authoredUuids(doc: PersistableDoc): Set<string> {
	const uuids = new Set<string>();
	visitObjects(doc, (node) => {
		if (typeof node.uuid === "string") uuids.add(node.uuid);
		return false;
	});
	return uuids;
}

/** The deployment the archive comparison compiles for. Both documents are
 *  compiled for the same one, so where it points changes no comparison. */
const COMPARISON_TARGET: RuntimeTarget = {
	server: "production",
	domain: "nova-repair-check",
	appId: "nova-repair-check",
};

/** Every artifact the production emitters make of `doc`: the HQ import file
 *  (`hq.json`) and each entry of a `.ccz`, by path. */
export function exportArtifacts(
	doc: BlueprintDoc,
	naming: LookupWireNaming,
): Map<string, Buffer> {
	const artifacts = new Map<string, Buffer>();
	artifacts.set(
		"hq.json",
		Buffer.from(JSON.stringify(expandDoc(doc, { lookupNaming: naming }))),
	);
	const archive = compileCcz(
		expandDoc(doc, { runtimeTarget: COMPARISON_TARGET, lookupNaming: naming }),
		doc.appName,
		doc,
		{
			runtimeTarget: COMPARISON_TARGET,
			lookup: {
				naming,
				fixtures: { fixtures: [], totalRows: 0, totalCells: 0, totalBytes: 0 },
			},
		},
	);
	for (const entry of new AdmZip(archive).getEntries())
		artifacts.set(`ccz/${entry.entryName}`, entry.getData());
	return artifacts;
}

function sameArtifacts(
	before: ReadonlyMap<string, Buffer>,
	after: ReadonlyMap<string, Buffer>,
): boolean {
	if (before.size !== after.size) return false;
	for (const [path, bytes] of before) {
		const other = after.get(path);
		if (other === undefined || !bytes.equals(other)) return false;
	}
	return true;
}

export interface UndeclaredWorkerFieldProof {
	/** How many artifacts were compared byte for byte. */
	readonly artifacts: number;
}

/**
 * Prove a planned repair before anything is written: the batch that reaches
 * the target from `before` passes the production commit gate with no finding
 * and replays to exactly the target, and every export of the target is the
 * same bytes as the export of `before`. Throws a content-free refusal.
 */
export function verifyUndeclaredWorkerFieldRepair(
	before: PersistableDoc,
	repair: UndeclaredWorkerFieldRepair,
	lookupContext: LookupValidationContext,
): UndeclaredWorkerFieldProof {
	const beforeDoc = hydratePersistedBlueprint(before);
	const targetDoc = hydratePersistedBlueprint(repair.target);
	const verdict = mutationCommitVerdict(
		beforeDoc,
		diffDocsToMutations(beforeDoc, targetDoc),
		lookupContext,
	);
	if (!verdict.ok)
		throw new UndeclaredWorkerFieldRefusal(
			"gate-refused",
			[...new Set(verdict.findings.map((finding) => finding.code))].sort(),
		);
	if (
		canonicalJsonDigest(toPersistableDoc(verdict.nextDoc)) !==
		canonicalJsonDigest(repair.target)
	)
		throw new UndeclaredWorkerFieldRefusal("replay-differs");

	const naming =
		lookupContext.kind === "available"
			? lookupWireNaming(lookupContext.definitions)
			: identityLookupWireNaming();
	const beforeArtifacts = exportArtifacts(beforeDoc, naming);
	const afterArtifacts = exportArtifacts(targetDoc, naming);
	if (!sameArtifacts(beforeArtifacts, afterArtifacts))
		throw new UndeclaredWorkerFieldRefusal("export-changed");
	return { artifacts: beforeArtifacts.size };
}
