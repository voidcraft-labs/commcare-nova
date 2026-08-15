/**
 * Permanent steady-state boundary for JSONB-backed Blueprint state.
 *
 * `pg` eagerly applies `JSON.parse` to json/jsonb result columns. That loses
 * the original numeric token before Nova can determine whether two distinct
 * persisted values collapse to the same JavaScript number. Blueprint readers
 * therefore select `jsonb::text` and enter through this module. PostgreSQL's
 * canonical JSONB output is a plain decimal token (never exponent notation).
 * The parser admits only the unique storage-decimal round-trip representative
 * of a finite JavaScript number.
 *
 * This is ordinary runtime code, not a compatibility decoder. It knows only
 * the one current Blueprint schema, and `assembleBlueprint` remains the strict
 * schema boundary after exact JSON parsing.
 */

import {
	type AdmittedMutationBatch,
	admitMutationBatch,
} from "@/lib/doc/mutationAdmission";
import type {
	AppLocalization,
	ConnectType,
	MediaAssetId,
	PersistableDoc,
	Uuid,
} from "@/lib/domain";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import {
	APP_CHANGE_KINDS,
	type AppChangeKind,
	type BlueprintMutationAppChangeKind,
} from "./types";

export { nextPersistedSequence, safePersistedSequence };

import {
	assembleBlueprint,
	type EntityRow,
	type EntityRowKind,
} from "./blueprintRows";

type JsonRecord = Record<string, unknown>;

export interface PersistedBlueprintRootText {
	readonly app_name: string;
	readonly connect_type: ConnectType | null;
	readonly case_types_text: string | null;
	readonly localization_text?: string | null;
	readonly logo: MediaAssetId | null;
}

export interface PersistedEntityRowText {
	readonly uuid: Uuid;
	readonly kind: EntityRowKind;
	readonly parent_uuid: Uuid | null;
	readonly ordinal: number;
	readonly data_text: string;
}

export interface PersistedAppChangeEnvelopeText {
	readonly seq: string | number;
	readonly batchId: string;
	readonly runId: string | null;
	readonly actorId: string;
	readonly kind: string;
	readonly mutationsText: string;
	readonly fromProjectId: string | null;
	readonly toProjectId: string | null;
}

interface AdmittedDurableAppChangeBase {
	readonly seq: number;
	readonly batchId: string;
	readonly runId?: string;
	readonly actorId: string;
	readonly mutations: AdmittedMutationBatch;
}

export type AdmittedDurableAppChange =
	| (AdmittedDurableAppChangeBase & {
			readonly kind: BlueprintMutationAppChangeKind;
			readonly fromProjectId?: never;
			readonly toProjectId?: never;
	  })
	| (AdmittedDurableAppChangeBase & {
			readonly kind: "fold-baseline";
			readonly fromProjectId?: never;
			readonly toProjectId?: never;
	  })
	| (AdmittedDurableAppChangeBase & {
			readonly kind: "project-move";
			readonly fromProjectId: string;
			readonly toProjectId: string;
	  });

export class PersistedJsonRejectedError extends Error {
	readonly name = "PersistedJsonRejectedError";

	constructor(
		readonly context: string,
		readonly offset: number,
		reason: string,
	) {
		super(
			`${context} contains invalid persisted JSON at character offset ${offset}: ${reason}`,
		);
	}
}

interface NormalizedDecimal {
	readonly negative: boolean;
	readonly digits: string;
	readonly exponent: bigint;
}

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const COMPLETE_JSON_NUMBER =
	/^(?<sign>-)?(?<integer>0|[1-9][0-9]*)(?:\.(?<fraction>[0-9]+))?(?:[eE](?<exponent>[+-]?[0-9]+))?$/;

/** Canonical mathematical decimal value of one complete JSON number token. */
function normalizeDecimal(raw: string): NormalizedDecimal {
	const match = COMPLETE_JSON_NUMBER.exec(raw);
	if (match?.groups === undefined) {
		throw new Error("normalizeDecimal requires one complete JSON number");
	}
	const fraction = match.groups.fraction ?? "";
	let digits = `${match.groups.integer}${fraction}`.replace(/^0+/, "");
	let exponent = BigInt(match.groups.exponent ?? "0") - BigInt(fraction.length);
	if (digits.length === 0) {
		return { negative: false, digits: "0", exponent: BigInt(0) };
	}
	const trailingZeroes = /0+$/.exec(digits)?.[0].length ?? 0;
	if (trailingZeroes > 0) {
		digits = digits.slice(0, -trailingZeroes);
		exponent += BigInt(trailingZeroes);
	}
	return {
		negative: match.groups.sign === "-",
		digits,
		exponent,
	};
}

function sameDecimalValue(left: string, right: string): boolean {
	const a = normalizeDecimal(left);
	const b = normalizeDecimal(right);
	return (
		a.negative === b.negative &&
		a.digits === b.digits &&
		a.exponent === b.exponent
	);
}

