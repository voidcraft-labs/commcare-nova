/**
 * The entities of the world an app runs in that a reading brings with it:
 * the project space's organization levels, and the worker and place
 * information its logic reads. Pure: each takes what was read and the
 * reading's identity resolver, and returns entities and findings. Beside
 * them, the reader's canonical choices over the same entities, each the
 * reading's own function run over what a document's export gives it.
 */

import {
	type BlueprintDoc,
	BUILT_IN_USER_PROPERTY_SLUGS,
	type LocationProperty,
	levelDescendantCases,
	levelOwnsCases,
	locationPropertySchema,
	type OrganizationLevel,
	organizationLevelSchema,
	type UserProperty,
	type Uuid,
	userPropertySchema,
} from "@/lib/domain";
import { USERCASE_BUILT_IN_KEYS } from "@/lib/domain/usercase";
import { circumstanceFinding, type Finding } from "@/lib/publish/hqFindings";
import type { HqLocationType } from "../hq/locations";
import { userPropertySlugVerdict } from "../validator/userPropertySlug";
import { withCandidate } from "./candidate";
import type { ExpressionReading } from "./expressions";
import {
	externalKey,
	type IdentityMapEntry,
	type IdentityResolver,
	matchingResolver,
} from "./identity";
import { sameJson } from "./jsonCursor";
import { whereText } from "./place";

const ORGANIZATION = { kind: "organization" } as const;
const APP = { kind: "app" } as const;

/** Whether a level's code and name are ones the document's level schema admits. */
function holdable(level: HqLocationType): boolean {
	return (
		organizationLevelSchema.shape.code.safeParse(level.code).success &&
		organizationLevelSchema.shape.name.safeParse(level.name).success
	);
}

/**
 * Every level CommCare HQ lists, as document levels, each parent before its
 * children and siblings in HQ's order. A level's case flow is read from the
 * two settings the API returns: it holds workers, owns cases where HQ shares
 * them, and reaches every place below where HQ views descendants. Its
 * address book is HQ's default. `administrative` is not read: HQ sets it from
 * CommTrack and reads `has_users`, which no API returns.
 *
 * A level whose code or name the document's schema refuses is the
 * circumstance `place-not-holdable` at the organization, named by the level,
 * and it and every level beneath it are left out, so the levels never hold
 * one the gate would refuse. So is a level whose parent is not in the list,
 * or whose chain of parents never reaches the top.
 */
export function levelsFromHq(
	levels: readonly HqLocationType[],
	resolver: IdentityResolver,
): {
	readonly levels: readonly OrganizationLevel[];
	readonly findings: readonly Finding[];
} {
	const byCode = new Map(levels.map((level) => [level.code, level]));
	const uuidOf = new Map<string, Uuid>();
	const refused = new Set<string>();
	const out: OrganizationLevel[] = [];
	const findings: Finding[] = [];
	const notHoldable = (level: HqLocationType) => {
		refused.add(level.code);
		findings.push(
			circumstanceFinding("place-not-holdable", ORGANIZATION, {
				name: level.name,
			}),
		);
	};
	for (const level of levels) if (!holdable(level)) notHoldable(level);

	let placed = true;
	while (placed) {
		placed = false;
		for (const level of levels) {
			if (uuidOf.has(level.code) || refused.has(level.code)) continue;
			const parent =
				level.parentCode === null ? undefined : uuidOf.get(level.parentCode);
			if (level.parentCode !== null && parent === undefined) continue;
			const claim = resolver.claim(
				externalKey.organizationLevel(level.code),
				whereText(ORGANIZATION),
			);
			if (!claim.ok) {
				notHoldable(level);
				continue;
			}
			uuidOf.set(level.code, claim.uuid);
			out.push({
				uuid: claim.uuid,
				code: level.code,
				name: level.name,
				...(parent === undefined ? {} : { parentLevelUuid: parent }),
				caseFlow: {
					workers: "assigned",
					ownsCases: level.sharesCases,
					descendantCases: level.viewDescendants
						? { kind: "all" }
						: { kind: "none" },
				},
				addressBook: { reach: "own-branch" },
			});
			placed = true;
		}
	}

	/* A level never placed stands under the finding of a refused level above
	 * it; one with no refused level above it (its parent is not listed, or
	 * its parents run in a circle) is a finding of its own. */
	const underRefused = (level: HqLocationType): boolean => {
		const seen = new Set<string>();
		for (
			let code = level.parentCode;
			code !== null && !seen.has(code);
			code = byCode.get(code)?.parentCode ?? null
		) {
			if (refused.has(code)) return true;
			seen.add(code);
		}
		return false;
	};
	for (const level of levels)
		if (
			!uuidOf.has(level.code) &&
			!refused.has(level.code) &&
			!underRefused(level)
		)
			notHoldable(level);
	return { levels: out, findings };
}

