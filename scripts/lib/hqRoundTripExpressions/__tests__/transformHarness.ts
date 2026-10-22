/**
 * The transform's test harness over the frozen pre-step fixtures: each
 * fixture's raw carriers, the context its manifest entry states, and each
 * fault applied at the boundary that owns it (part 09 §15: an admitted raw
 * fixture plus explicit fault or context metadata, never an invalid captured
 * document).
 *
 * The stored `case_type_schemas` rows are the ones pull request 2's head
 * derived from each fixture (`fixtures/base-census.json`), which is what a
 * stored app holds before the cutover.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { blueprintScalars, decomposeBlueprint } from "@/lib/db/blueprintRows";
import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { ALL_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import { builtinAssetRows } from "@/lib/media/builtinIconAssets";
import type { RawCarriers } from "../oldShape";
import { liftRoundTripStep } from "../steps/liftRoundTrip";
import {
	EXPRESSIONS_STEPS,
	type TransformOptions,
	transformApp,
} from "../transform";
import type { TransformContext, TransformResult } from "../types";

const FIXTURES = join(import.meta.dirname, "fixtures");

export interface Fault {
	readonly stage: string;
	readonly operation: string;
	readonly entity?: string;
	readonly uuid?: string;
	readonly path?: readonly (string | number)[];
	readonly value?: unknown;
	readonly blocker: string;
}

export interface ManifestFixture {
	readonly id: string;
	readonly kind: "corpus" | "synthetic";
	readonly source: { readonly document?: string };
	readonly steps: readonly string[];
	readonly classes: readonly string[];
	readonly blockers: readonly string[];
	readonly rules: readonly string[];
	readonly reasons: readonly string[];
	readonly context?: {
		readonly cases?: readonly {
			readonly caseType: string;
			readonly properties: Readonly<Record<string, string>>;
		}[];
		readonly caseSchema?: { readonly unexpectedProperty: string };
	};
	readonly faults?: readonly Fault[];
}

export const MANIFEST: readonly ManifestFixture[] = (
	JSON.parse(
		readFileSync(join(FIXTURES, "pre-step", "manifest.json"), "utf8"),
	) as { fixtures: ManifestFixture[] }
).fixtures;

export function manifestFixture(id: string): ManifestFixture {
	const fixture = MANIFEST.find((entry) => entry.id === id);
	if (fixture === undefined) throw new Error(`No pre-step fixture ${id}`);
	return fixture;
}

const BASE_SCHEMAS: ReadonlyMap<
	string,
	Readonly<Record<string, string>>
> = new Map(
	(
		JSON.parse(readFileSync(join(FIXTURES, "base-census.json"), "utf8")) as {
			fixtures: {
				fixture: string;
				caseTypeSchemas: Record<string, string>;
			}[];
		}
	).fixtures.map((entry) => [entry.fixture, entry.caseTypeSchemas]),
);

export function fixtureCarriers(id: string): RawCarriers {
	return JSON.parse(
		readFileSync(join(FIXTURES, "pre-step", id, "carriers.json"), "utf8"),
	) as RawCarriers;
}

/** Every fixture runs as this app, in a Project with no lookup tables. */
export const APP_ID = "01992000-0000-7000-8000-0000000000a1";
const NO_TABLES: LookupValidationContext = {
	kind: "available",
	projectId: "project-pre-step-fixtures",
	projectRevision: "0",
	definitions: [],
} as unknown as LookupValidationContext;

/** The context the fixture's manifest entry states, over its base schemas. */
export function fixtureContext(fixture: ManifestFixture): TransformContext {
	const schemas = new Map(Object.entries(BASE_SCHEMAS.get(fixture.id) ?? {}));
	const unexpected = fixture.context?.caseSchema?.unexpectedProperty;
	if (unexpected !== undefined) {
		const [caseType, text] = [...schemas][0] ?? [];
		if (caseType === undefined || text === undefined)
			throw new Error(`${fixture.id} has no stored schema to add to`);
		const schema = JSON.parse(text) as {
			properties: Record<string, unknown>;
		};
		schema.properties[unexpected] = { type: "string" };
		schemas.set(caseType, JSON.stringify(schema));
	}
	const keys = new Map<string, Map<string, number>>();
	for (const row of fixture.context?.cases ?? []) {
		const byKey = keys.get(row.caseType) ?? new Map<string, number>();
		for (const key of Object.keys(row.properties))
			byKey.set(key, (byKey.get(key) ?? 0) + 1);
		keys.set(row.caseType, byKey);
	}
	return {
		appId: APP_ID,
		projectId: "project-pre-step-fixtures",
		lookupContext: NO_TABLES,
		mediaAssets: new Map(
			builtinAssetRows(ALL_ICON_SLUGS).map((record) => [
				record.id as string,
				record,
			]),
		),
		storedCaseSchemas: schemas,
		storedCaseKeys: keys,
	};
}

function setAt(
	target: Record<string, unknown>,
	path: readonly (string | number)[],
	value: unknown,
): void {
	let cursor: unknown = target;
	for (const segment of path.slice(0, -1))
		cursor = (cursor as Record<string | number, unknown>)[segment];
	(cursor as Record<string | number, unknown>)[path[path.length - 1]] = value;
}