function admittedJsonNumber(
	raw: string,
	fail: (reason: string) => never,
): number {
	const match = COMPLETE_JSON_NUMBER.exec(raw);
	if (match?.groups === undefined) {
		return fail("number token does not use complete JSON number syntax");
	}
	if (match.groups.exponent !== undefined) {
		return fail(
			"number token uses exponent notation, which PostgreSQL jsonb::text never emits",
		);
	}
	const exact = normalizeDecimal(raw);
	if (exact.digits === "0" && raw !== "0") {
		return fail("number token is a noncanonical spelling of zero");
	}
	if (match.groups.fraction?.endsWith("0") === true) {
		return fail("number token has a noncanonical trailing fractional zero");
	}
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		return fail("number token is not a finite JavaScript number");
	}
	if (exact.digits !== "0" && value === 0) {
		return fail("number token underflows to zero");
	}
	if (match.groups.fraction === undefined && !Number.isSafeInteger(value)) {
		return fail("integral number token is outside the safe-integer range");
	}
	const printed = JSON.stringify(value);
	if (printed === undefined || !sameDecimalValue(raw, printed)) {
		return fail(
			"number token is not the unique storage-decimal round-trip representative of its JavaScript number",
		);
	}
	return value;
}

/**
 * Parse one PostgreSQL `jsonb::text` value without ever exposing its numeric
 * tokens to the driver's eager JSON parser. Objects are built with a null
 * prototype, so `__proto__`, `constructor`, and other prototype-shaped keys
 * remain ordinary own data throughout schema admission.
 */
export function parsePersistedJsonText(
	source: string,
	context = "Persisted JSON",
): unknown {
	let offset = 0;
	const fail = (reason: string): never => {
		throw new PersistedJsonRejectedError(context, offset, reason);
	};
	const whitespace = () => {
		while (
			source[offset] === " " ||
			source[offset] === "\n" ||
			source[offset] === "\r" ||
			source[offset] === "\t"
		) {
			offset += 1;
		}
	};
	const stringValue = (): string => {
		if (source[offset] !== '"') return fail("expected a string");
		const start = offset;
		offset += 1;
		let escaped = false;
		while (offset < source.length) {
			const character = source[offset];
			offset += 1;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') {
				try {
					return JSON.parse(source.slice(start, offset)) as string;
				} catch {
					return fail("invalid string escape");
				}
			}
			if (character !== undefined && character.charCodeAt(0) < 0x20) {
				return fail("unescaped control character in string");
			}
		}
		return fail("unterminated string");
	};
	const value = (): unknown => {
		whitespace();
		const character = source[offset];
		if (character === '"') return stringValue();
		if (character === "[") {
			offset += 1;
			const entries: unknown[] = [];
			whitespace();
			if (source[offset] === "]") {
				offset += 1;
				return entries;
			}
			while (true) {
				entries.push(value());
				whitespace();
				if (source[offset] === "]") {
					offset += 1;
					return entries;
				}
				if (source[offset] !== ",") return fail("expected an array comma");
				offset += 1;
			}
		}
		if (character === "{") {
			offset += 1;
			const result = Object.create(null) as JsonRecord;
			whitespace();
			if (source[offset] === "}") {
				offset += 1;
				return result;
			}
			while (true) {
				whitespace();
				const key = stringValue();
				if (Object.hasOwn(result, key)) {
					return fail("duplicate object key");
				}
				whitespace();
				if (source[offset] !== ":") return fail("expected an object colon");
				offset += 1;
				Object.defineProperty(result, key, {
					value: value(),
					enumerable: true,
					configurable: true,
					writable: true,
				});
				whitespace();
				if (source[offset] === "}") {
					offset += 1;
					return result;
				}
				if (source[offset] !== ",") return fail("expected an object comma");
				offset += 1;
			}
		}
		for (const [literal, parsed] of [
			["true", true],
			["false", false],
			["null", null],
		] as const) {
			if (source.startsWith(literal, offset)) {
				offset += literal.length;
				return parsed;
			}
		}
		const numeric = JSON_NUMBER.exec(source.slice(offset))?.[0];
		if (numeric !== undefined) {
			const numericOffset = offset;
			offset += numeric.length;
			return admittedJsonNumber(numeric, (reason) => {
				offset = numericOffset;
				return fail(reason);
			});
		}
		return fail("expected a JSON value");
	};

	const parsed = value();
	whitespace();
	if (offset !== source.length) fail("trailing content");
	return parsed;
}

/** Parse and structurally admit one durable app-change mutation body. */
export function parsePersistedMutationBatchText(
	source: string,
	context = "app_changes.mutations",
): AdmittedMutationBatch {
	return admitMutationBatch(parsePersistedJsonText(source, context));
}

const APP_CHANGE_KIND_SET: ReadonlySet<string> = new Set(APP_CHANGE_KINDS);
const APP_CHANGE_ENVELOPE_KEYS = new Set([
	"seq",
	"batchId",
	"runId",
	"actorId",
	"kind",
	"mutationsText",
	"fromProjectId",
	"toProjectId",
]);

function nonblank(value: string): boolean {
	return value.trim().length > 0;
}