/** Whether a name read of the worker's own data is one a reading holds as a worker property: a
 *  slug Nova can hold and none CommCare supplies itself. */
export function holdsWorkerProperty(slug: string): boolean {
	return (
		!BUILT_IN_USER_PROPERTY_SLUGS.has(slug) &&
		userPropertySlugVerdict(slug, new Set()).ok &&
		userPropertySchema.shape.slug.safeParse(slug).success &&
		userPropertySchema.shape.label.safeParse(slug).success
	);
}

/**
 * Whether a write of the worker's record to `key` is one a reading holds, as the commit gate holds
 * such a write (`validator/rules/caseOperations.ts::validateWorkerRecordProperty`): a worker
 * property the reading declares (`holdsWorkerProperty`), and none of the keys CommCare HQ keeps in
 * step with the worker's profile (`USERCASE_BUILT_IN_KEYS`, which HQ's user-case sync writes over,
 * `callcenter/sync_usercase.py::_get_user_case_fields`). Every reader of such a write asks it where
 * it reads the key: `basicActions.ts::readUpdateMap` (`usercase_update`),
 * `advancedActions.ts::readProperties` (the worker's load) and `saveToCase.ts::refusedRowKey` (a
 * block of `commcare-user`).
 */
export function holdsWorkerRecordWrite(key: string): boolean {
	return !USERCASE_BUILT_IN_KEYS.includes(key) && holdsWorkerProperty(key);
}

