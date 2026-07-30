/**
 * Frozen data transform for the canonical authored-identity cutover.
 *
 * This file describes the pre-cutover JSON already stored in production. It
 * must not import steady-state schemas, reducers, or convenience converters:
 * later product changes may not change what this historical migration means.
 * The timestamped migration, advisory scanner, and rehearsal tests all call
 * this same transform.
 */

import { createHash } from "node:crypto";
import {
	type FrozenCatalogXPathExpression,
	parseFrozenCatalogXPath,
	printFrozenCatalogXPath,
} from "./frozenCatalogXPath";
import {
	type FrozenEntitySurface,
	frozenEntityOccurrencesFor,
} from "./frozenOccurrenceManifest";
import {
	type FrozenXPathExpression,
	type FrozenXPathPart,
	parseFrozenXPathExpression,
} from "./frozenXPathExpression";

export const CANONICAL_IDENTITY_MIGRATION_VERSION =
	"20260728000000-canonical-identity-v1";

/**
 * One-shot UUIDv5 namespace for the exact historical select-option
 * pseudo-identities. This value and the SHA-1 implementation below are frozen
 * migration protocol: changing either remaps persisted identities.
 */
export const LEGACY_OPTION_UUID_NAMESPACE =
	"44f7e0cf-2896-4b28-a4e9-ac621746eb0a";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASHTAG = /#([A-Za-z_][A-Za-z0-9_-]*)(\/[A-Za-z_][A-Za-z0-9_-]*)+/g;

const BUILTIN_USER_PROPERTIES = new Set([
	"user_type",
	"commcare_project",
	"commcare_first_name",
	"commcare_last_name",
	"commcare_phone_number",
	"commcare_user_type",
	"commcare_profile",
	"commcare_location_id",
	"commcare_location_ids",
	"commcare_primary_case_sharing_id",
]);

const MODULE_BUILTIN_ICON_REFS = new Set(
	[
		"household",
		"community",
		"patient",
		"chw_staff",
		"maternal_health",
		"child_health",
		"newborn_care",
		"immunization",
		"nutrition",
		"growth_monitoring",
		"family_planning",
		"hiv",
		"tuberculosis",
		"malaria",
		"disease_surveillance",
		"mental_health",
		"substance_use",
		"oral_health",
		"eye_care",
		"facility",
		"bed_capacity",
		"pharmacy_stock",
		"medications",
		"lab",
		"diagnostics",
		"screening",
		"referrals",
		"appointments",
		"vital_events",
		"education",
		"tasks",
		"alerts",
		"reports",
		"default",
	].map((slug) => `nova-icon:${slug}`),
);

const FORM_BUILTIN_ICON_REFS = new Set(
	[
		"register",
		"update",
		"follow_up",
		"record_vitals",
		"screen_assess",
		"administer",
		"collect_sample",
		"counsel",
		"schedule",
		"refer",
		"consent",
		"checklist",
		"close_case",
		"default",
	].map((slug) => `nova-icon:${slug}`),
);

export function isCanonicalAuthoredUuid(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

export function isCanonicalLookupUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_V7.test(value);
}

export type LegacyEntityKind =
	| "module"
	| "form"
	| "field"
	| "user_property"
	| "user_type"
	| "persona";

export interface LegacyEntityRow {
	readonly appId: string;
	readonly uuid: string;
	readonly kind: LegacyEntityKind;
	readonly parentUuid: string | null;
	readonly ordinal: number;
	readonly data: Record<string, unknown>;
}

export interface LegacyAppSnapshot {
	readonly appId: string;
	readonly appName: string;
	readonly connectType: string | null;
	readonly caseTypes: unknown;
	readonly logo: string | null;
	readonly mutationSeq: string | number;
	readonly rows: readonly LegacyEntityRow[];
}

export type CanonicalIdentityFindingCode =
	| "invalid-authored-uuid"
	| "invalid-lookup-uuid"
	| "record-key-mismatch"
	| "authored-uuid-collision"
	| "unresolved-reference"
	| "ambiguous-reference"
	| "hidden-reference"
	| "noncanonical-absolute-path"
	| "noncanonical-select-source"
	| "noncanonical-prose"
	| "noncanonical-xpath"
	| "invalid-topology"
	| "invalid-legacy-shape"
	| "invalid-fold-baseline"
	| "post-horizon-replay-mismatch";

export interface CanonicalIdentityFinding {
	readonly code: CanonicalIdentityFindingCode;
	/** Structural path only. Never contains authored text or display names. */
	readonly path: string;
	/** Stable digest of the rejected value; never the value itself. */
	readonly digest: string;
}

export interface CanonicalIdentityRewriteCounts {
	proseTemplates: number;
	xpathExpressions: number;
	pathRefs: number;
	rawRefs: number;
	searchInputRefs: number;
	selectSources: number;
	optionUuids: number;
}

export interface CanonicalAppPlan {
	readonly appId: string;
	readonly rows: readonly LegacyEntityRow[];
	readonly caseTypes: unknown;
	readonly findings: readonly CanonicalIdentityFinding[];
	readonly rewrites: CanonicalIdentityRewriteCounts;
	readonly beforeDigest: string;
	readonly afterDigest: string;
}

type JsonRecord = Record<string, unknown>;
type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	switch (typeof value) {
		case "string":
		case "boolean":
		case "number":
			return JSON.stringify(value);
		case "object":
			return `{${Object.entries(value as JsonRecord)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
				.join(",")}}`;
		default:
			return JSON.stringify(null);
	}
}

export function canonicalIdentityDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function emptyRewriteCounts(): CanonicalIdentityRewriteCounts {
	return {
		proseTemplates: 0,
		xpathExpressions: 0,
		pathRefs: 0,
		rawRefs: 0,
		searchInputRefs: 0,
		selectSources: 0,
		optionUuids: 0,
	};
}