function isAppChangeKind(value: unknown): value is AppChangeKind {
	return typeof value === "string" && APP_CHANGE_KIND_SET.has(value);
}

/**
 * Strict server authority for one durable `app_changes` envelope.
 *
 * This is deliberately separate from the browser mutation-frame grammar:
 * browser reconciliation knows only autosave/MCP/chat, while this parser
 * admits all six durable kinds and enforces their exact empty-batch and
 * Project-scope arms before a stream cursor or canonical fold may advance.
 */
export function parsePersistedAppChangeEnvelope(
	value: unknown,
	context = "app_changes row",
): AdmittedDurableAppChange {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${context} must be an object.`);
	}
	const keys = Reflect.ownKeys(value);
	if (
		keys.some(
			(key) => typeof key !== "string" || !APP_CHANGE_ENVELOPE_KEYS.has(key),
		) ||
		keys.length !== APP_CHANGE_ENVELOPE_KEYS.size
	) {
		throw new Error(`${context} has an invalid durable envelope shape.`);
	}
	const row = value as PersistedAppChangeEnvelopeText;
	if (
		(typeof row.seq !== "string" && typeof row.seq !== "number") ||
		typeof row.batchId !== "string" ||
		typeof row.actorId !== "string"
	) {
		throw new Error(`${context} has an invalid durable identity type.`);
	}
	const seq = safePersistedSequence(row.seq, `${context}.seq`);
	if (seq < 1) throw new Error(`${context}.seq must be positive.`);
	if (!nonblank(row.batchId) || !nonblank(row.actorId)) {
		throw new Error(`${context} has a blank durable identity.`);
	}
	if (
		row.runId !== null &&
		(typeof row.runId !== "string" || !nonblank(row.runId))
	) {
		throw new Error(`${context}.runId must be null or nonblank.`);
	}
	if (!isAppChangeKind(row.kind)) {
		throw new Error(`${context}.kind is invalid.`);
	}
	if (typeof row.mutationsText !== "string") {
		throw new Error(`${context}.mutationsText must be text.`);
	}
	const mutations = parsePersistedMutationBatchText(
		row.mutationsText,
		`${context}.mutations`,
	);
	const base = {
		seq,
		batchId: row.batchId,
		...(row.runId === null ? {} : { runId: row.runId }),
		actorId: row.actorId,
		mutations,
	};

	if (row.kind === "project-move") {
		if (
			typeof row.fromProjectId !== "string" ||
			!nonblank(row.fromProjectId) ||
			typeof row.toProjectId !== "string" ||
			!nonblank(row.toProjectId) ||
			row.fromProjectId === row.toProjectId
		) {
			throw new Error(
				`${context} project move must carry distinct nonblank Project identities.`,
			);
		}
		return {
			...base,
			kind: "project-move",
			fromProjectId: row.fromProjectId,
			toProjectId: row.toProjectId,
		};
	}

	if (row.fromProjectId !== null || row.toProjectId !== null) {
		throw new Error(
			`${context} carries Project identities outside a project move.`,
		);
	}
	if (row.kind === "fold-baseline") {
		if (mutations.length !== 0) {
			throw new Error(`${context} fold baseline must have no mutations.`);
		}
		return { ...base, kind: "fold-baseline" };
	}
	if (mutations.length === 0) {
		throw new Error(`${context} ${row.kind} must carry mutations.`);
	}
	return {
		...base,
		kind: row.kind,
	};
}

function parseEntityRow(row: PersistedEntityRowText, appId: string): EntityRow {
	const parsed = parsePersistedJsonText(
		row.data_text,
		`blueprint_entities.data for app ${appId}, entity ${row.uuid}`,
	);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new PersistedJsonRejectedError(
			`blueprint_entities.data for app ${appId}, entity ${row.uuid}`,
			0,
			"entity data must be a JSON object",
		);
	}
	return {
		uuid: row.uuid,
		kind: row.kind,
		parent_uuid: row.parent_uuid,
		ordinal: row.ordinal,
		data: parsed as Record<string, unknown>,
	};
}

/**
 * The sole ordinary runtime path from persisted Blueprint carrier text to a
 * schema-admitted `PersistableDoc`.
 */
export function assemblePersistedBlueprintJsonText(
	appId: string,
	root: PersistedBlueprintRootText,
	rows: readonly PersistedEntityRowText[],
): PersistableDoc {
	return assembleBlueprint(
		appId,
		{
			app_name: root.app_name,
			connect_type: root.connect_type,
			case_types:
				root.case_types_text === null
					? null
					: (parsePersistedJsonText(
							root.case_types_text,
							`apps.case_types for app ${appId}`,
						) as PersistableDoc["caseTypes"]),
			localization:
				root.localization_text === null || root.localization_text === undefined
					? undefined
					: (parsePersistedJsonText(
							root.localization_text,
							`apps.localization for app ${appId}`,
						) as AppLocalization),
			logo: root.logo,
		},
		rows.map((row) => parseEntityRow(row, appId)),
	);
}