/** Each distinct name of `names`, in code-unit order. */
function distinct(names: readonly string[]): readonly string[] {
	return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The worker properties and the location properties an app's logic reads,
 * from what the first pass over its expressions met: a worker property for
 * each name read of the worker's own data that is a slug Nova can hold and
 * none CommCare supplies itself, and a location property for each slug read
 * as a place's `location_data`. Each is labelled with its slug, has no
 * choices and is not required: CommCare HQ serves no definition of either
 * to an API key. Every other name is left out, and the second pass words
 * it. Each list is in the code-unit order of its slugs, whichever slot read
 * one first.
 */
export function worldEntitiesFromReads(
	worldReads: ExpressionReading["worldReads"],
	resolver: IdentityResolver,
): {
	readonly userProperties: readonly UserProperty[];
	readonly locationProperties: readonly LocationProperty[];
} {
	const userProperties: UserProperty[] = [];
	for (const slug of distinct(worldReads.userFields)) {
		if (!holdsWorkerProperty(slug)) continue;
		const claim = resolver.claim(
			externalKey.userProperty(slug),
			whereText(APP),
		);
		if (!claim.ok) continue;
		userProperties.push({ uuid: claim.uuid, slug, label: slug });
	}
	const locationProperties: LocationProperty[] = [];
	for (const slug of distinct(worldReads.locationDataSlugs)) {
		if (!locationPropertySchema.shape.slug.safeParse(slug).success) continue;
		if (!locationPropertySchema.shape.label.safeParse(slug).success) continue;
		const claim = resolver.claim(
			externalKey.locationProperty(slug),
			whereText(ORGANIZATION),
		);
		if (!claim.ok) continue;
		locationProperties.push({ uuid: claim.uuid, slug, label: slug });
	}
	return { userProperties, locationProperties };
}

// ── The reader's canonical choices over the world ────────────────────────

/** The levels CommCare HQ lists for `doc` once a publish has set them up: each level's code, name
 *  and parent's code, in the document's order, sharing cases where it owns them and viewing
 *  descendants where its workers' cases reach below. */
export function levelsAsPublished(doc: BlueprintDoc): HqLocationType[] {
	const levels = doc.organizationLevels ?? {};
	return (doc.organizationLevelOrder ?? []).flatMap((uuid) => {
		const level = levels[uuid];
		if (level === undefined) return [];
		return [
			{
				id: level.uuid,
				name: level.name,
				code: level.code,
				parentCode:
					level.parentLevelUuid === undefined
						? null
						: (levels[level.parentLevelUuid]?.code ?? null),
				administrative: false,
				sharesCases: levelOwnsCases(level),
				viewDescendants: levelDescendantCases(level).kind !== "none",
			},
		];
	});
}

/** A resolver that answers each of `doc`'s own levels, worker properties and location properties
 *  by its UUID, and mints the rest as a re-read of the app minted them. */
function heldResolver(doc: BlueprintDoc): IdentityResolver {
	const entries: IdentityMapEntry[] = [
		...Object.values(doc.organizationLevels ?? {}).map((one) => ({
			...externalKey.organizationLevel(one.code),
			uuid: one.uuid,
		})),
		...Object.values(doc.userProperties ?? {}).map((one) => ({
			...externalKey.userProperty(one.slug),
			uuid: one.uuid,
		})),
		...Object.values(doc.locationProperties ?? {}).map((one) => ({
			...externalKey.locationProperty(one.slug),
			uuid: one.uuid,
		})),
	];
	return matchingResolver(doc.appId, entries);
}

/**
 * `doc` with its levels as a reading gives them (`levelsFromHq` over `levelsAsPublished`): the
 * export carries no level, and a reading reads a level's code, name and parent, whether it shares
 * cases and whether it views descendants from CommCare HQ's list, so each level holds workers, its
 * descendant cases are all or none, its address book is its own branch, it has no description,
 * and the levels stand parent before child.
 */
export function levelsAsRead(doc: BlueprintDoc): BlueprintDoc {
	if (doc.organizationLevels === undefined) return doc;
	const { levels } = levelsFromHq(levelsAsPublished(doc), heldResolver(doc));
	if (sameJson(levels, orderedLevels(doc))) return doc;
	return withCandidate(doc, (draft) => {
		if (levels.length === 0) {
			delete draft.organizationLevels;
			delete draft.organizationLevelOrder;
			return;
		}
		draft.organizationLevels = Object.fromEntries(
			levels.map((level) => [level.uuid, level]),
		) as typeof draft.organizationLevels;
		draft.organizationLevelOrder = levels.map((level) => level.uuid);
	});
}

function orderedLevels(doc: BlueprintDoc): OrganizationLevel[] {
	return (doc.organizationLevelOrder ?? []).flatMap((uuid) => {
		const level = doc.organizationLevels?.[uuid];
		return level === undefined ? [] : [level];
	});
}

/** Whether a node of the document is a case operation that writes the worker's record. */
function isWorkerRecordOperation(node: Record<string, unknown>): boolean {
	const target = node.target as { kind?: unknown } | undefined;
	return (
		typeof node.action === "string" &&
		node.action !== "own" &&
		target?.kind === "worker-record" &&
		Array.isArray(node.writes)
	);
}

/** What `doc`'s logic reads of the worker and of places, as a reading meets it: each worker field
 *  by name, each worker property by its slug, and each location property by its slug. A read of
 *  a field CommCare HQ writes on every worker's own case is no worker field. */
function worldReadsOf(doc: BlueprintDoc): {
	readonly byName: readonly string[];
	readonly userFields: readonly string[];
	readonly locationDataSlugs: readonly string[];
} {
	const byName: string[] = [];
	const userFields: string[] = [];
	const locationDataSlugs: string[] = [];
	const worker = (slug: string, source: unknown, named: boolean) => {
		if (source === "worker-record" && USERCASE_BUILT_IN_KEYS.includes(slug))
			return;
		userFields.push(slug);
		if (named) byName.push(slug);
	};
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const node = value as Record<string, unknown>;
		if (node.kind === "session-user" && typeof node.field === "string")
			worker(node.field, node.source, true);
		else if (node.kind === "user-ref" && typeof node.property === "string")
			worker(node.property, "worker-record", true);
		else if (
			node.kind === "session-user-property" ||
			node.kind === "user-property-ref"
		) {
			const held = doc.userProperties?.[node.userPropertyUuid as Uuid];
			if (held !== undefined)
				worker(
					held.slug,
					node.kind === "user-property-ref" ? "worker-record" : node.source,
					false,
				);
		} else if (
			// A write of the worker's record saves to a worker property the app
			// declares (`caseManagement/index.ts::workerRecordWriteSlugs`).
			isWorkerRecordOperation(node)
		) {
			for (const write of node.writes as readonly { property?: unknown }[])
				if (typeof write.property === "string")
					worker(write.property, "worker-record", false);
		} else if (node.kind === "location-field") {
			const field = node.field as { property?: Uuid } | undefined;
			const held =
				field?.property === undefined
					? undefined
					: doc.locationProperties?.[field.property];
			if (held !== undefined) locationDataSlugs.push(held.slug);
		}
		for (const item of Object.values(node)) walk(item);
	};
	walk([doc.modules, doc.forms, doc.fields]);
	return { byName, userFields, locationDataSlugs };
}