interface MutablePlanContext {
	readonly appId: string;
	readonly findings: CanonicalIdentityFinding[];
	readonly rewrites: CanonicalIdentityRewriteCounts;
	readonly rowsByUuid: Map<string, LegacyEntityRow>;
	readonly fieldForm: Map<string, string>;
	readonly formModule: Map<string, string>;
	readonly fieldUuidByFormPath: Map<string, Map<string, string>>;
	readonly fieldPathByUuid: Map<string, readonly string[]>;
	readonly userPropertyBySlug: Map<string, string[]>;
	readonly userPropertySlugByUuid: Map<string, string>;
	readonly searchInputByModuleName: Map<string, Map<string, string[]>>;
	readonly caseTypeParent: Map<string, string | undefined>;
}

function finding(
	ctx: MutablePlanContext,
	code: CanonicalIdentityFindingCode,
	path: string,
	value: unknown,
): void {
	ctx.findings.push({ code, path, digest: canonicalIdentityDigest(value) });
}

function assertUuid(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): value is string {
	if (typeof value === "string" && UUID.test(value)) return true;
	finding(ctx, "invalid-authored-uuid", path, value);
	return false;
}

function assertLookupUuid(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): value is string {
	if (typeof value === "string" && UUID_V7.test(value)) return true;
	finding(ctx, "invalid-lookup-uuid", path, value);
	return false;
}

function uuidBytes(uuid: string): Buffer {
	return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function formatUuid(bytes: Buffer): string {
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
		12,
		16,
	)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Genuine RFC 9562 UUIDv5: SHA-1(namespace bytes || exact UTF-8 name), first
 * 128 bits, version and variant bits stamped. Kept local so a dependency
 * upgrade can never change this historical mapping.
 */
export function legacyOptionUuidV5(legacyIdentity: string): string {
	const digest = createHash("sha1")
		.update(uuidBytes(LEGACY_OPTION_UUID_NAMESPACE))
		.update(Buffer.from(legacyIdentity, "utf8"))
		.digest()
		.subarray(0, 16);
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	return formatUuid(digest);
}

function topologyGroupKey(row: LegacyEntityRow): string {
	if (
		row.kind === "module" ||
		row.kind === "user_property" ||
		row.kind === "user_type" ||
		row.kind === "persona"
	) {
		return `root:${row.kind}`;
	}
	return `${row.parentUuid ?? "null"}:${row.kind}`;
}

function validateTopology(
	ctx: MutablePlanContext,
	rows: readonly LegacyEntityRow[],
): void {
	const uuidCounts = new Map<string, number>();
	for (const row of rows) {
		uuidCounts.set(row.uuid, (uuidCounts.get(row.uuid) ?? 0) + 1);
	}
	for (const [uuid, count] of uuidCounts) {
		if (count > 1) {
			finding(ctx, "invalid-topology", `entities.${uuid}.duplicate-row`, {
				uuid,
				count,
			});
		}
	}

	const ordinalsByGroup = new Map<
		string,
		Array<{ ordinal: number; uuid: string }>
	>();
	for (const row of rows) {
		const path = `entities.${row.kind}.${row.uuid}`;
		const expectsNullParent =
			row.kind === "module" ||
			row.kind === "user_property" ||
			row.kind === "user_type" ||
			row.kind === "persona";
		if (expectsNullParent) {
			if (row.parentUuid !== null) {
				finding(ctx, "invalid-topology", `${path}.parent_uuid`, row.parentUuid);
			}
		} else if (row.parentUuid === null) {
			finding(ctx, "invalid-topology", `${path}.parent_uuid`, null);
		} else {
			const parent = ctx.rowsByUuid.get(row.parentUuid);
			const validFormParent = row.kind === "form" && parent?.kind === "module";
			const validFieldParent =
				row.kind === "field" &&
				(parent?.kind === "form" ||
					(parent?.kind === "field" &&
						(parent.data.kind === "group" || parent.data.kind === "repeat")));
			if (!validFormParent && !validFieldParent) {
				finding(ctx, "invalid-topology", `${path}.parent_uuid`, {
					parentUuid: row.parentUuid,
					parentKind: parent?.kind,
					parentFieldKind:
						parent?.kind === "field" ? parent.data.kind : undefined,
				});
			}
		}
		if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0) {
			finding(ctx, "invalid-topology", `${path}.ordinal`, row.ordinal);
			continue;
		}
		const groupKey = topologyGroupKey(row);
		const members = ordinalsByGroup.get(groupKey) ?? [];
		members.push({ ordinal: row.ordinal, uuid: row.uuid });
		ordinalsByGroup.set(groupKey, members);
	}

	for (const [group, members] of ordinalsByGroup) {
		const sorted = [...members].sort(
			(left, right) =>
				left.ordinal - right.ordinal || left.uuid.localeCompare(right.uuid),
		);
		for (const [index, member] of sorted.entries()) {
			if (member.ordinal !== index) {
				finding(ctx, "invalid-topology", `membership.${group}.${member.uuid}`, {
					expectedOrdinal: index,
					actualOrdinal: member.ordinal,
				});
			}
		}
	}

	for (const row of rows) {
		if (row.kind !== "field") continue;
		const visited = new Set<string>();
		let current: LegacyEntityRow | undefined = row;
		while (current?.kind === "field") {
			if (visited.has(current.uuid)) {
				finding(ctx, "invalid-topology", `entities.field.${row.uuid}.cycle`, [
					...visited,
					current.uuid,
				]);
				break;
			}
			visited.add(current.uuid);
			current =
				current.parentUuid === null
					? undefined
					: ctx.rowsByUuid.get(current.parentUuid);
		}
	}
}

