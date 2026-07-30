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
const PRE_CUTOVER_STANDARD_PROPERTY = {
	name: "case_name",
	"date-opened": "date_opened",
	"external-id": "external_id",
} as const;
const DATE_COLUMN_PATTERN_BY_PRESET = {
	short: "%m/%d/%Y",
	long: "%B %e, %Y",
	iso: "%Y-%m-%d",
} as const;
const CONNECT_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CASE_PROPERTY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const XML_ELEMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_USER_FIELD = /^[A-Za-z_][-A-Za-z0-9_]*$/;
const COMMCARE_DATE_PATTERN =
	/^(?:[^%]|%(?:%|Y|y|m|n|B|b|d|e|H|h|M|S|3|A|a|w|Z))*$/;
const CASE_PROPERTY_DATA_TYPES = new Set([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
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
	| "app-change-replay-mismatch";

export interface CanonicalIdentityFinding {
	readonly disposition: "block-current";
	readonly carrierId: string;
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
	standardPropertyReferences: number;
	catalogProperties: number;
	connectEmptyDeletes: number;
	datePatterns: number;
	postSubmitDestinations: number;
	caseWriteBindings: number;
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

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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
				.sort(([left], [right]) => compareUtf8(left, right))
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
		standardPropertyReferences: 0,
		catalogProperties: 0,
		connectEmptyDeletes: 0,
		datePatterns: 0,
		postSubmitDestinations: 0,
		caseWriteBindings: 0,
	};
}

interface MutablePlanContext {
	readonly appId: string;
	readonly connectType: string | null;
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
	readonly connectIds: Map<string, string>;
	readonly operationUuidsByForm: Map<string, Set<string>>;
}

function finding(
	ctx: MutablePlanContext,
	code: CanonicalIdentityFindingCode,
	path: string,
	value: unknown,
	carrierId = "blueprint.current",
): void {
	ctx.findings.push({
		disposition: "block-current",
		carrierId,
		code,
		path: `blueprint:${canonicalIdentityDigest(path)}`,
		digest: canonicalIdentityDigest(value),
	});
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

function canonicalStandardProperty(value: string): string {
	return (
		PRE_CUTOVER_STANDARD_PROPERTY[
			value as keyof typeof PRE_CUTOVER_STANDARD_PROPERTY
		] ?? value
	);
}

function rewriteReadProperty(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): unknown {
	if (typeof value !== "string") {
		finding(ctx, "invalid-legacy-shape", path, value, "standard-property");
		return value;
	}
	const canonical = canonicalStandardProperty(value);
	if (canonical !== value) ctx.rewrites.standardPropertyReferences++;
	return canonical;
}

function blockWriterProperty(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): unknown {
	if (
		typeof value === "string" &&
		Object.hasOwn(PRE_CUTOVER_STANDARD_PROPERTY, value)
	) {
		finding(
			ctx,
			"invalid-legacy-shape",
			path,
			value,
			"standard-property-writer",
		);
	}
	return value;
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
				left.ordinal - right.ordinal || compareUtf8(left.uuid, right.uuid),
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
		connectType: app.connectType,
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
		connectIds: new Map(),
		operationUuidsByForm: new Map(),
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
		if (row.kind === "form") {
			if (row.parentUuid !== null) {
				ctx.formModule.set(row.uuid, row.parentUuid);
			}
			const operationUuids = new Set<string>();
			for (const operation of Array.isArray(row.data.caseOperations)
				? row.data.caseOperations
				: []) {
				if (isRecord(operation) && typeof operation.uuid === "string") {
					operationUuids.add(operation.uuid);
				}
			}
			ctx.operationUuidsByForm.set(row.uuid, operationUuids);
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
		const formUuid = owningFormUuid(ctx, row);
		const form =
			formUuid === undefined ? undefined : ctx.rowsByUuid.get(formUuid);
		const formType =
			form?.kind === "form" && typeof form.data.type === "string"
				? form.data.type
				: undefined;
		if (formType === "registration") {
			const moduleUuid = owningModuleUuid(ctx, row);
			const module =
				moduleUuid === undefined ? undefined : ctx.rowsByUuid.get(moduleUuid);
			const caseType =
				module?.kind === "module" && typeof module.data.caseType === "string"
					? module.data.caseType
					: undefined;
			if (
				caseType !== undefined &&
				segments.length === 1 &&
				segments[0] === "case_id"
			) {
				return { kind: "case-ref", caseType, property: "case_id" };
			}
			return rejected("unresolved-reference");
		}
		if (formType === "followup" || formType === "close") {
			const contextual = contextualCaseType(ctx, row, segments);
			if (contextual !== undefined) {
				return {
					kind: "case-ref",
					...contextual,
					property: canonicalStandardProperty(contextual.property),
				};
			}
		}
		return rejected("unresolved-reference");
	}
	if (segments.length !== 1 || !ctx.caseTypeParent.has(namespace)) {
		return rejected("unresolved-reference");
	}
	return {
		kind: "case-ref",
		caseType: namespace,
		property: canonicalStandardProperty(segments[0]),
	};
}

function convertProse(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	value: unknown,
	path: string,
	allowFieldReference = true,
): unknown {
	if (typeof value === "string") {
		ctx.rewrites.proseTemplates++;
		// Historical prose was untyped text. Reference-looking bytes are not
		// identity evidence and therefore remain literal unless the separate,
		// digest-pinned frozen repair has already installed typed parts.
		return value.length === 0
			? { parts: [] }
			: { parts: [{ kind: "text", text: value }] };
	}
	if (
		isRecord(value) &&
		recordHasOnlyKeys(value, ["parts"]) &&
		Array.isArray(value.parts)
	) {
		let previousText = false;
		for (const [index, part] of value.parts.entries()) {
			if (!isRecord(part) || typeof part.kind !== "string") {
				finding(ctx, "noncanonical-prose", `${path}.parts[${index}]`, part);
				continue;
			}
			if (part.kind === "text") {
				if (
					!recordHasOnlyKeys(part, ["kind", "text"]) ||
					typeof part.text !== "string" ||
					part.text.length === 0 ||
					previousText
				) {
					finding(ctx, "noncanonical-prose", `${path}.parts[${index}]`, part);
				}
				previousText = true;
			} else if (part.kind === "field-ref") {
				const targetPath = `${path}.parts[${index}]`;
				const uuidValid =
					recordHasOnlyKeys(part, ["kind", "uuid"]) &&
					assertUuid(ctx, part.uuid, `${targetPath}.uuid`);
				const target =
					uuidValid && typeof part.uuid === "string"
						? ctx.rowsByUuid.get(part.uuid)
						: undefined;
				const formUuid = owningFormUuid(ctx, row);
				if (
					!allowFieldReference ||
					target?.kind !== "field" ||
					formUuid === undefined ||
					ctx.fieldForm.get(String(part.uuid)) !== formUuid
				) {
					finding(ctx, "noncanonical-prose", targetPath, part);
				}
				previousText = false;
			} else if (part.kind === "user-property-ref") {
				const targetPath = `${path}.parts[${index}]`;
				if (
					!recordHasOnlyKeys(part, ["kind", "userPropertyUuid"]) ||
					!assertUuid(
						ctx,
						part.userPropertyUuid,
						`${targetPath}.userPropertyUuid`,
					) ||
					!ctx.userPropertySlugByUuid.has(String(part.userPropertyUuid))
				) {
					finding(ctx, "noncanonical-prose", targetPath, part);
				}
				previousText = false;
			} else if (part.kind === "case-ref") {
				if (
					!recordHasOnlyKeys(part, ["kind", "caseType", "property"]) ||
					typeof part.caseType !== "string" ||
					!ctx.caseTypeParent.has(part.caseType) ||
					typeof part.property !== "string" ||
					!CASE_PROPERTY.test(part.property)
				) {
					finding(ctx, "noncanonical-prose", `${path}.parts[${index}]`, part);
				} else {
					const canonical = canonicalStandardProperty(part.property);
					if (canonical !== part.property) {
						part.property = canonical;
						ctx.rewrites.standardPropertyReferences++;
					}
				}
				previousText = false;
			} else if (part.kind === "user-ref") {
				if (
					!recordHasOnlyKeys(part, ["kind", "property"]) ||
					typeof part.property !== "string" ||
					!SESSION_USER_FIELD.test(part.property) ||
					(ctx.userPropertyBySlug.get(part.property)?.length ?? 0) !== 0
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
	row: LegacyEntityRow,
	part: unknown,
	path: string,
): string | undefined {
	if (!isRecord(part) || typeof part.kind !== "string") {
		finding(ctx, "noncanonical-xpath", path, part);
		return undefined;
	}
	switch (part.kind) {
		case "text":
			if (
				recordHasOnlyKeys(part, ["kind", "text"]) &&
				typeof part.text === "string"
			) {
				return part.text;
			}
			break;
		case "raw-ref":
			if (
				recordHasOnlyKeys(part, ["kind", "namespace", "segments"]) &&
				typeof part.namespace === "string" &&
				Array.isArray(part.segments) &&
				part.segments.length > 0 &&
				part.segments.every((segment) => typeof segment === "string")
			) {
				return `#${part.namespace}/${part.segments.join("/")}`;
			}
			break;
		case "field-ref": {
			if (!recordHasOnlyKeys(part, ["kind", "uuid"])) break;
			if (!assertUuid(ctx, part.uuid, `${path}.uuid`)) return undefined;
			const segments = ctx.fieldPathByUuid.get(part.uuid);
			const formUuid = owningFormUuid(ctx, row);
			if (
				segments !== undefined &&
				formUuid !== undefined &&
				ctx.fieldForm.get(part.uuid) === formUuid
			) {
				return `#form/${segments.join("/")}`;
			}
			finding(ctx, "unresolved-reference", path, part);
			return undefined;
		}
		case "path-ref": {
			if (!recordHasOnlyKeys(part, ["kind", "uuid"], ["seps"])) break;
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
			const formUuid = owningFormUuid(ctx, row);
			if (
				segments !== undefined &&
				formUuid !== undefined &&
				ctx.fieldForm.get(part.uuid) === formUuid
			) {
				return `/data/${segments.join("/")}`;
			}
			finding(ctx, "unresolved-reference", path, part);
			return undefined;
		}
		case "case-ref":
			if (
				recordHasOnlyKeys(part, ["kind", "caseType", "property"]) &&
				typeof part.caseType === "string" &&
				ctx.caseTypeParent.has(part.caseType) &&
				typeof part.property === "string" &&
				CASE_PROPERTY.test(part.property)
			) {
				return `#${part.caseType}/${part.property}`;
			}
			break;
		case "user-ref":
			if (
				recordHasOnlyKeys(part, ["kind", "property"]) &&
				typeof part.property === "string" &&
				SESSION_USER_FIELD.test(part.property) &&
				(ctx.userPropertyBySlug.get(part.property)?.length ?? 0) === 0
			) {
				return `#user/${part.property}`;
			}
			break;
		case "user-property-ref": {
			if (!recordHasOnlyKeys(part, ["kind", "userPropertyUuid"])) break;
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
	row: LegacyEntityRow,
	value: unknown,
	path: string,
): string | undefined {
	if (typeof value === "string") return value;
	if (
		!isRecord(value) ||
		!recordHasOnlyKeys(value, ["parts"]) ||
		!Array.isArray(value.parts)
	) {
		finding(ctx, "noncanonical-xpath", path, value);
		return undefined;
	}
	let source = "";
	for (const [index, part] of value.parts.entries()) {
		const text = legacyXPathPartSource(
			ctx,
			row,
			part,
			`${path}.parts[${index}]`,
		);
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

function printFrozenXPathExpression(
	ctx: MutablePlanContext,
	expression: FrozenXPathExpression,
): string | undefined {
	let source = "";
	for (const part of expression.parts) {
		switch (part.kind) {
			case "text":
				source += part.text;
				break;
			case "field-ref": {
				const path = ctx.fieldPathByUuid.get(part.uuid);
				if (path === undefined) return undefined;
				source += `#form/${path.join("/")}`;
				break;
			}
			case "path-ref": {
				const path = ctx.fieldPathByUuid.get(part.uuid);
				if (path === undefined) return undefined;
				source += `/data/${path.join("/")}`;
				break;
			}
			case "case-ref":
				source += `#${part.caseType}/${part.property}`;
				break;
			case "user-ref":
				source += `#user/${part.property}`;
				break;
			case "user-property-ref": {
				const slug = ctx.userPropertySlugByUuid.get(part.userPropertyUuid);
				if (slug === undefined) return undefined;
				source += `#user/${slug}`;
				break;
			}
		}
	}
	return source;
}

function convertXPath(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	value: unknown,
	path: string,
): unknown {
	const source = legacyXPathSource(ctx, row, value, path);
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
	const printed = printFrozenXPathExpression(ctx, parsed.expression);
	const reparsed =
		printed === undefined
			? undefined
			: parseFrozenXPathExpression(printed, {
					hashtag(namespace, segments) {
						return classifyLegacyReference(
							ctx,
							row,
							namespace,
							segments,
							path,
							false,
						) as
							| Exclude<FrozenXPathPart, { kind: "text" | "path-ref" }>
							| undefined;
					},
					dataPath(segments) {
						return formUuid === undefined
							? undefined
							: ctx.fieldUuidByFormPath.get(formUuid)?.get(segments.join("/"));
					},
				});
	if (
		printed === undefined ||
		reparsed === undefined ||
		reparsed.issues.length > 0 ||
		canonicalJson(reparsed.expression) !== canonicalJson(parsed.expression)
	) {
		finding(ctx, "noncanonical-xpath", path, {
			printed:
				printed === undefined ? "unresolved" : canonicalIdentityDigest(printed),
			reparsed: reparsed?.issues ?? "unresolved",
		});
		return value;
	}
	const legacyCounts = countLegacyXPathParts(value);
	ctx.rewrites.pathRefs += legacyCounts.pathRefs;
	ctx.rewrites.rawRefs += legacyCounts.rawRefs;
	if (typeof value === "string") ctx.rewrites.xpathExpressions++;
	return parsed.expression satisfies FrozenXPathExpression;
}

function asFrozenCatalogExpression(value: unknown):
	| {
			parts: Array<
				| { kind: "text"; text: string }
				| { kind: "case-ref"; caseType: string; property: string }
			>;
	  }
	| undefined {
	if (
		!isRecord(value) ||
		!recordHasOnlyKeys(value, ["parts"]) ||
		!Array.isArray(value.parts)
	) {
		return undefined;
	}
	const parts: Array<
		| { kind: "text"; text: string }
		| {
				kind: "case-ref";
				caseType: string;
				property: string;
		  }
	> = [];
	for (const part of value.parts) {
		if (!isRecord(part)) return undefined;
		if (
			part.kind === "text" &&
			recordHasOnlyKeys(part, ["kind", "text"]) &&
			typeof part.text === "string"
		) {
			parts.push({ kind: "text", text: part.text });
			continue;
		}
		if (
			part.kind === "case-ref" &&
			recordHasOnlyKeys(part, ["kind", "caseType", "property"]) &&
			typeof part.caseType === "string" &&
			typeof part.property === "string" &&
			CASE_PROPERTY.test(part.property)
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
		const expression = {
			parts: parsed.expression.parts.map((part) => {
				if (part.kind !== "case-ref") return { ...part };
				const property = canonicalStandardProperty(part.property);
				if (property !== part.property) {
					ctx.rewrites.standardPropertyReferences++;
				}
				return { ...part, property };
			}),
		};
		ctx.rewrites.xpathExpressions++;
		return expression;
	}

	const expression = asFrozenCatalogExpression(value);
	if (expression === undefined) {
		finding(ctx, "noncanonical-xpath", path, value);
		return value;
	}
	for (const part of expression.parts) {
		if (part.kind !== "case-ref") continue;
		const canonical = canonicalStandardProperty(part.property);
		if (canonical !== part.property) {
			part.property = canonical;
			ctx.rewrites.standardPropertyReferences++;
		}
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
	return expression;
}

function frozenRecordShape(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): value is JsonRecord {
	return isRecord(value) && recordHasOnlyKeys(value, required, optional);
}

function frozenStringIn(value: unknown, allowed: ReadonlySet<string>): boolean {
	return typeof value === "string" && allowed.has(value);
}

function isFrozenLiteral(value: unknown): boolean {
	if (!frozenRecordShape(value, ["kind", "value"], ["data_type"])) return false;
	if (value.kind !== "literal") return false;
	const literal = value.value;
	if (
		literal !== null &&
		typeof literal !== "string" &&
		typeof literal !== "boolean" &&
		!(typeof literal === "number" && Number.isFinite(literal))
	) {
		return false;
	}
	return (
		value.data_type === undefined ||
		frozenStringIn(value.data_type, CASE_PROPERTY_DATA_TYPES)
	);
}

function isFrozenRelationStep(value: unknown): boolean {
	return (
		frozenRecordShape(value, ["identifier"], ["throughCaseType"]) &&
		typeof value.identifier === "string" &&
		XML_ELEMENT_NAME.test(value.identifier) &&
		(value.throughCaseType === undefined ||
			(typeof value.throughCaseType === "string" &&
				CASE_PROPERTY.test(value.throughCaseType)))
	);
}

function isFrozenRelationPath(value: unknown): boolean {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	switch (value.kind) {
		case "self":
			return frozenRecordShape(value, ["kind"]);
		case "ancestor":
			return (
				frozenRecordShape(value, ["kind", "via"]) &&
				Array.isArray(value.via) &&
				value.via.length > 0 &&
				value.via.every(isFrozenRelationStep)
			);
		case "subcase":
		case "any-relation":
			return (
				frozenRecordShape(value, ["kind", "identifier"], ["ofCaseType"]) &&
				typeof value.identifier === "string" &&
				XML_ELEMENT_NAME.test(value.identifier) &&
				(value.ofCaseType === undefined ||
					(typeof value.ofCaseType === "string" &&
						CASE_PROPERTY.test(value.ofCaseType)))
			);
		default:
			return false;
	}
}

function isFrozenPropertyTerm(value: unknown): boolean {
	return (
		frozenRecordShape(value, ["kind", "caseType", "property"], ["via"]) &&
		value.kind === "prop" &&
		typeof value.caseType === "string" &&
		CASE_PROPERTY.test(value.caseType) &&
		typeof value.property === "string" &&
		CASE_PROPERTY.test(value.property) &&
		(value.via === undefined || isFrozenRelationPath(value.via))
	);
}

function isFrozenSearchInputTerm(value: unknown): boolean {
	return (
		frozenRecordShape(value, ["kind", "searchInputUuid"]) &&
		value.kind === "input" &&
		isCanonicalAuthoredUuid(value.searchInputUuid)
	);
}

function isFrozenTerm(value: unknown): boolean {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	switch (value.kind) {
		case "prop":
			return isFrozenPropertyTerm(value);
		case "input":
			return isFrozenSearchInputTerm(value);
		case "session-user":
			return (
				frozenRecordShape(value, ["kind", "field"]) &&
				typeof value.field === "string" &&
				SESSION_USER_FIELD.test(value.field)
			);
		case "session-user-property":
			return (
				frozenRecordShape(value, ["kind", "userPropertyUuid"]) &&
				isCanonicalAuthoredUuid(value.userPropertyUuid)
			);
		case "session-context":
			return (
				frozenRecordShape(value, ["kind", "field"]) &&
				frozenStringIn(
					value.field,
					new Set(["userid", "username", "deviceid", "appversion"]),
				)
			);
		case "field":
			return (
				frozenRecordShape(value, ["kind", "uuid"]) &&
				isCanonicalAuthoredUuid(value.uuid)
			);
		case "table-column":
			return (
				frozenRecordShape(value, ["kind", "tableId", "columnId"]) &&
				isCanonicalLookupUuid(value.tableId) &&
				isCanonicalLookupUuid(value.columnId)
			);
		case "literal":
			return isFrozenLiteral(value);
		default:
			return false;
	}
}

function isFrozenValueExpression(value: unknown): boolean {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	switch (value.kind) {
		case "term":
			return (
				frozenRecordShape(value, ["kind", "term"]) && isFrozenTerm(value.term)
			);
		case "today":
		case "now":
		case "acting-user":
		case "unowned":
			return frozenRecordShape(value, ["kind"]);
		case "id-of":
			return (
				frozenRecordShape(value, ["kind", "opUuid"]) &&
				isCanonicalAuthoredUuid(value.opUuid)
			);
		case "table-lookup":
			return (
				frozenRecordShape(value, [
					"kind",
					"tableId",
					"resultColumnId",
					"where",
				]) &&
				isCanonicalLookupUuid(value.tableId) &&
				isCanonicalLookupUuid(value.resultColumnId) &&
				isFrozenPredicate(value.where)
			);
		case "date-add":
			return (
				frozenRecordShape(value, ["kind", "date", "interval", "quantity"]) &&
				isFrozenValueExpression(value.date) &&
				frozenStringIn(
					value.interval,
					new Set([
						"seconds",
						"minutes",
						"hours",
						"days",
						"weeks",
						"months",
						"years",
					]),
				) &&
				isFrozenValueExpression(value.quantity)
			);
		case "date-coerce":
		case "datetime-coerce":
		case "double":
			return (
				frozenRecordShape(value, ["kind", "value"]) &&
				isFrozenValueExpression(value.value)
			);
		case "arith":
			return (
				frozenRecordShape(value, ["kind", "op", "left", "right"]) &&
				frozenStringIn(value.op, new Set(["+", "-", "*", "div", "mod"])) &&
				isFrozenValueExpression(value.left) &&
				isFrozenValueExpression(value.right)
			);
		case "concat":
			return (
				frozenRecordShape(value, ["kind", "parts"]) &&
				Array.isArray(value.parts) &&
				value.parts.length > 0 &&
				value.parts.every(isFrozenValueExpression)
			);
		case "coalesce":
			return (
				frozenRecordShape(value, ["kind", "values"]) &&
				Array.isArray(value.values) &&
				value.values.length > 0 &&
				value.values.every(isFrozenValueExpression)
			);
		case "if":
			return (
				frozenRecordShape(value, ["kind", "cond", "then", "else"]) &&
				isFrozenPredicate(value.cond) &&
				isFrozenValueExpression(value.then) &&
				isFrozenValueExpression(value.else)
			);
		case "switch":
			return (
				frozenRecordShape(value, ["kind", "on", "cases", "fallback"]) &&
				isFrozenValueExpression(value.on) &&
				Array.isArray(value.cases) &&
				value.cases.length > 0 &&
				value.cases.every(
					(entry) =>
						frozenRecordShape(entry, ["when", "then"]) &&
						isFrozenLiteral(entry.when) &&
						isFrozenValueExpression(entry.then),
				) &&
				isFrozenValueExpression(value.fallback)
			);
		case "count":
			return (
				frozenRecordShape(value, ["kind", "via"], ["where"]) &&
				isFrozenRelationPath(value.via) &&
				(value.where === undefined || isFrozenPredicate(value.where))
			);
		case "format-date":
			return (
				frozenRecordShape(value, ["kind", "date", "pattern"]) &&
				isFrozenValueExpression(value.date) &&
				typeof value.pattern === "string" &&
				value.pattern.length > 0 &&
				COMMCARE_DATE_PATTERN.test(value.pattern)
			);
		default:
			return false;
	}
}

function isFrozenPredicate(value: unknown): boolean {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	if (new Set(["eq", "neq", "gt", "gte", "lt", "lte"]).has(value.kind)) {
		return (
			frozenRecordShape(value, ["kind", "left", "right"]) &&
			isFrozenValueExpression(value.left) &&
			isFrozenValueExpression(value.right)
		);
	}
	switch (value.kind) {
		case "in":
			return (
				frozenRecordShape(value, ["kind", "left", "values"]) &&
				isFrozenValueExpression(value.left) &&
				Array.isArray(value.values) &&
				value.values.length > 0 &&
				value.values.every(isFrozenLiteral) &&
				value.values.some((entry) => isRecord(entry) && entry.value !== null)
			);
		case "within-distance":
			return (
				frozenRecordShape(value, [
					"kind",
					"property",
					"center",
					"distance",
					"unit",
				]) &&
				isFrozenPropertyTerm(value.property) &&
				isFrozenValueExpression(value.center) &&
				typeof value.distance === "number" &&
				Number.isFinite(value.distance) &&
				value.distance > 0 &&
				frozenStringIn(value.unit, new Set(["miles", "kilometers"])) &&
				Number.isFinite(
					value.distance * (value.unit === "miles" ? 1609.344 : 1000),
				)
			);
		case "match":
			return (
				frozenRecordShape(value, ["kind", "property", "value", "mode"]) &&
				isFrozenPropertyTerm(value.property) &&
				isFrozenValueExpression(value.value) &&
				frozenStringIn(
					value.mode,
					new Set(["fuzzy", "phonetic", "fuzzy-date", "starts-with"]),
				)
			);
		case "multi-select-contains":
			return (
				frozenRecordShape(value, [
					"kind",
					"property",
					"values",
					"quantifier",
				]) &&
				isFrozenPropertyTerm(value.property) &&
				Array.isArray(value.values) &&
				value.values.length > 0 &&
				value.values.every(isFrozenLiteral) &&
				value.values.some((entry) => isRecord(entry) && entry.value !== null) &&
				frozenStringIn(value.quantifier, new Set(["any", "all"]))
			);
		case "match-all":
		case "match-none":
			return frozenRecordShape(value, ["kind"]);
		case "is-blank":
			return (
				frozenRecordShape(value, ["kind", "left"]) &&
				isFrozenValueExpression(value.left)
			);
		case "between":
			return (
				frozenRecordShape(
					value,
					["kind", "left", "lowerInclusive", "upperInclusive"],
					["lower", "upper"],
				) &&
				isFrozenValueExpression(value.left) &&
				(value.lower === undefined || isFrozenValueExpression(value.lower)) &&
				(value.upper === undefined || isFrozenValueExpression(value.upper)) &&
				(value.lower !== undefined || value.upper !== undefined) &&
				typeof value.lowerInclusive === "boolean" &&
				typeof value.upperInclusive === "boolean"
			);
		case "and":
		case "or":
			return (
				frozenRecordShape(value, ["kind", "clauses"]) &&
				Array.isArray(value.clauses) &&
				value.clauses.length > 0 &&
				value.clauses.every(isFrozenPredicate)
			);
		case "not":
			return (
				frozenRecordShape(value, ["kind", "clause"]) &&
				isFrozenPredicate(value.clause)
			);
		case "when-input-present":
			return (
				frozenRecordShape(value, ["kind", "input", "clause"]) &&
				isFrozenSearchInputTerm(value.input) &&
				isFrozenPredicate(value.clause)
			);
		case "exists":
		case "missing":
			return (
				frozenRecordShape(value, ["kind", "via"], ["where"]) &&
				isFrozenRelationPath(value.via) &&
				(value.where === undefined || isFrozenPredicate(value.where))
			);
		default:
			return false;
	}
}

function frozenAstRootIsValid(value: unknown, path: string): boolean {
	if (path.endsWith(".via")) return isFrozenRelationPath(value);
	if (
		path.endsWith(".displayCondition") ||
		path.endsWith(".condition") ||
		path.endsWith(".filter") ||
		path.endsWith(".predicate") ||
		path.endsWith(".searchButtonDisplayCondition")
	) {
		return isFrozenPredicate(value);
	}
	return isFrozenValueExpression(value);
}

function transformPredicate(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
	moduleUuid: string | undefined,
	validateRoot = true,
): void {
	if (Array.isArray(value)) {
		value.forEach((child, index) => {
			transformPredicate(ctx, child, `${path}[${index}]`, moduleUuid, false);
		});
		return;
	}
	if (!isRecord(value)) return;
	if (value.kind === "unwrap-list" || value.kind === "is-null") {
		finding(ctx, "invalid-legacy-shape", path, value, "expression-leaf");
	}
	if (
		(value.kind === "acting-user" || value.kind === "unowned") &&
		!path.includes(".owner") &&
		!path.includes(".excludedOwnerIds")
	) {
		finding(ctx, "invalid-legacy-shape", path, value, "owner-expression");
	}
	if (
		(value.kind === "prop" || value.kind === "case-ref") &&
		typeof value.property === "string"
	) {
		const canonical = canonicalStandardProperty(value.property);
		if (canonical !== value.property) {
			value.property = canonical;
			ctx.rewrites.standardPropertyReferences++;
		}
	}
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
		const uuidOk = assertUuid(ctx, value.opUuid, `${path}.opUuid`);
		const match = path.match(/\.caseOperations\[(\d+)\]/);
		const currentIndex = match === null ? undefined : Number(match[1]);
		const formUuid =
			path.startsWith("entities.form.") && currentIndex !== undefined
				? path.slice("entities.form.".length).split(".")[0]
				: undefined;
		const form =
			formUuid === undefined ? undefined : ctx.rowsByUuid.get(formUuid);
		const operations =
			form?.kind === "form" && Array.isArray(form.data.caseOperations)
				? form.data.caseOperations
				: [];
		const targetIndex = operations.findIndex(
			(operation) => isRecord(operation) && operation.uuid === value.opUuid,
		);
		const target = targetIndex < 0 ? undefined : operations[targetIndex];
		if (
			!uuidOk ||
			currentIndex === undefined ||
			targetIndex < 0 ||
			targetIndex >= currentIndex ||
			!isRecord(target) ||
			target.action !== "create"
		) {
			finding(ctx, "invalid-legacy-shape", path, value, "operation-order");
		}
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
		transformPredicate(ctx, child, `${path}.${key}`, moduleUuid, false);
	}
	if (validateRoot && !frozenAstRootIsValid(value, path)) {
		finding(ctx, "invalid-legacy-shape", path, value, "expression-ast");
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
	row: LegacyEntityRow,
	value: unknown,
	path: string,
): unknown {
	if (typeof value === "string") {
		if (!assertUuid(ctx, value, path)) return value;
		const formUuid = owningFormUuid(ctx, row);
		const target = ctx.rowsByUuid.get(value);
		const operationReference = path.endsWith(".opUuid");
		if (operationReference) {
			if (
				formUuid === undefined ||
				!(ctx.operationUuidsByForm.get(formUuid)?.has(value) ?? false)
			) {
				finding(ctx, "unresolved-reference", path, value);
			}
		} else if (
			target?.kind !== "field" ||
			formUuid === undefined ||
			ctx.fieldForm.get(value) !== formUuid
		) {
			finding(ctx, "unresolved-reference", path, value);
		}
		return value;
	}
	if (!isRecord(value) || typeof value.kind !== "string") {
		finding(ctx, "invalid-legacy-shape", path, value);
		return value;
	}
	if (value.kind === "module") {
		if (
			assertUuid(ctx, value.moduleUuid, `${path}.moduleUuid`) &&
			ctx.rowsByUuid.get(String(value.moduleUuid))?.kind !== "module"
		) {
			finding(
				ctx,
				"unresolved-reference",
				`${path}.moduleUuid`,
				value.moduleUuid,
			);
		}
		return value;
	}
	if (value.kind === "form") {
		const moduleOk = assertUuid(ctx, value.moduleUuid, `${path}.moduleUuid`);
		const formOk = assertUuid(ctx, value.formUuid, `${path}.formUuid`);
		const targetForm = ctx.rowsByUuid.get(String(value.formUuid));
		if (
			!moduleOk ||
			!formOk ||
			targetForm?.kind !== "form" ||
			targetForm.parentUuid !== value.moduleUuid
		) {
			finding(ctx, "unresolved-reference", path, value);
		}
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

function transformDatePattern(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): unknown {
	if (typeof value !== "string" || value.length === 0) {
		finding(ctx, "invalid-legacy-shape", path, value, "date-column-pattern");
		return value;
	}
	const converted =
		DATE_COLUMN_PATTERN_BY_PRESET[
			value as keyof typeof DATE_COLUMN_PATTERN_BY_PRESET
		];
	if (converted !== undefined) {
		ctx.rewrites.datePatterns++;
		return converted;
	}
	if (/^[a-z][a-z-]*$/.test(value)) {
		finding(ctx, "invalid-legacy-shape", path, value, "date-column-pattern");
	}
	return value;
}

function transformPostSubmit(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): unknown {
	if (value === "root") {
		ctx.rewrites.postSubmitDestinations++;
		return "app_home";
	}
	if (value === "app_home" || value === "module" || value === "previous") {
		return value;
	}
	finding(ctx, "invalid-legacy-shape", path, value, "post-submit");
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
			return validateEntityReference(ctx, row, value, path);
		case "media":
			return validateMediaOccurrence(ctx, row, value, path);
		case "lookup-carrier":
		case "case-type-ref":
			return value;
		case "case-property-ref":
			return (path.includes(".caseOperations[") ||
				path.includes(".caseWrite.")) &&
				path.endsWith(".property")
				? blockWriterProperty(ctx, value, path)
				: rewriteReadProperty(ctx, value, path);
		case "standard-case-property":
			return path.includes(".caseOperations[") && path.endsWith(".property")
				? blockWriterProperty(ctx, value, path)
				: rewriteReadProperty(ctx, value, path);
		case "date-pattern":
			return transformDatePattern(ctx, value, path);
		case "post-submit":
			return transformPostSubmit(ctx, value, path);
		case "final-shape":
			return value;
	}
}

function transformFieldCaseWrite(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	basePath: string,
): void {
	const legacyPresent = Object.hasOwn(row.data, "case_property_on");
	const currentPresent = Object.hasOwn(row.data, "caseWrite");
	if (legacyPresent) {
		const caseType = row.data.case_property_on;
		const property = row.data.id;
		if (
			currentPresent ||
			typeof caseType !== "string" ||
			!CASE_PROPERTY.test(caseType) ||
			typeof property !== "string" ||
			property.length > 255 ||
			!CASE_PROPERTY.test(property) ||
			Object.hasOwn(PRE_CUTOVER_STANDARD_PROPERTY, property)
		) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${basePath}.case_property_on`,
				{
					caseType,
					property,
					currentPresent,
				},
				"field-case-write",
			);
			return;
		}
		row.data.caseWrite = { caseType, property };
		delete row.data.case_property_on;
		ctx.rewrites.caseWriteBindings++;
		return;
	}
	if (!currentPresent) return;
	const caseWrite = row.data.caseWrite;
	if (
		!isRecord(caseWrite) ||
		!recordHasOnlyKeys(caseWrite, ["caseType", "property"]) ||
		typeof caseWrite.caseType !== "string" ||
		!CASE_PROPERTY.test(caseWrite.caseType) ||
		typeof caseWrite.property !== "string" ||
		caseWrite.property.length > 255 ||
		!CASE_PROPERTY.test(caseWrite.property) ||
		Object.hasOwn(PRE_CUTOVER_STANDARD_PROPERTY, caseWrite.property)
	) {
		finding(
			ctx,
			"invalid-legacy-shape",
			`${basePath}.caseWrite`,
			caseWrite,
			"field-case-write",
		);
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

	if (source.kind === "lookup") {
		if (
			!recordHasOnlyKeys(
				source,
				["kind", "tableId", "valueColumnId", "labelColumnId"],
				["filter"],
			)
		) {
			finding(
				ctx,
				"noncanonical-select-source",
				`${basePath}.optionsSource`,
				source,
				"lookup-options-source",
			);
		}
		if (source.filter !== undefined) {
			transformPredicate(
				ctx,
				source.filter,
				`${basePath}.optionsSource.filter`,
				owningModuleUuid(ctx, row),
			);
		}
		return;
	}
	if (source.kind !== "inline" || !Array.isArray(source.options)) return;
	if (!recordHasOnlyKeys(source, ["kind", "options"])) {
		finding(
			ctx,
			"noncanonical-select-source",
			`${basePath}.optionsSource`,
			source,
			"inline-options-source",
		);
	}
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
		if (
			!recordHasOnlyKeys(option, ["value", "label", "uuid"], ["media"]) ||
			typeof option.value !== "string"
		) {
			finding(
				ctx,
				"noncanonical-select-source",
				`${basePath}.optionsSource.options[${index}]`,
				option,
				"inline-option",
			);
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

function recordHasOnlyKeys(
	value: JsonRecord,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowed.has(key))
	);
}

function transformConnect(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	basePath: string,
): void {
	if (!Object.hasOwn(row.data, "connect")) return;
	const value = row.data.connect;
	if (value === null || (isRecord(value) && Object.keys(value).length === 0)) {
		delete row.data.connect;
		ctx.rewrites.connectEmptyDeletes++;
		return;
	}
	if (!isRecord(value)) {
		finding(
			ctx,
			"invalid-legacy-shape",
			`${basePath}.connect`,
			value,
			"connect",
		);
		return;
	}
	const allowed =
		ctx.connectType === "learn"
			? new Set(["learn_module", "assessment"])
			: ctx.connectType === "deliver"
				? new Set(["deliver_unit", "task"])
				: new Set<string>();
	const keys = Object.keys(value);
	if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
		finding(
			ctx,
			"invalid-legacy-shape",
			`${basePath}.connect`,
			value,
			"connect",
		);
		return;
	}
	for (const key of keys) {
		const block = value[key];
		if (
			!isRecord(block) ||
			typeof block.id !== "string" ||
			block.id.length === 0 ||
			block.id.length > 50 ||
			!CONNECT_ID.test(block.id)
		) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${basePath}.connect.${key}.id`,
				isRecord(block) ? block.id : block,
				"connect",
			);
			continue;
		}
		const prior = ctx.connectIds.get(block.id);
		if (prior !== undefined) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${basePath}.connect.${key}.id`,
				{ prior, id: block.id },
				"connect",
			);
		} else {
			ctx.connectIds.set(block.id, `${row.uuid}:${key}`);
		}
	}
}

function validateMapping(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
): void {
	if (!Array.isArray(value)) {
		finding(ctx, "invalid-legacy-shape", path, value, "mapping");
		return;
	}
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		if (
			!isRecord(entry) ||
			typeof entry.value !== "string" ||
			entry.value.length === 0 ||
			/\s/.test(entry.value)
		) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${path}[${index}]`,
				entry,
				"mapping",
			);
			continue;
		}
		if (seen.has(entry.value)) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${path}[${index}].value`,
				entry.value,
				"mapping",
			);
		}
		seen.add(entry.value);
	}
}

function frozenCaseTargetIsValid(
	value: unknown,
	allowed: "new" | "existing" | "any",
): boolean {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	switch (value.kind) {
		case "new":
			return (
				allowed !== "existing" &&
				frozenRecordShape(value, ["kind"], ["idFrom"]) &&
				(value.idFrom === undefined || isCanonicalAuthoredUuid(value.idFrom))
			);
		case "op":
			return (
				allowed !== "new" &&
				frozenRecordShape(value, ["kind", "opUuid"]) &&
				isCanonicalAuthoredUuid(value.opUuid)
			);
		case "session":
			return allowed !== "new" && frozenRecordShape(value, ["kind"]);
		case "expression":
			return (
				allowed !== "new" &&
				frozenRecordShape(value, ["kind", "expr"]) &&
				isFrozenValueExpression(value.expr)
			);
		default:
			return false;
	}
}

function validateCaseOperations(
	ctx: MutablePlanContext,
	value: unknown,
	path: string,
	formUuid: string,
): void {
	if (!Array.isArray(value)) {
		finding(ctx, "invalid-legacy-shape", path, value, "case-operation");
		return;
	}
	const priorCreates = new Set<string>();
	for (const [index, operation] of value.entries()) {
		const at = `${path}[${index}]`;
		if (!isRecord(operation) || typeof operation.action !== "string") {
			finding(ctx, "invalid-legacy-shape", at, operation, "case-operation");
			continue;
		}
		const common = ["uuid", "id", "action", "caseType", "target"] as const;
		const optionalCommon = ["condition", "forEach", "writes"] as const;
		const exact =
			operation.action === "create"
				? recordHasOnlyKeys(
						operation,
						[...common, "name"],
						[...optionalCommon, "owner", "links"],
					)
				: operation.action === "update"
					? recordHasOnlyKeys(operation, common, [
							...optionalCommon,
							"owner",
							"rename",
							"retype",
							"links",
						])
					: operation.action === "close"
						? recordHasOnlyKeys(operation, common, optionalCommon)
						: false;
		const target = operation.target;
		const targetValid =
			operation.action === "create"
				? frozenCaseTargetIsValid(target, "new")
				: frozenCaseTargetIsValid(target, "existing");
		const forEachValid =
			operation.forEach === undefined ||
			(frozenRecordShape(operation.forEach, ["repeat"]) &&
				isCanonicalAuthoredUuid(operation.forEach.repeat) &&
				ctx.rowsByUuid.get(operation.forEach.repeat)?.kind === "field" &&
				ctx.rowsByUuid.get(operation.forEach.repeat)?.data.kind === "repeat" &&
				ctx.fieldForm.get(operation.forEach.repeat) === formUuid);
		const targetOrderValid =
			!isRecord(target) ||
			target.kind !== "op" ||
			(typeof target.opUuid === "string" && priorCreates.has(target.opUuid));
		const writesValid =
			operation.writes === undefined ||
			(Array.isArray(operation.writes) &&
				new Set(
					operation.writes.flatMap((write) =>
						isRecord(write) && typeof write.property === "string"
							? [write.property]
							: [],
					),
				).size === operation.writes.length &&
				operation.writes.every(
					(write) =>
						frozenRecordShape(write, ["property", "value"], ["condition"]) &&
						typeof write.property === "string" &&
						CASE_PROPERTY.test(write.property) &&
						isFrozenValueExpression(write.value) &&
						(write.condition === undefined ||
							isFrozenPredicate(write.condition)),
				));
		const linksValid =
			operation.links === undefined ||
			(Array.isArray(operation.links) &&
				new Set(
					operation.links.flatMap((link) =>
						isRecord(link) && typeof link.identifier === "string"
							? [link.identifier]
							: [],
					),
				).size === operation.links.length &&
				operation.links.every(
					(link) =>
						frozenRecordShape(link, [
							"identifier",
							"targetType",
							"target",
							"relationship",
						]) &&
						typeof link.identifier === "string" &&
						typeof link.targetType === "string" &&
						CASE_PROPERTY.test(link.targetType) &&
						(link.target === null ||
							(frozenCaseTargetIsValid(link.target, "any") &&
								(!isRecord(link.target) ||
									link.target.kind !== "op" ||
									(typeof link.target.opUuid === "string" &&
										priorCreates.has(link.target.opUuid))))) &&
						(link.relationship === "child" ||
							link.relationship === "extension"),
				));
		const expressionFacetsValid =
			(operation.condition === undefined ||
				isFrozenPredicate(operation.condition)) &&
			(operation.name === undefined ||
				isFrozenValueExpression(operation.name)) &&
			(operation.owner === undefined ||
				isFrozenValueExpression(operation.owner)) &&
			(operation.rename === undefined ||
				isFrozenValueExpression(operation.rename));
		const scalarFacetsValid =
			isCanonicalAuthoredUuid(operation.uuid) &&
			typeof operation.id === "string" &&
			typeof operation.caseType === "string" &&
			CASE_PROPERTY.test(operation.caseType) &&
			(operation.retype === undefined ||
				(typeof operation.retype === "string" &&
					CASE_PROPERTY.test(operation.retype)));
		if (
			!exact ||
			!targetValid ||
			!targetOrderValid ||
			!forEachValid ||
			!writesValid ||
			!linksValid ||
			!expressionFacetsValid ||
			!scalarFacetsValid
		) {
			finding(ctx, "invalid-legacy-shape", at, operation, "case-operation");
		}
		if (
			operation.action === "create" &&
			isCanonicalAuthoredUuid(operation.uuid)
		) {
			priorCreates.add(operation.uuid);
		}
	}
}

function validateModuleFinalShape(
	ctx: MutablePlanContext,
	row: LegacyEntityRow,
	basePath: string,
): void {
	const config = row.data.caseListConfig;
	if (config !== undefined) {
		if (!isRecord(config)) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${basePath}.caseListConfig`,
				config,
				"case-list",
			);
			return;
		}
		const columns = Array.isArray(config.columns) ? config.columns : undefined;
		const inputs = Array.isArray(config.searchInputs)
			? config.searchInputs
			: undefined;
		if (columns === undefined || inputs === undefined) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${basePath}.caseListConfig`,
				config,
				"case-list",
			);
			return;
		}
		const columnIds = columns.flatMap((column) =>
			isRecord(column) && typeof column.uuid === "string" ? [column.uuid] : [],
		);
		for (const [orderKey, order] of [
			["listColumnOrder", config.listColumnOrder],
			["detailColumnOrder", config.detailColumnOrder],
		] as const) {
			if (
				!Array.isArray(order) ||
				order.length !== columnIds.length ||
				new Set(order).size !== order.length ||
				order.some((uuid) => !columnIds.includes(String(uuid)))
			) {
				finding(
					ctx,
					"invalid-legacy-shape",
					`${basePath}.caseListConfig.${orderKey}`,
					order,
					"column-order",
				);
			}
		}
		for (const [index, column] of columns.entries()) {
			if (!isRecord(column)) continue;
			if (column.kind === "id-mapping" || column.kind === "image-map") {
				validateMapping(
					ctx,
					column.mapping,
					`${basePath}.caseListConfig.columns[${index}].mapping`,
				);
			}
		}
		for (const [index, input] of inputs.entries()) {
			const at = `${basePath}.caseListConfig.searchInputs[${index}]`;
			if (!isRecord(input)) {
				finding(ctx, "invalid-legacy-shape", at, input, "search-input");
				continue;
			}
			if (
				input.type === "select" ||
				(isRecord(input.mode) && input.mode.kind === "multi-select-contains")
			) {
				finding(ctx, "invalid-legacy-shape", at, input, "search-input");
			}
			if (input.type === "date-range") {
				if (
					input.default !== undefined ||
					(input.kind === "simple" &&
						(!isRecord(input.mode) || input.mode.kind !== "range"))
				) {
					finding(ctx, "invalid-legacy-shape", at, input, "search-input");
				}
			} else if (
				input.kind === "simple" &&
				isRecord(input.mode) &&
				input.mode.kind === "range"
			) {
				finding(ctx, "invalid-legacy-shape", at, input, "search-input");
			}
			if (input.kind === "simple") {
				if (
					typeof input.property !== "string" ||
					input.property.length === 0 ||
					!CASE_PROPERTY.test(input.property)
				) {
					finding(
						ctx,
						"invalid-legacy-shape",
						`${at}.property`,
						input.property,
						"search-input",
					);
				}
			}
		}
	}
	const search = row.data.caseSearchConfig;
	if (search !== undefined) {
		if (!isRecord(search)) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${basePath}.caseSearchConfig`,
				search,
				"case-search",
			);
		} else if (
			search.searchActionEnabled === false &&
			(!Object.hasOwn(search, "excludedOwnerIds") ||
				Object.keys(search).some(
					(key) => key !== "searchActionEnabled" && key !== "excludedOwnerIds",
				) ||
				(isRecord(config) &&
					Array.isArray(config.searchInputs) &&
					config.searchInputs.length > 0))
		) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${basePath}.caseSearchConfig`,
				search,
				"case-search-owner-only",
			);
		} else if (
			search.searchActionEnabled !== undefined &&
			search.searchActionEnabled !== false
		) {
			finding(
				ctx,
				"invalid-legacy-shape",
				`${basePath}.caseSearchConfig.searchActionEnabled`,
				search.searchActionEnabled,
				"case-search-owner-only",
			);
		}
	}
}

function transformEntity(ctx: MutablePlanContext, row: LegacyEntityRow): void {
	const basePath = `entities.${row.kind}.${row.uuid}`;
	const moduleUuid = owningModuleUuid(ctx, row);
	if (row.kind === "field") transformSelect(ctx, row, basePath);
	if (row.kind === "field") transformFieldCaseWrite(ctx, row, basePath);
	if (row.kind === "form") {
		transformConnect(ctx, row, basePath);
	}
	if (row.kind === "module") validateModuleFinalShape(ctx, row, basePath);

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
	if (row.kind === "form" && row.data.caseOperations !== undefined) {
		validateCaseOperations(
			ctx,
			row.data.caseOperations,
			`${basePath}.caseOperations`,
			row.uuid,
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
		const migratedProperties: JsonRecord[] = [];
		const propertyByName = new Map<string, JsonRecord>();
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
			if (typeof property.name !== "string") {
				finding(
					ctx,
					"invalid-legacy-shape",
					`${path}.name`,
					property.name,
					"case-catalog-property",
				);
				continue;
			}
			const canonicalName = canonicalStandardProperty(property.name);
			if (canonicalName !== property.name) {
				property.name = canonicalName;
				ctx.rewrites.catalogProperties++;
			}
			const prior = propertyByName.get(canonicalName);
			if (prior !== undefined) {
				if (canonicalJson(prior) !== canonicalJson(property)) {
					finding(
						ctx,
						"invalid-legacy-shape",
						`${path}.name`,
						property,
						"case-catalog-property",
					);
				}
				continue;
			}
			propertyByName.set(canonicalName, property);
			migratedProperties.push(property);
		}
		caseType.properties = migratedProperties;
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
	verifyFinal = true,
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
	if (verifyFinal && ctx.findings.length === 0) {
		const finalProof = planCanonicalAppMigration(
			{
				...input,
				caseTypes: nextCaseTypes,
				rows,
			},
			false,
		);
		if (
			finalProof.findings.length > 0 ||
			finalProof.beforeDigest !== finalProof.afterDigest
		) {
			ctx.findings.push({
				disposition: "block-current",
				carrierId: "blueprint.final-parse",
				code: "invalid-legacy-shape",
				path: "blueprint.final-parse",
				digest: canonicalIdentityDigest({
					findings: finalProof.findings,
					beforeDigest: finalProof.beforeDigest,
					afterDigest: finalProof.afterDigest,
				}),
			});
		}
	}
	return {
		appId: input.appId,
		rows,
		caseTypes: nextCaseTypes,
		findings: ctx.findings.sort(
			(left, right) =>
				compareUtf8(left.path, right.path) ||
				compareUtf8(left.code, right.code),
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

export interface FrozenCaseTypeSchemaRewrite {
	readonly schema: unknown;
	readonly findings: readonly CanonicalIdentityFinding[];
	readonly rewrites: number;
}

const FROZEN_CASE_SCALAR_PROPERTIES = new Set([
	"case_id",
	"case_type",
	"case_name",
	"date_opened",
	"external_id",
	"last_modified",
	"owner_id",
	"status",
]);

function frozenCasePropertyJsonSchema(
	dataType: unknown,
): JsonRecord | undefined {
	switch (dataType) {
		case undefined:
		case "text":
			return { type: "string" };
		case "int":
			return {
				type: "integer",
				minimum: -2_147_483_648,
				maximum: 2_147_483_647,
			};
		case "decimal":
			return { type: "number" };
		case "date":
			return { type: "string", format: "date" };
		case "time":
			return { type: "string", format: "time" };
		case "datetime":
			return { type: "string", format: "date-time" };
		case "single_select":
			return { type: "string", "x-novaDataType": "single_select" };
		case "multi_select":
			return { type: "array", items: { type: "string" } };
		case "geopoint":
			return {
				type: "string",
				pattern:
					"^-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?: -?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?){3}$",
			};
		default:
			return undefined;
	}
}

/**
 * Rebuild the materialized case schema from the canonical frozen Blueprint
 * catalog. Standard metadata is column-backed and therefore omitted from the
 * JSON property document rather than renamed inside it.
 */
export function rewriteFrozenCaseTypeSchema(
	input: unknown,
	canonicalCaseType: unknown,
	path: string,
): FrozenCaseTypeSchemaRewrite {
	const findings: CanonicalIdentityFinding[] = [];
	const block = (at: string, value: unknown): void => {
		findings.push({
			disposition: "block-current",
			carrierId: "case-type-schema",
			code: "invalid-legacy-shape",
			path: at,
			digest: canonicalIdentityDigest(value),
		});
	};
	if (
		!isRecord(canonicalCaseType) ||
		typeof canonicalCaseType.name !== "string" ||
		!Array.isArray(canonicalCaseType.properties)
	) {
		block(path, canonicalCaseType);
		return { schema: cloneJson(input), findings, rewrites: 0 };
	}
	const properties: JsonRecord = {};
	for (const [index, value] of canonicalCaseType.properties.entries()) {
		if (!isRecord(value) || typeof value.name !== "string") {
			block(`${path}.catalog[${index}]`, value);
			continue;
		}
		if (FROZEN_CASE_SCALAR_PROPERTIES.has(value.name)) continue;
		const propertySchema = frozenCasePropertyJsonSchema(value.data_type);
		if (propertySchema === undefined) {
			block(`${path}.catalog[${index}].data_type`, value.data_type);
			continue;
		}
		properties[value.name] = propertySchema;
	}
	const schema = {
		type: "object",
		properties,
		additionalProperties: false,
	};
	return {
		schema,
		findings,
		rewrites: canonicalJson(input) === canonicalJson(schema) ? 0 : 1,
	};
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
				disposition: "block-current",
				carrierId: "lookup-table",
				code: "invalid-lookup-uuid",
				path: `lookup_tables.${canonicalIdentityDigest(table.id)}.id`,
				digest: canonicalIdentityDigest(table.id),
			});
		}
	}
	for (const column of snapshot.columns) {
		if (!UUID_V7.test(column.tableId) || !UUID_V7.test(column.id)) {
			findings.push({
				disposition: "block-current",
				carrierId: "lookup-column",
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
				disposition: "block-current",
				carrierId: "lookup-row",
				code: "invalid-lookup-uuid",
				path: `lookup_rows.${canonicalIdentityDigest(row.id)}.id`,
				digest: canonicalIdentityDigest(row),
			});
		}
		if (!tableIds.has(row.tableId)) {
			findings.push({
				disposition: "block-current",
				carrierId: "lookup-row",
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
					disposition: "block-current",
					carrierId: "lookup-row-value",
					code: "invalid-lookup-uuid",
					path: `lookup_rows.${canonicalIdentityDigest(row.id)}.values.${canonicalIdentityDigest(key)}`,
					digest: canonicalIdentityDigest(key),
				});
			} else if (!columns.has(key)) {
				findings.push({
					disposition: "block-current",
					carrierId: "lookup-row-value",
					code: "unresolved-reference",
					path: `lookup_rows.${canonicalIdentityDigest(row.id)}.values.${canonicalIdentityDigest(key)}`,
					digest: canonicalIdentityDigest(key),
				});
			}
		}
	}
	return findings.sort(
		(left, right) =>
			compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code),
	);
}