/** The carriers with one stored-shape fault applied. */
export function withFault(carriers: RawCarriers, fault: Fault): RawCarriers {
	const rows = carriers.rows.map((row) => ({ ...row }));
	if (fault.stage === "old-shape" && fault.operation === "remove-field")
		return {
			root: carriers.root,
			rows: rows.filter((row) => row.uuid !== fault.uuid),
		};
	if (fault.stage === "old-shape" && fault.operation === "replace-slot") {
		const row = rows.find((entry) => entry.uuid === fault.entity);
		if (row === undefined || fault.path === undefined)
			throw new Error(`The fault names no row: ${JSON.stringify(fault)}`);
		const data = JSON.parse(row.data_text) as Record<string, unknown>;
		setAt(data, fault.path, fault.value);
		row.data_text = JSON.stringify(data);
		return { root: carriers.root, rows };
	}
	if (fault.stage === "target-parse" && fault.operation === "reject") {
		// A key no head schema holds: the target's own parse refuses it.
		const row = rows.find((entry) => entry.kind === "field");
		if (row === undefined) throw new Error("The fixture holds no field row");
		row.data_text = JSON.stringify({
			...(JSON.parse(row.data_text) as object),
			unknownKey: true,
		});
		return { root: carriers.root, rows };
	}
	throw new Error(`No carrier fault ${fault.stage}/${fault.operation}`);
}

const EXPORT_REFUSAL: ValidationError = {
	code: "MEDIA_ASSET_NOT_FOUND",
	scope: "app",
	message: "An injected export-readiness refusal.",
	location: {},
} as ValidationError;

/** The options a fault at the transform's own boundaries asks for. */
export function faultOptions(fault: Fault): TransformOptions | undefined {
	if (fault.stage === "target-export-readiness" && fault.operation === "reject")
		return { exportReadiness: () => [EXPORT_REFUSAL] };
	if (
		fault.stage === "lift-round-trip" &&
		fault.operation === "change-printed-expression"
	)
		return {
			steps: [
				...EXPRESSIONS_STEPS.slice(0, -1),
				// A print that says something else than the tree it was given.
				liftRoundTripStep(() => "1 + 1"),
			],
		};
	return undefined;
}

/** One fixture's transform, as stored, with no fault. */
export function transformFixture(id: string): TransformResult {
	const fixture = manifestFixture(id);
	return transformApp(fixtureCarriers(id), fixtureContext(fixture));
}

/** One fixture's transform under one of its faults. */
export function transformWithFault(id: string, fault: Fault): TransformResult {
	const fixture = manifestFixture(id);
	const options = faultOptions(fault);
	const carriers =
		options === undefined
			? withFault(fixtureCarriers(id), fault)
			: fixtureCarriers(id);
	return transformApp(carriers, fixtureContext(fixture), options);
}

/** The `case_type_schemas` rows the drift writer leaves for a target, the worker's case aside. */
export function derivedCaseSchemas(doc: PersistableDoc): Map<string, string> {
	return new Map(
		[...buildCaseTypeMap(doc)]
			.filter(([name]) => name !== USERCASE_CASE_TYPE)
			.map(([name, caseType]) => [
				name,
				JSON.stringify(caseTypeToJsonSchema(caseType)),
			]),
	);
}

/** A number as PostgreSQL's `jsonb::text` spells it: the shortest digits, never an exponent. */
function plainNumber(value: number): string {
	const text = String(value);
	const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/u.exec(text);
	if (match === null) return text;
	const [, sign, lead, rest = "", exponentText] = match;
	const digits = `${lead}${rest}`;
	const point = 1 + Number(exponentText);
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length)
		return `${sign}${digits}${"0".repeat(point - digits.length)}`;
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** JSON text as the carriers hold it, numbers in `jsonb::text`'s spelling. */
function jsonbText(value: unknown): string {
	if (typeof value === "number") return plainNumber(value);
	if (Array.isArray(value)) return `[${value.map(jsonbText).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.map(([key, entry]) => `${JSON.stringify(key)}:${jsonbText(entry)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** A target as the writer stores it: its root columns and entity rows as text. */
export function carriersOfDoc(doc: PersistableDoc): RawCarriers {
	const scalars = blueprintScalars(doc);
	const root: PersistedBlueprintRootText = {
		app_name: scalars.app_name,
		connect_type: scalars.connect_type,
		case_types_text:
			scalars.case_types === null ? null : jsonbText(scalars.case_types),
		localization_text:
			scalars.localization === undefined
				? null
				: jsonbText(scalars.localization),
		app_settings_text:
			scalars.app_settings === null ? null : jsonbText(scalars.app_settings),
		logo: scalars.logo as PersistedBlueprintRootText["logo"],
	};
	const rows: PersistedEntityRowText[] = decomposeBlueprint(doc).map((row) => ({
		uuid: row.uuid,
		kind: row.kind,
		parent_uuid: row.parent_uuid,
		ordinal: row.ordinal,
		data_text: jsonbText(row.data),
	}));
	return { root, rows };
}