function walkFieldPath(
	fieldUuid: string,
	rowsByUuid: ReadonlyMap<string, LegacyEntityRow>,
): { formUuid?: string; path: string[] } {
	const path: string[] = [];
	const visited = new Set<string>();
	let current = rowsByUuid.get(fieldUuid);
	while (current?.kind === "field" && !visited.has(current.uuid)) {
		visited.add(current.uuid);
		const id = current.data.id;
		if (typeof id === "string") path.unshift(id);
		if (current.parentUuid === null) return { path };
		const parent = rowsByUuid.get(current.parentUuid);
		if (parent?.kind === "form") {
			return { formUuid: parent.uuid, path };
		}
		current = parent;
	}
	return { path };
}

function buildContext(
	app: LegacyAppSnapshot,
	rows: LegacyEntityRow[],
	caseTypes: unknown,
): MutablePlanContext {
	const ctx: MutablePlanContext = {
		appId: app.appId,
		findings: [],
		rewrites: emptyRewriteCounts(),
		rowsByUuid: new Map(rows.map((row) => [row.uuid, row])),
		fieldForm: new Map(),
		formModule: new Map(),
		fieldUuidByFormPath: new Map(),
		fieldPathByUuid: new Map(),
		userPropertyBySlug: new Map(),
		userPropertySlugByUuid: new Map(),
		searchInputByModuleName: new Map(),
		caseTypeParent: new Map(),
	};

	for (const row of rows) {
		if (!assertUuid(ctx, row.uuid, `entities.${row.kind}.${row.uuid}.uuid`)) {
			continue;
		}
		if (
			!assertUuid(
				ctx,
				row.data.uuid,
				`entities.${row.kind}.${row.uuid}.data.uuid`,
			)
		) {
			continue;
		}
		if (row.uuid !== row.data.uuid) {
			finding(ctx, "record-key-mismatch", `entities.${row.kind}.${row.uuid}`, {
				key: row.uuid,
				embedded: row.data.uuid,
			});
		}
		if (row.kind === "form" && row.parentUuid !== null) {
			ctx.formModule.set(row.uuid, row.parentUuid);
		}
		if (row.kind === "user_property") {
			const slug = row.data.slug;
			if (typeof slug === "string") {
				const values = ctx.userPropertyBySlug.get(slug) ?? [];
				values.push(row.uuid);
				ctx.userPropertyBySlug.set(slug, values);
				ctx.userPropertySlugByUuid.set(row.uuid, slug);
			}
		}
		if (row.kind === "module") {
			const config = isRecord(row.data.caseListConfig)
				? row.data.caseListConfig
				: undefined;
			const inputs = Array.isArray(config?.searchInputs)
				? config.searchInputs
				: [];
			const byName = new Map<string, string[]>();
			for (const [index, input] of inputs.entries()) {
				if (!isRecord(input)) continue;
				const uuid = input.uuid;
				const name = input.name;
				assertUuid(
					ctx,
					uuid,
					`entities.module.${row.uuid}.caseListConfig.searchInputs[${index}].uuid`,
				);
				if (typeof name === "string" && typeof uuid === "string") {
					const matches = byName.get(name) ?? [];
					matches.push(uuid);
					byName.set(name, matches);
				}
			}
			ctx.searchInputByModuleName.set(row.uuid, byName);
		}
	}

	for (const row of rows) {
		if (row.kind !== "field") continue;
		const located = walkFieldPath(row.uuid, ctx.rowsByUuid);
		if (located.formUuid === undefined) continue;
		ctx.fieldForm.set(row.uuid, located.formUuid);
		const paths =
			ctx.fieldUuidByFormPath.get(located.formUuid) ??
			new Map<string, string>();
		const key = located.path.join("/");
		ctx.fieldPathByUuid.set(row.uuid, located.path);
		if (paths.has(key)) {
			finding(
				ctx,
				"ambiguous-reference",
				`forms.${located.formUuid}.fieldPath.${canonicalIdentityDigest(key)}`,
				key,
			);
		} else {
			paths.set(key, row.uuid);
		}
		ctx.fieldUuidByFormPath.set(located.formUuid, paths);
	}

	if (Array.isArray(caseTypes)) {
		for (const value of caseTypes) {
			if (!isRecord(value) || typeof value.name !== "string") continue;
			ctx.caseTypeParent.set(
				value.name,
				typeof value.parent_type === "string" ? value.parent_type : undefined,
			);
		}
	}
	return ctx;
}

function owningFormUuid(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
): string | undefined {
	if (row.kind === "form") return row.uuid;
	if (row.kind === "field") return ctx.fieldForm.get(row.uuid);
	return undefined;
}

function owningModuleUuid(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
): string | undefined {
	if (row.kind === "module") return row.uuid;
	const formUuid = owningFormUuid(ctx, row);
	return formUuid === undefined ? undefined : ctx.formModule.get(formUuid);
}

function contextualCaseType(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	segments: readonly string[],
): { caseType: string; property: string } | undefined {
	const moduleUuid = owningModuleUuid(ctx, row);
	const module = moduleUuid && ctx.rowsByUuid.get(moduleUuid);
	let caseType =
		module && typeof module.data.caseType === "string"
			? module.data.caseType
			: undefined;
	if (caseType === undefined) return undefined;
	const remaining = [...segments];
	while (remaining[0] === "parent") {
		caseType = ctx.caseTypeParent.get(caseType);
		remaining.shift();
		if (caseType === undefined) return undefined;
	}
	if (remaining.length !== 1) return undefined;
	return { caseType, property: remaining[0] };
}