/**
 * `doc` with a worker property for each field its logic reads by name that no property of its
 * names: the name-backed read and the read of a property of that slug print one source, and a
 * reading mints the property, labelled with its slug, under the UUID a re-read of the app gives
 * it, which is none the document's own properties hold (`identity.ts::freeEntityUuid`: a
 * property renamed from that slug keeps the UUID the slug mints). The reads themselves are
 * judged slot by slot, as every expression is.
 */
export function namedWorkerReadsAreProperties(doc: BlueprintDoc): BlueprintDoc {
	const held = new Set(
		Object.values(doc.userProperties ?? {}).map((one) => one.slug),
	);
	const minted = distinct(worldReadsOf(doc).byName).filter(
		(slug) => !held.has(slug) && holdsWorkerProperty(slug),
	);
	if (minted.length === 0) return doc;
	const resolver = heldResolver(doc);
	return withCandidate(doc, (draft) => {
		const properties = { ...(draft.userProperties ?? {}) };
		const order = [...(draft.userPropertyOrder ?? [])];
		for (const slug of minted) {
			const claim = resolver.claim(
				externalKey.userProperty(slug),
				whereText(APP),
			);
			if (!claim.ok) continue;
			const uuid = claim.uuid;
			properties[uuid] = { uuid, slug, label: slug };
			order.push(uuid);
		}
		draft.userProperties = properties as typeof draft.userProperties;
		draft.userPropertyOrder = order;
	});
}

/**
 * `doc` with its worker and location properties as a reading gives them
 * (`worldEntitiesFromReads` over what its logic reads): no export carries a property, only the
 * slug a read prints, so each property its logic reads is labelled with its slug and has no
 * choices and no requirement, one nothing reads is absent, and they stand in the order of their
 * slugs.
 */
export function worldPropertiesAsRead(doc: BlueprintDoc): BlueprintDoc {
	const { userFields, locationDataSlugs } = worldReadsOf(doc);
	const { userProperties, locationProperties } = worldEntitiesFromReads(
		{ userFields, locationDataSlugs },
		heldResolver(doc),
	);
	const same = <T extends { readonly uuid: Uuid }>(
		read: readonly T[],
		record: Record<Uuid, T> | undefined,
		order: readonly Uuid[] | undefined,
	) =>
		sameJson(
			read,
			(order ?? []).map((uuid) => record?.[uuid]),
		);
	if (
		same(userProperties, doc.userProperties, doc.userPropertyOrder) &&
		same(locationProperties, doc.locationProperties, doc.locationPropertyOrder)
	)
		return doc;
	return withCandidate(doc, (draft) => {
		delete draft.userProperties;
		delete draft.userPropertyOrder;
		delete draft.locationProperties;
		delete draft.locationPropertyOrder;
		if (userProperties.length > 0) {
			draft.userProperties = Object.fromEntries(
				userProperties.map((one) => [one.uuid, one]),
			) as BlueprintDoc["userProperties"];
			draft.userPropertyOrder = userProperties.map((one) => one.uuid);
		}
		if (locationProperties.length > 0) {
			draft.locationProperties = Object.fromEntries(
				locationProperties.map((one) => [one.uuid, one]),
			) as BlueprintDoc["locationProperties"];
			draft.locationPropertyOrder = locationProperties.map((one) => one.uuid);
		}
	});
}