function classifyLegacyReference(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	namespace: string,
	segments: readonly string[],
	path: string,
	recordFinding = true,
): JsonRecord | undefined {
	const rejected = (
		code: "unresolved-reference" | "ambiguous-reference",
	): undefined => {
		if (recordFinding) finding(ctx, code, path, { namespace, segments });
		return undefined;
	};
	if (namespace === "form") {
		const formUuid = owningFormUuid(ctx, row);
		const uuid =
			formUuid === undefined
				? undefined
				: ctx.fieldUuidByFormPath.get(formUuid)?.get(segments.join("/"));
		if (uuid !== undefined) return { kind: "field-ref", uuid };
		return rejected("unresolved-reference");
	}
	if (namespace === "user") {
		if (segments.length !== 1) {
			return rejected("unresolved-reference");
		}
		const property = segments[0];
		const custom = ctx.userPropertyBySlug.get(property) ?? [];
		if (custom.length === 1) {
			return { kind: "user-property-ref", userPropertyUuid: custom[0] };
		}
		if (custom.length > 1) {
			return rejected("ambiguous-reference");
		}
		// An unmatched XPath user property is an external session/wire name.
		// Custom Nova worker information is the exact-UUID arm above.
		return { kind: "user-ref", property };
	}
	if (namespace === "case") {
		const contextual = contextualCaseType(ctx, row, segments);
		if (contextual !== undefined) return { kind: "case-ref", ...contextual };
		return rejected("unresolved-reference");
	}
	if (segments.length !== 1 || !ctx.caseTypeParent.has(namespace)) {
		return rejected("unresolved-reference");
	}
	return { kind: "case-ref", caseType: namespace, property: segments[0] };
}

function proseParts(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	value: string,
	path: string,
	allowFieldReference = true,
): JsonValue[] | undefined {
	const parts: JsonValue[] = [];
	let cursor = 0;
	for (const match of value.matchAll(HASHTAG)) {
		const start = match.index;
		if (start === undefined) continue;
		if (start > cursor) {
			parts.push({ kind: "text", text: value.slice(cursor, start) });
		}
		const source = match[0];
		const [namespace, ...segments] = source.slice(1).split("/");
		const part = classifyLegacyReference(
			ctx,
			row,
			namespace,
			segments,
			`${path}.parts[${parts.length}]`,
		);
		if (!allowFieldReference && part?.kind === "field-ref") {
			finding(ctx, "unresolved-reference", path, source);
			return undefined;
		}
		if (
			part?.kind === "user-ref" &&
			(typeof part.property !== "string" ||
				!BUILTIN_USER_PROPERTIES.has(part.property))
		) {
			finding(ctx, "unresolved-reference", path, source);
			return undefined;
		}
		if (part === undefined) return undefined;
		parts.push(part as JsonValue);
		cursor = start + source.length;
	}
	if (cursor < value.length) {
		parts.push({ kind: "text", text: value.slice(cursor) });
	}
	return parts;
}

function convertProse(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	value: unknown,
	path: string,
	allowFieldReference = true,
): unknown {
	if (typeof value === "string") {
		const parts = proseParts(ctx, row, value, path, allowFieldReference);
		if (parts === undefined) return value;
		ctx.rewrites.proseTemplates++;
		return { parts };
	}
	if (isRecord(value) && Array.isArray(value.parts)) {
		let previousText = false;
		for (const [index, part] of value.parts.entries()) {
			if (!isRecord(part) || typeof part.kind !== "string") {
				finding(ctx, "noncanonical-prose", `${path}.parts[${index}]`, part);
				continue;
			}
			if (part.kind === "text") {
				if (
					typeof part.text !== "string" ||
					part.text.length === 0 ||
					previousText
				) {
					finding(ctx, "noncanonical-prose", `${path}.parts[${index}]`, part);
				}
				previousText = true;
			} else if (part.kind === "field-ref") {
				assertUuid(ctx, part.uuid, `${path}.parts[${index}].uuid`);
				previousText = false;
			} else if (part.kind === "user-property-ref") {
				assertUuid(
					ctx,
					part.userPropertyUuid,
					`${path}.parts[${index}].userPropertyUuid`,
				);
				previousText = false;
			} else if (part.kind === "case-ref") {
				if (
					typeof part.caseType !== "string" ||
					part.caseType.length === 0 ||
					typeof part.property !== "string" ||
					part.property.length === 0
				) {
					finding(ctx, "noncanonical-prose", `${path}.parts[${index}]`, part);
				}
				previousText = false;
			} else if (part.kind === "user-ref") {
				if (
					typeof part.property !== "string" ||
					!BUILTIN_USER_PROPERTIES.has(part.property)
				) {
					finding(ctx, "noncanonical-prose", `${path}.parts[${index}]`, part);
				}
				previousText = false;
			} else {
				finding(ctx, "noncanonical-prose", `${path}.parts[${index}]`, part);
				previousText = false;
			}
		}
		return value;
	}
	finding(ctx, "noncanonical-prose", path, value);
	return value;
}

function legacyXPathPartSource(
	ctx: MutablePlanContext,
	part: unknown,
	path: string,
): string | undefined {
	if (!isRecord(part) || typeof part.kind !== "string") {
		finding(ctx, "noncanonical-xpath", path, part);
		return undefined;
	}
	switch (part.kind) {
		case "text":
			if (typeof part.text === "string") return part.text;
			break;
		case "raw-ref":
			if (
				typeof part.namespace === "string" &&
				Array.isArray(part.segments) &&
				part.segments.length > 0 &&
				part.segments.every((segment) => typeof segment === "string")
			) {
				return `#${part.namespace}/${part.segments.join("/")}`;
			}
			break;
		case "field-ref": {
			if (!assertUuid(ctx, part.uuid, `${path}.uuid`)) return undefined;
			const segments = ctx.fieldPathByUuid.get(part.uuid);
			if (segments !== undefined) return `#form/${segments.join("/")}`;
			finding(ctx, "unresolved-reference", path, part);
			return undefined;
		}
		case "path-ref": {
			if (!assertUuid(ctx, part.uuid, `${path}.uuid`)) return undefined;
			if (
				part.seps !== undefined &&
				(!Array.isArray(part.seps) ||
					part.seps.some((separator) => separator !== "/"))
			) {
				finding(ctx, "noncanonical-absolute-path", path, part);
				return undefined;
			}
			const segments = ctx.fieldPathByUuid.get(part.uuid);
			if (segments !== undefined) return `/data/${segments.join("/")}`;
			finding(ctx, "unresolved-reference", path, part);
			return undefined;
		}
		case "case-ref":
			if (
				typeof part.caseType === "string" &&
				typeof part.property === "string"
			) {
				return `#${part.caseType}/${part.property}`;
			}
			break;
		case "user-ref":
			if (typeof part.property === "string" && part.property.length > 0) {
				return `#user/${part.property}`;
			}
			break;
		case "user-property-ref": {
			if (!assertUuid(ctx, part.userPropertyUuid, `${path}.userPropertyUuid`)) {
				return undefined;
			}
			const slug = ctx.userPropertySlugByUuid.get(part.userPropertyUuid);
			if (slug !== undefined) return `#user/${slug}`;
			finding(ctx, "unresolved-reference", path, part);
			return undefined;
		}
	}
	finding(ctx, "noncanonical-xpath", path, part);
	return undefined;
}

function legacyXPathSource(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): string | undefined {
	if (typeof value === "string") return value;
	if (!isRecord(value) || !Array.isArray(value.parts)) {
		finding(ctx, "noncanonical-xpath", path, value);
		return undefined;
	}
	let source = "";
	for (const [index, part] of value.parts.entries()) {
		const text = legacyXPathPartSource(ctx, part, `${path}.parts[${index}]`);
		if (text === undefined) return undefined;
		source += text;
	}
	return source;
}

function countLegacyXPathParts(value: unknown): {
	pathRefs: number;
	rawRefs: number;
} {
	if (!isRecord(value) || !Array.isArray(value.parts)) {
		return { pathRefs: 0, rawRefs: 0 };
	}
	let pathRefs = 0;
	let rawRefs = 0;
	for (const part of value.parts) {
		if (!isRecord(part)) continue;
		if (part.kind === "path-ref") pathRefs++;
		if (part.kind === "raw-ref") rawRefs++;
	}
	return { pathRefs, rawRefs };
}

function convertXPath(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	value: unknown,
	path: string,
): unknown {
	const source = legacyXPathSource(ctx, value, path);
	if (source === undefined) return value;
	const formUuid = owningFormUuid(ctx, row);
	const parsed = parseFrozenXPathExpression(source, {
		hashtag(namespace, segments) {
			return classifyLegacyReference(
				ctx,
				row,
				namespace,
				segments,
				path,
				false,
			) as Exclude<FrozenXPathPart, { kind: "text" | "path-ref" }> | undefined;
		},
		dataPath(segments) {
			return formUuid === undefined
				? undefined
				: ctx.fieldUuidByFormPath.get(formUuid)?.get(segments.join("/"));
		},
	});
	if (parsed.issues.length > 0) {
		for (const issue of parsed.issues) {
			finding(
				ctx,
				issue.code === "syntax" ? "noncanonical-xpath" : "unresolved-reference",
				path,
				issue,
			);
		}
		return value;
	}
	const legacyCounts = countLegacyXPathParts(value);
	ctx.rewrites.pathRefs += legacyCounts.pathRefs;
	ctx.rewrites.rawRefs += legacyCounts.rawRefs;
	if (typeof value === "string") ctx.rewrites.xpathExpressions++;
	return parsed.expression satisfies FrozenXPathExpression;
}

function asFrozenCatalogExpression(
	value: unknown,
): FrozenCatalogXPathExpression | undefined {
	if (!isRecord(value) || !Array.isArray(value.parts)) return undefined;
	const parts: Array<
		| { readonly kind: "text"; readonly text: string }
		| {
				readonly kind: "case-ref";
				readonly caseType: string;
				readonly property: string;
		  }
	> = [];
	for (const part of value.parts) {
		if (!isRecord(part)) return undefined;
		if (part.kind === "text" && typeof part.text === "string") {
			parts.push({ kind: "text", text: part.text });
			continue;
		}
		if (
			part.kind === "case-ref" &&
			typeof part.caseType === "string" &&
			typeof part.property === "string"
		) {
			parts.push({
				kind: "case-ref",
				caseType: part.caseType,
				property: part.property,
			});
			continue;
		}
		return undefined;
	}
	return { parts };
}

function convertCatalogXPath(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
	caseType: string,
): unknown {
	if (typeof value === "string") {
		const parsed = parseFrozenCatalogXPath(value, caseType);
		if (parsed.issues.length > 0) {
			for (const issue of parsed.issues) {
				finding(
					ctx,
					issue.code === "illegal-reference"
						? "hidden-reference"
						: "noncanonical-xpath",
					path,
					issue,
				);
			}
			return value;
		}
		ctx.rewrites.xpathExpressions++;
		return parsed.expression;
	}

	const expression = asFrozenCatalogExpression(value);
	if (expression === undefined) {
		finding(ctx, "noncanonical-xpath", path, value);
		return value;
	}
	const source = printFrozenCatalogXPath(expression);
	const parsed = parseFrozenCatalogXPath(source, caseType);
	if (
		parsed.issues.length > 0 ||
		JSON.stringify(parsed.expression) !== JSON.stringify(expression)
	) {
		finding(ctx, "noncanonical-xpath", path, {
			issues: parsed.issues,
			expression,
		});
	}
	return value;
}

function transformPredicate(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
	moduleUuid: string | undefined,
): void {
	if (Array.isArray(value)) {
		value.forEach((child, index) => {
			transformPredicate(ctx, child, `${path}[${index}]`, moduleUuid);
		});
		return;
	}
	if (!isRecord(value)) return;
	if (value.kind === "input") {
		if (typeof value.name === "string") {
			if (value.searchInputUuid !== undefined) {
				finding(ctx, "invalid-legacy-shape", path, value);
			} else {
				const matches =
					moduleUuid === undefined
						? []
						: (ctx.searchInputByModuleName.get(moduleUuid)?.get(value.name) ??
							[]);
				if (matches.length !== 1) {
					finding(
						ctx,
						matches.length === 0
							? "unresolved-reference"
							: "ambiguous-reference",
						path,
						value,
					);
				} else {
					delete value.name;
					value.searchInputUuid = matches[0];
					ctx.rewrites.searchInputRefs++;
				}
			}
		} else {
			assertUuid(ctx, value.searchInputUuid, `${path}.searchInputUuid`);
		}
	}
	if (value.kind === "field") {
		assertUuid(ctx, value.uuid, `${path}.uuid`);
	}
	if (value.kind === "session-user-property") {
		assertUuid(ctx, value.userPropertyUuid, `${path}.userPropertyUuid`);
	}
	if (value.kind === "id-of") {
		assertUuid(ctx, value.opUuid, `${path}.opUuid`);
	}
	if (value.kind === "table-column") {
		assertLookupUuid(ctx, value.tableId, `${path}.tableId`);
		assertLookupUuid(ctx, value.columnId, `${path}.columnId`);
	}
	if (value.kind === "table-lookup") {
		assertLookupUuid(ctx, value.tableId, `${path}.tableId`);
		assertLookupUuid(ctx, value.resultColumnId, `${path}.resultColumnId`);
	}
	for (const [key, child] of Object.entries(value)) {
		transformPredicate(ctx, child, `${path}.${key}`, moduleUuid);
	}
}

function rewriteAtPath(
	root: JsonRecord,
	path: readonly string[],
	rewrite: (value: unknown, path: string) => unknown,
	basePath: string,
): void {
	const [head, ...rest] = path;
	if (head === undefined) return;
	const fanout = head.endsWith("[]");
	const key = fanout ? head.slice(0, -2) : head;
	const value = root[key];
	if (fanout) {
		if (!Array.isArray(value)) return;
		for (const [index, child] of value.entries()) {
			if (rest.length === 0) {
				value[index] = rewrite(child, `${basePath}.${key}[${index}]`);
			} else if (isRecord(child)) {
				rewriteAtPath(child, rest, rewrite, `${basePath}.${key}[${index}]`);
			}
		}
		return;
	}
	if (rest.length > 0) {
		if (isRecord(value)) {
			rewriteAtPath(value, rest, rewrite, `${basePath}.${key}`);
		}
		return;
	}
	if (value !== undefined) root[key] = rewrite(value, `${basePath}.${key}`);
}

function validateEntityReference(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): unknown {
	if (typeof value === "string") {
		assertUuid(ctx, value, path);
		return value;
	}
	if (!isRecord(value) || typeof value.kind !== "string") {
		finding(ctx, "invalid-legacy-shape", path, value);
		return value;
	}
	if (value.kind === "module") {
		assertUuid(ctx, value.moduleUuid, `${path}.moduleUuid`);
		return value;
	}
	if (value.kind === "form") {
		assertUuid(ctx, value.moduleUuid, `${path}.moduleUuid`);
		assertUuid(ctx, value.formUuid, `${path}.formUuid`);
		return value;
	}
	finding(ctx, "invalid-legacy-shape", path, value);
	return value;
}

function validateMediaOccurrence(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	value: unknown,
	path: string,
): unknown {
	if (typeof value === "string") {
		const isIconSlot =
			path.endsWith(".icon") && (row.kind === "module" || row.kind === "form");
		if (isIconSlot) {
			const catalog =
				row.kind === "form" ? FORM_BUILTIN_ICON_REFS : MODULE_BUILTIN_ICON_REFS;
			if (catalog.has(value) || isCanonicalAuthoredUuid(value)) return value;
			finding(ctx, "invalid-authored-uuid", path, value);
			return value;
		}
		assertUuid(ctx, value, path);
		return value;
	}
	if (!isRecord(value)) {
		finding(ctx, "invalid-legacy-shape", path, value);
		return value;
	}
	const allowed = new Set(["image", "audio", "video"]);
	for (const [key, assetId] of Object.entries(value)) {
		if (!allowed.has(key)) {
			finding(ctx, "invalid-legacy-shape", `${path}.${key}`, assetId);
			continue;
		}
		assertUuid(ctx, assetId, `${path}.${key}`);
	}
	return value;
}

function transformOccurrence(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	surface: FrozenEntitySurface,
	value: unknown,
	path: string,
	moduleUuid: string | undefined,
): unknown {
	switch (surface) {
		case "xpath-ast":
			return convertXPath(ctx, row, value, path);
		case "prose":
			return convertProse(ctx, row, value, path);
		case "predicate-ast":
			transformPredicate(ctx, value, path, moduleUuid);
			return value;
		case "identity":
			assertUuid(ctx, value, path);
			return value;
		case "entity-uuid":
			return validateEntityReference(ctx, value, path);
		case "media":
			return validateMediaOccurrence(ctx, row, value, path);
		case "lookup-carrier":
		case "case-property-ref":
		case "case-type-ref":
			return value;
	}
}

function transformSelect(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	basePath: string,
): void {
	const field = row.data;
	if (field.kind !== "single_select" && field.kind !== "multi_select") return;
	const legacyOptions = Array.isArray(field.options)
		? field.options
		: undefined;
	const legacySource = isRecord(field.optionsSource)
		? field.optionsSource
		: undefined;
	let source: JsonRecord | undefined;
	if (legacySource?.kind === "lookup-table") {
		assertLookupUuid(
			ctx,
			legacySource.tableId,
			`${basePath}.optionsSource.tableId`,
		);
		assertLookupUuid(
			ctx,
			legacySource.valueColumnId,
			`${basePath}.optionsSource.valueColumnId`,
		);
		assertLookupUuid(
			ctx,
			legacySource.labelColumnId,
			`${basePath}.optionsSource.labelColumnId`,
		);
		source = {
			...legacySource,
			kind: "lookup",
		};
		ctx.rewrites.selectSources++;
	} else if (legacySource?.kind === "lookup") {
		assertLookupUuid(
			ctx,
			legacySource.tableId,
			`${basePath}.optionsSource.tableId`,
		);
		assertLookupUuid(
			ctx,
			legacySource.valueColumnId,
			`${basePath}.optionsSource.valueColumnId`,
		);
		assertLookupUuid(
			ctx,
			legacySource.labelColumnId,
			`${basePath}.optionsSource.labelColumnId`,
		);
		source = legacySource;
	} else if (legacySource?.kind === "inline") {
		source = legacySource;
	} else if (legacySource !== undefined) {
		finding(
			ctx,
			"noncanonical-select-source",
			`${basePath}.optionsSource`,
			legacySource,
		);
	}

	if (source === undefined) {
		if (legacyOptions === undefined || legacyOptions.length < 2) {
			finding(ctx, "noncanonical-select-source", basePath, {
				options: legacyOptions,
				optionsSource: legacySource,
			});
			return;
		}
		source = { kind: "inline", options: legacyOptions };
		ctx.rewrites.selectSources++;
	}
	delete field.options;
	field.optionsSource = source;

	if (source.kind !== "inline" || !Array.isArray(source.options)) return;
	if (source.options.length < 2) {
		finding(
			ctx,
			"noncanonical-select-source",
			`${basePath}.optionsSource`,
			source,
		);
		return;
	}
	for (const [index, option] of source.options.entries()) {
		if (!isRecord(option)) {
			finding(
				ctx,
				"noncanonical-select-source",
				`${basePath}.optionsSource.options[${index}]`,
				option,
			);
			continue;
		}
		/*
		 * The pre-cutover hydration backfill minted exactly this closed
		 * non-UUID format. It was derived from the option's current owner and
		 * array position, so no independent identity is lost by replacing it
		 * with the frozen deterministic UUID projection. A different
		 * noncanonical string is not accepted as equivalent.
		 */
		const legacyPositionUuid = `${row.uuid}-opt-${index}`;
		if (option.uuid === legacyPositionUuid) {
			option.uuid = legacyOptionUuidV5(legacyPositionUuid);
			ctx.rewrites.optionUuids++;
		} else {
			assertUuid(
				ctx,
				option.uuid,
				`${basePath}.optionsSource.options[${index}].uuid`,
			);
		}
		option.label = convertProse(
			ctx,
			row,
			option.label,
			`${basePath}.optionsSource.options[${index}].label`,
		);
	}
}

function transformEntity(ctx: MutablePlanContext, row: LegacyEntityRow): void {
	const basePath = `entities.${row.kind}.${row.uuid}`;
	const moduleUuid = owningModuleUuid(ctx, row);
	if (row.kind === "field") transformSelect(ctx, row, basePath);

	for (const occurrence of frozenEntityOccurrencesFor(row.kind)) {
		if (occurrence.path === "uuid") continue;
		rewriteAtPath(
			row.data,
			occurrence.path.split("."),
			(value, at) =>
				transformOccurrence(
					ctx,
					row,
					occurrence.surface,
					value,
					at,
					moduleUuid,
				),
			basePath,
		);
	}

	if (row.kind === "user_type" || row.kind === "persona") {
		const values = row.data.values;
		if (values !== undefined) {
			if (!isRecord(values)) {
				finding(ctx, "invalid-legacy-shape", `${basePath}.values`, values);
			} else {
				for (const key of Object.keys(values)) {
					assertUuid(
						ctx,
						key,
						`${basePath}.values.${canonicalIdentityDigest(key)}`,
					);
				}
			}
		}
	}
}

function transformCaseTypes(ctx: MutablePlanContext, value: unknown): unknown {
	if (value === null) return null;
	if (!Array.isArray(value)) {
		finding(ctx, "invalid-legacy-shape", "apps.case_types", value);
		return value;
	}
	const syntheticRow: LegacyEntityRow = {
		appId: ctx.appId,
		uuid: "00000000-0000-1000-8000-000000000000",
		kind: "module",
		parentUuid: null,
		ordinal: 0,
		data: {},
	};
	for (const [caseIndex, caseType] of value.entries()) {
		if (
			!isRecord(caseType) ||
			typeof caseType.name !== "string" ||
			!Array.isArray(caseType.properties)
		) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`apps.case_types[${caseIndex}]`,
				caseType,
			);
			continue;
		}
		for (const [propertyIndex, property] of caseType.properties.entries()) {
			if (!isRecord(property)) continue;
			const path = `apps.case_types[${caseIndex}].properties[${propertyIndex}]`;
			for (const key of ["label", "hint", "validation_msg"] as const) {
				if (property[key] !== undefined) {
					property[key] = convertProse(
						ctx,
						syntheticRow,
						property[key],
						`${path}.${key}`,
						false,
					);
				}
			}
			for (const key of ["required", "validation"] as const) {
				if (property[key] !== undefined) {
					property[key] = convertCatalogXPath(
						ctx,
						property[key],
						`${path}.${key}`,
						caseType.name,
					);
				}
			}
			if (Array.isArray(property.options)) {
				for (const [optionIndex, option] of property.options.entries()) {
					if (!isRecord(option)) continue;
					option.label = convertProse(
						ctx,
						syntheticRow,
						option.label,
						`${path}.options[${optionIndex}].label`,
						false,
					);
				}
			}
		}
	}
	return value;
}

function collectNestedIdentities(
	ctx: MutablePlanContext,
	rows: readonly LegacyEntityRow[],
): void {
	const seen = new Map<string, string>();
	const add = (uuid: unknown, path: string): void => {
		if (!assertUuid(ctx, uuid, path) || typeof uuid !== "string") return;
		const previous = seen.get(uuid);
		if (previous !== undefined && previous !== path) {
			finding(ctx, "authored-uuid-collision", path, { uuid, previous });
			return;
		}
		seen.set(uuid, path);
	};
	for (const row of rows) {
		add(row.uuid, `entities.${row.kind}.${row.uuid}`);
		const basePath = `entities.${row.kind}.${row.uuid}`;
		for (const occurrence of frozenEntityOccurrencesFor(row.kind, "identity")) {
			if (occurrence.path === "uuid") continue;
			rewriteAtPath(
				row.data,
				occurrence.path.split("."),
				(value, path) => {
					add(value, path);
					return value;
				},
				basePath,
			);
		}
	}
}

export function planCanonicalAppMigration(
	input: LegacyAppSnapshot,
): CanonicalAppPlan {
	const rows = cloneJson(input.rows) as LegacyEntityRow[];
	const caseTypes = cloneJson(input.caseTypes);
	const beforeDigest = canonicalIdentityDigest({
		appId: input.appId,
		appName: input.appName,
		connectType: input.connectType,
		caseTypes: input.caseTypes,
		logo: input.logo,
		mutationSeq: input.mutationSeq,
		rows: input.rows,
	});
	const ctx = buildContext(input, rows, caseTypes);
	if (input.logo !== null) {
		assertUuid(ctx, input.logo, "apps.logo");
	}
	validateTopology(ctx, rows);
	for (const row of rows) transformEntity(ctx, row);
	const nextCaseTypes = transformCaseTypes(ctx, caseTypes);
	collectNestedIdentities(ctx, rows);
	const afterDigest = canonicalIdentityDigest({
		appId: input.appId,
		appName: input.appName,
		connectType: input.connectType,
		caseTypes: nextCaseTypes,
		logo: input.logo,
		mutationSeq: input.mutationSeq,
		rows,
	});
	return {
		appId: input.appId,
		rows,
		caseTypes: nextCaseTypes,
		findings: ctx.findings.sort(
			(left, right) =>
				left.path.localeCompare(right.path) ||
				left.code.localeCompare(right.code),
		),
		rewrites: ctx.rewrites,
		beforeDigest,
		afterDigest,
	};
}

export interface LookupIdentitySnapshot {
	readonly tables: readonly {
		readonly projectId: string;
		readonly id: string;
	}[];
	readonly columns: readonly {
		readonly projectId: string;
		readonly tableId: string;
		readonly id: string;
	}[];
	readonly rows: readonly {
		readonly projectId: string;
		readonly tableId: string;
		readonly id: string;
		readonly values: Record<string, unknown>;
	}[];
}

export function scanLookupIdentities(
	snapshot: LookupIdentitySnapshot,
): CanonicalIdentityFinding[] {
	const findings: CanonicalIdentityFinding[] = [];
	const tableIds = new Set(snapshot.tables.map((table) => table.id));
	const columnsByTable = new Map<string, Set<string>>();
	for (const table of snapshot.tables) {
		if (!UUID_V7.test(table.id)) {
			findings.push({
				code: "invalid-lookup-uuid",
				path: `lookup_tables.${canonicalIdentityDigest(table.id)}.id`,
				digest: canonicalIdentityDigest(table.id),
			});
		}
	}
	for (const column of snapshot.columns) {
		if (!UUID_V7.test(column.tableId) || !UUID_V7.test(column.id)) {
			findings.push({
				code: "invalid-lookup-uuid",
				path: `lookup_columns.${canonicalIdentityDigest(column.id)}.id`,
				digest: canonicalIdentityDigest(column),
			});
		}
		const key = `${column.projectId}\u0000${column.tableId}`;
		const ids = columnsByTable.get(key) ?? new Set<string>();
		ids.add(column.id);
		columnsByTable.set(key, ids);
	}
	for (const row of snapshot.rows) {
		if (!UUID_V7.test(row.tableId) || !UUID_V7.test(row.id)) {
			findings.push({
				code: "invalid-lookup-uuid",
				path: `lookup_rows.${canonicalIdentityDigest(row.id)}.id`,
				digest: canonicalIdentityDigest(row),
			});
		}
		if (!tableIds.has(row.tableId)) {
			findings.push({
				code: "unresolved-reference",
				path: `lookup_rows.${canonicalIdentityDigest(row.id)}.table_id`,
				digest: canonicalIdentityDigest(row.tableId),
			});
		}
		const columns =
			columnsByTable.get(`${row.projectId}\u0000${row.tableId}`) ??
			new Set<string>();
		for (const key of Object.keys(row.values)) {
			if (!UUID_V7.test(key)) {
				findings.push({
					code: "invalid-lookup-uuid",
					path: `lookup_rows.${canonicalIdentityDigest(row.id)}.values.${canonicalIdentityDigest(key)}`,
					digest: canonicalIdentityDigest(key),
				});
			} else if (!columns.has(key)) {
				findings.push({
					code: "unresolved-reference",
					path: `lookup_rows.${canonicalIdentityDigest(row.id)}.values.${canonicalIdentityDigest(key)}`,
					digest: canonicalIdentityDigest(key),
				});
			}
		}
	}
	return findings.sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.code.localeCompare(right.code),
	);
}
