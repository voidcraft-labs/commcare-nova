/**
 * Rewrite every persisted spelling of the retired free-code language shape
 * into the structured-identity form, in place, across the four stores that
 * can hold it: `apps.localization` roots, `app_changes` mutation payloads,
 * `app_change_fold_baselines` snapshots, and translation-batch state
 * (`design_localization_attempts.intent` + `intent_digest` and the
 * `design_localization_batches` language columns).
 *
 * This module is the ONE reader of the old shape in the codebase: the
 * private Zod parsers below mirror the retired schemas exactly, and nothing
 * outside this file may accept them. Each app repairs in a single
 * transaction, and a rewritten app is proved before commit: the canonical
 * fold from its greatest baseline over the rewritten rows must reach exactly
 * the rewritten head (strictly admitted and passing the absolute commit
 * gate). A fleet postcondition then re-plans every app expecting nothing
 * left to rewrite, so a second run is a no-op.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";
import {
	type DesignLocalizationIntent,
	designLocalizationIntentSchema,
} from "../../lib/agent/design/contract";
import { loadAppInTransaction } from "../../lib/db/apps";
import {
	type CanonicalAppChangeSuffixRow,
	foldCanonicalAppChangeSuffixBounded,
} from "../../lib/db/canonicalMutationFold";
import { parsePersistedJsonText } from "../../lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "../../lib/db/pg";
import { mutationSchema } from "../../lib/doc/types";
import {
	identityIssues,
	languageCodeVerdict,
	languageDirection,
} from "../../lib/domain/languageRegistry";
import { languageDescriptor } from "../../lib/domain/languageRegistry/names";
import {
	type AppLanguageIdentity,
	appLanguageIdentitySchema,
	appLocalizationSchema,
	type LanguageTag,
	languageTag,
	languageTagSchema,
	localizedValueSchema,
	parseLanguageTag,
	translationUnitIdSchema,
} from "../../lib/domain/localization";
import { ownRecordSchema } from "../../lib/domain/records";
import { canonicalJsonDigest } from "../../lib/utils/canonicalJson";
import { safePersistedSequence } from "../../lib/utils/persistedSequence";

// ── The old shape, quarantined ─────────────────────────────────────
//
// These parsers mirror the retired schemas byte-for-byte at the shape level;
// the retired superRefine invariants are deliberately omitted because the
// rewritten output is validated with the current canonical schemas, which is
// the gate that matters.

const OLD_LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z]+)?$/;
const oldLanguageCodeSchema = z.string().regex(OLD_LANGUAGE_CODE_PATTERN);

const oldAppLanguageSchema = z
	.object({
		code: oldLanguageCodeSchema,
		name: z.string().trim().min(1),
		direction: z.enum(["ltr", "rtl"]),
	})
	.strict();
type OldAppLanguage = z.infer<typeof oldAppLanguageSchema>;

const oldTranslationEntrySchema = z
	.object({
		value: localizedValueSchema,
		sourceFingerprint: z.string().min(1),
		origin: z.enum(["copied", "ai", "human"]),
		review: z.enum(["needs-review", "reviewed"]),
		translatedFrom: oldLanguageCodeSchema,
	})
	.strict();

const oldAppLocalizationSchema = z
	.object({
		sourceLanguage: oldLanguageCodeSchema,
		defaultLanguage: oldLanguageCodeSchema,
		languageOrder: z.array(oldLanguageCodeSchema).min(1),
		languages: ownRecordSchema(oldLanguageCodeSchema, oldAppLanguageSchema),
		translations: ownRecordSchema(
			oldLanguageCodeSchema,
			ownRecordSchema(translationUnitIdSchema, oldTranslationEntrySchema),
		),
	})
	.strict();
type OldAppLocalization = z.infer<typeof oldAppLocalizationSchema>;

const oldDesignLanguageSchema = z
	.object({
		code: oldLanguageCodeSchema,
		name: z.string().trim().min(1),
		direction: z.enum(["ltr", "rtl"]),
	})
	.strict();

const oldDesignTargetSchema = z
	.object({
		language: oldDesignLanguageSchema,
		seedFrom: oldLanguageCodeSchema,
		strategy: z.enum(["copy-only", "translate-with-nova"]),
	})
	.strict();

const oldDesignIntentSchema = z
	.object({
		sourceLanguage: oldDesignLanguageSchema,
		defaultLanguage: oldLanguageCodeSchema,
		targets: z.array(oldDesignTargetSchema).max(32),
	})
	.strict();

// Old-shape mutation payloads. Reference kinds are parsed with a lenient
// string in the language slot because the old code grammar and the canonical
// tag grammar overlap on bare three-letter codes; the mapping decides.

const oldIdentityCarrierSchema = z
	.object({
		kind: z.enum(["relabelSourceLanguage", "addLanguage"]),
		language: oldAppLanguageSchema,
	})
	.strict();

const newIdentityCarrierSchema = z
	.object({
		kind: z.enum(["relabelSourceLanguage", "addLanguage"]),
		language: appLanguageIdentitySchema,
	})
	.strict();

const oldUpdateLanguageSchema = z
	.object({
		kind: z.literal("updateLanguage"),
		code: oldLanguageCodeSchema,
		patch: z
			.object({
				name: z.string().trim().min(1).optional(),
				direction: z.enum(["ltr", "rtl"]).optional(),
			})
			.strict(),
	})
	.strict();

const codeReferenceCarrierSchema = z
	.object({
		kind: z.enum(["removeLanguage", "setDefaultLanguage"]),
		code: z.string().min(1),
	})
	.strict();

const anyCodeTranslationEntrySchema = z
	.object({
		value: localizedValueSchema,
		sourceFingerprint: z.string().min(1),
		origin: z.enum(["copied", "ai", "human"]),
		review: z.enum(["needs-review", "reviewed"]),
		translatedFrom: z.string().min(1),
	})
	.strict();

const setTranslationCarrierSchema = z
	.object({
		kind: z.literal("setTranslation"),
		language: z.string().min(1),
		unitId: translationUnitIdSchema,
		entry: anyCodeTranslationEntrySchema.nullable(),
	})
	.strict();

const reviewTranslationCarrierSchema = z
	.object({
		kind: z.literal("reviewTranslation"),
		language: z.string().min(1),
		unitId: translationUnitIdSchema,
		expectedSourceFingerprint: z.string().min(1),
		sourceFingerprint: z.string().min(1),
		value: localizedValueSchema,
	})
	.strict();

const LOCALIZATION_MUTATION_KINDS = [
	"relabelSourceLanguage",
	"addLanguage",
	"updateLanguage",
	"removeLanguage",
	"setDefaultLanguage",
	"setTranslation",
	"reviewTranslation",
] as const;
const LOCALIZATION_MUTATION_KIND_SET: ReadonlySet<string> = new Set(
	LOCALIZATION_MUTATION_KINDS,
);

const rewrittenMutationBatchSchema = z.array(mutationSchema).min(1);

// ── The code mapping ───────────────────────────────────────────────

/** Each retired macrolanguage code resolves to its predominant individual
 * member, the same preference the retired capability tables used. A member
 * that then needs a script choice still fails closed to the explicit table. */
const MACRO_PREDOMINANT_MEMBER: Readonly<Record<string, string>> = {
	zho: "cmn",
	ara: "arb",
	swa: "swh",
	fas: "pes",
	ori: "ory",
	nep: "npi",
	msa: "zlm",
	uzb: "uzn",
};

/** The retired variety-alias spellings, exactly as the old catalog stored
 * them: a Set 1 prefix plus the individual member as the suffix. */
const OLD_VARIETY_ALIASES: Readonly<Record<string, string>> = {
	"zh-cmn": "cmn",
	"zh-yue": "yue",
	"zh-wuu": "wuu",
	"zh-cjy": "cjy",
	"zh-nan": "nan",
	"zh-hak": "hak",
	"zh-hsn": "hsn",
	"ar-arb": "arb",
	"ar-arz": "arz",
	"ar-apc": "apc",
	"ar-apd": "apd",
	"ar-arq": "arq",
	"ar-ary": "ary",
	"fa-pes": "pes",
	"fa-prs": "prs",
	"pa-pan": "pan",
	"pa-pnb": "pnb",
	"ms-zlm": "zlm",
	"sw-swh": "swh",
	"or-ory": "ory",
	"ne-npi": "npi",
	"uz-uzn": "uzn",
};

/**
 * Reviewed identities for stored codes the mechanical rules cannot decide.
 * The scan names every code that needs an entry; the migrate run refuses to
 * write while one is missing. A key is the exact stored old code; the value
 * is the complete lawful identity it becomes.
 */
export const LANGUAGE_IDENTITY_EXPLICIT_MAPPINGS: Readonly<
	Record<string, AppLanguageIdentity>
> = {};

export type OldLanguageCodeMapping =
	| { readonly kind: "canonical"; readonly tag: LanguageTag }
	| {
			readonly kind: "mechanical" | "explicit";
			readonly identity: AppLanguageIdentity;
			readonly tag: LanguageTag;
	  }
	| { readonly kind: "needs-explicit"; readonly reason: string };

function resolveBareLanguage(bare: string): string | undefined {
	const verdict = languageCodeVerdict(bare);
	if (verdict.kind === "individual-living") return bare;
	if (verdict.kind === "set1-alias") return verdict.resolved;
	if (verdict.kind === "macrolanguage") {
		return MACRO_PREDOMINANT_MEMBER[verdict.resolved ?? bare];
	}
	return undefined;
}

function mechanicalIdentity(
	code: string,
): AppLanguageIdentity | { readonly reason: string } {
	const variety = OLD_VARIETY_ALIASES[code];
	if (variety !== undefined) return { language: variety };
	const [bare = "", ...rest] = code.split("-");
	if (rest.length > 1) {
		return { reason: "the code has more than one suffix segment" };
	}
	const language = resolveBareLanguage(bare);
	if (language === undefined) {
		return {
			reason: `${bare} does not resolve to one individual living ISO 639:2023 Set 3 language`,
		};
	}
	const suffix = rest[0];
	if (suffix === undefined) return { language };
	if (/^[a-z]{2}$/.test(suffix)) {
		return { language, region: suffix.toUpperCase() };
	}
	if (/^[a-z]{4}$/.test(suffix)) {
		return {
			language,
			script: `${suffix[0]?.toUpperCase() ?? ""}${suffix.slice(1)}`,
		};
	}
	return {
		reason: `the suffix ${suffix} is neither a two-letter region nor a four-letter script`,
	};
}

/**
 * Decide the structured identity for one stored old-shape code. A code that
 * already spells a lawful canonical tag is kept; the reviewed explicit table
 * wins next; then the mechanical rules; anything still undecided, including
 * every candidate whose identity needs a script the code does not carry,
 * reports `needs-explicit`.
 */
export function mapOldLanguageCode(code: string): OldLanguageCodeMapping {
	if (languageTagSchema.safeParse(code).success) {
		const identity = parseLanguageTag(code);
		if (identityIssues(identity).length === 0) {
			return { kind: "canonical", tag: code };
		}
	}
	const explicit = LANGUAGE_IDENTITY_EXPLICIT_MAPPINGS[code];
	if (explicit !== undefined) {
		const issues = identityIssues(explicit);
		if (issues.length > 0) {
			throw new Error(
				`LANGUAGE_IDENTITY_EXPLICIT_MAPPINGS[${JSON.stringify(code)}] names an unlawful identity: ${issues.join(" ")}`,
			);
		}
		return { kind: "explicit", identity: explicit, tag: languageTag(explicit) };
	}
	const candidate = mechanicalIdentity(code);
	if ("reason" in candidate) {
		return { kind: "needs-explicit", reason: candidate.reason };
	}
	const issues = identityIssues(candidate);
	if (issues.length > 0) {
		return { kind: "needs-explicit", reason: issues.join(" ") };
	}
	return {
		kind: "mechanical",
		identity: candidate,
		tag: languageTag(candidate),
	};
}

// ── Source, plan, findings ─────────────────────────────────────────

export interface LanguageIdentitySourceChangeRow {
	readonly seq: number;
	readonly kind: string;
	readonly batchId: string;
	readonly runId: string | null;
	readonly actorId: string;
	readonly mutationsText: string;
	readonly fromProjectId: string | null;
	readonly toProjectId: string | null;
}

export interface LanguageIdentitySourceBaselineRow {
	readonly seq: number;
	readonly projectId: string;
	readonly snapshotText: string;
}

export interface LanguageIdentitySourceAttemptRow {
	readonly id: string;
	readonly intentText: string;
	readonly intentDigest: string;
}

export interface LanguageIdentitySourceBatchRow {
	readonly id: string;
	readonly attemptId: string;
	readonly sourceLanguage: string;
	readonly targetLanguage: string;
}

export interface LanguageIdentityRepairSource {
	readonly appId: string;
	readonly appName: string;
	readonly projectId: string;
	readonly mutationSeq: number;
	readonly localizationText: string | null;
	readonly changeRows: readonly LanguageIdentitySourceChangeRow[];
	readonly baselines: readonly LanguageIdentitySourceBaselineRow[];
	readonly attempts: readonly LanguageIdentitySourceAttemptRow[];
	readonly batches: readonly LanguageIdentitySourceBatchRow[];
}

export type LanguageIdentityFindingClassification =
	| "canonical"
	| "mechanical"
	| "explicit"
	| "needs-explicit-mapping"
	| "blocked"
	| "informational";

export interface LanguageIdentityFinding {
	readonly store: "root" | "change-row" | "baseline" | "attempt" | "batch";
	/** Where in the store: "root", "seq 12", "attempt <id>", "batch <id>". */
	readonly ref: string;
	readonly classification: LanguageIdentityFindingClassification;
	readonly detail: string;
}

export interface LanguageIdentityRepairPlan {
	readonly appId: string;
	readonly findings: readonly LanguageIdentityFinding[];
	/** Distinct stored codes with no decidable identity; migrate refuses. */
	readonly neededMappings: readonly string[];
	readonly blocked: readonly LanguageIdentityFinding[];
	readonly rootAction: "null" | "canonical" | "rewrite";
	readonly rootRewriteText: string | null;
	readonly rowRewrites: readonly {
		readonly seq: number;
		readonly mutationsText: string;
		readonly replacedEmptiedBatch: boolean;
	}[];
	readonly baselineRewrites: readonly {
		readonly seq: number;
		readonly snapshotText: string;
	}[];
	readonly attemptRewrites: readonly {
		readonly id: string;
		readonly intentText: string;
		readonly intentDigest: string;
	}[];
	readonly batchRewrites: readonly {
		readonly id: string;
		readonly sourceLanguage: string;
		readonly targetLanguage: string;
	}[];
}

export function languageIdentityPlanHasRewrites(
	plan: LanguageIdentityRepairPlan,
): boolean {
	return (
		plan.rootRewriteText !== null ||
		plan.rowRewrites.length > 0 ||
		plan.baselineRewrites.length > 0 ||
		plan.attemptRewrites.length > 0 ||
		plan.batchRewrites.length > 0
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The English-only mini-fold state used to resolve a batch emptied by
// dropping its `updateLanguage` mutations. It mirrors exactly the catalog
// half of the current reducer arms: every arm materializes first, so the
// replacement `setDefaultLanguage` to the current default reproduces the old
// `updateLanguage`'s one surviving effect (materialization) as a fold no-op.
interface MiniLocalizationState {
	source: LanguageTag;
	default: LanguageTag;
	order: LanguageTag[];
}
type MiniFoldState = MiniLocalizationState | null;

function miniMaterialize(state: MiniFoldState): MiniLocalizationState {
	return state ?? { source: "eng", default: "eng", order: ["eng"] };
}

function miniApply(
	state: MiniFoldState,
	mutation:
		| { kind: "relabelSourceLanguage" | "addLanguage"; tag: LanguageTag }
		| { kind: "removeLanguage" | "setDefaultLanguage"; tag: LanguageTag }
		| { kind: "materialize-only" },
): MiniFoldState {
	switch (mutation.kind) {
		case "relabelSourceLanguage": {
			const effective = miniMaterialize(state);
			if (effective.order.length !== 1) return state;
			return {
				source: mutation.tag,
				default: mutation.tag,
				order: [mutation.tag],
			};
		}
		case "addLanguage": {
			const next = miniMaterialize(state);
			if (!next.order.includes(mutation.tag)) next.order.push(mutation.tag);
			return next;
		}
		case "removeLanguage": {
			const next = miniMaterialize(state);
			if (
				mutation.tag !== next.source &&
				mutation.tag !== next.default &&
				next.order.includes(mutation.tag)
			) {
				next.order = next.order.filter((tag) => tag !== mutation.tag);
			}
			return next;
		}
		case "setDefaultLanguage": {
			const next = miniMaterialize(state);
			if (next.order.includes(mutation.tag)) {
				next.default = mutation.tag;
				next.order = [
					mutation.tag,
					...next.order.filter((tag) => tag !== mutation.tag),
				];
			}
			return next;
		}
		case "materialize-only":
			return miniMaterialize(state);
	}
}

/**
 * Produce the complete rewrite for one app from its loaded source rows. Pure:
 * the same source always plans the same rewrite, so the scan, the dry run,
 * and the executing transaction all report one truth.
 */
export function planLanguageIdentityRepair(
	source: LanguageIdentityRepairSource,
): LanguageIdentityRepairPlan {
	const findings: LanguageIdentityFinding[] = [];
	const blocked: LanguageIdentityFinding[] = [];
	const neededMappings = new Set<string>();

	const block = (
		store: LanguageIdentityFinding["store"],
		ref: string,
		detail: string,
	): void => {
		const finding: LanguageIdentityFinding = {
			store,
			ref,
			classification: "blocked",
			detail,
		};
		findings.push(finding);
		blocked.push(finding);
	};

	// One root or row names the same code in several slots (order, source,
	// default, translation keys); report each mapping once per location.
	const reportedMappings = new Set<string>();
	const mapCode = (
		code: string,
		store: LanguageIdentityFinding["store"],
		ref: string,
	): LanguageTag | undefined => {
		const mapping = mapOldLanguageCode(code);
		const reportKey = `${store}\u0000${ref}\u0000${code}`;
		switch (mapping.kind) {
			case "canonical":
				return mapping.tag;
			case "mechanical":
			case "explicit":
				if (!reportedMappings.has(reportKey)) {
					reportedMappings.add(reportKey);
					findings.push({
						store,
						ref,
						classification: mapping.kind,
						detail: `${code} becomes ${mapping.tag}`,
					});
				}
				return mapping.tag;
			case "needs-explicit":
				neededMappings.add(code);
				if (!reportedMappings.has(reportKey)) {
					reportedMappings.add(reportKey);
					findings.push({
						store,
						ref,
						classification: "needs-explicit-mapping",
						detail: `${code}: ${mapping.reason}`,
					});
				}
				return undefined;
		}
	};

	const mapCodeToIdentity = (
		code: string,
		store: LanguageIdentityFinding["store"],
		ref: string,
	): AppLanguageIdentity | undefined => {
		const tag = mapCode(code, store, ref);
		return tag === undefined ? undefined : parseLanguageTag(tag);
	};

	const noteDroppedMetadata = (
		store: LanguageIdentityFinding["store"],
		ref: string,
		old: OldAppLanguage,
		identity: AppLanguageIdentity,
	): void => {
		const derivedDirection = languageDirection(identity);
		const directionNote =
			old.direction === derivedDirection
				? ""
				: `; stored direction ${old.direction} now derives as ${derivedDirection}`;
		findings.push({
			store,
			ref,
			classification: "informational",
			detail: `stored name ${JSON.stringify(old.name)} for ${old.code} is dropped; the identity derives ${languageDescriptor(identity)}${directionNote}`,
		});
	};

	// ── Localization roots (apps.localization and baseline snapshots) ──

	const rewriteOldRoot = (
		old: OldAppLocalization,
		store: LanguageIdentityFinding["store"],
		ref: string,
	): Record<string, unknown> | undefined => {
		let failed = false;
		const need = (code: string): string => {
			const tag = mapCode(code, store, ref);
			if (tag === undefined) failed = true;
			return tag ?? code;
		};
		for (const code of Object.keys(old.languages)) {
			const identity = mapCodeToIdentity(code, store, ref);
			const language = old.languages[code];
			if (identity !== undefined && language !== undefined) {
				noteDroppedMetadata(store, ref, language, identity);
			} else {
				failed = true;
			}
		}
		const languageOrder = old.languageOrder.map(need);
		const translations: Record<string, unknown> = {};
		for (const [code, units] of Object.entries(old.translations)) {
			const tag = need(code);
			if (Object.hasOwn(translations, tag)) {
				block(
					store,
					ref,
					`two stored languages both map to ${tag}; the app carries the same language twice and must be repaired by hand`,
				);
				failed = true;
				continue;
			}
			const entries: Record<string, unknown> = {};
			for (const [unitId, entry] of Object.entries(units)) {
				entries[unitId] = {
					value: entry.value,
					sourceFingerprint: entry.sourceFingerprint,
					origin: entry.origin,
					review: entry.review,
					translatedFrom: need(entry.translatedFrom),
				};
			}
			translations[tag] = entries;
		}
		if (failed) return undefined;
		const root = {
			sourceLanguage: need(old.sourceLanguage),
			defaultLanguage: need(old.defaultLanguage),
			languageOrder,
			translations,
		};
		const admitted = appLocalizationSchema.safeParse(root);
		if (!admitted.success) {
			block(
				store,
				ref,
				`the rewritten localization root fails the canonical schema: ${admitted.error.issues.map((issue) => issue.message).join(" ")}`,
			);
			return undefined;
		}
		return root;
	};

	/** Classify one parsed localization root: already canonical, old-shape
	 * (returns its rewrite), or unreadable (blocked). Old roots always carry
	 * the `languages` metadata record, which the strict new schema rejects,
	 * so the two shapes cannot be confused. */
	const planRootValue = (
		value: unknown,
		store: LanguageIdentityFinding["store"],
		ref: string,
	): { action: "canonical" } | { action: "rewrite"; root: unknown } | null => {
		const canonical = appLocalizationSchema.safeParse(value);
		if (canonical.success) {
			const unlawful = canonical.data.languageOrder.filter(
				(tag) => identityIssues(parseLanguageTag(tag)).length > 0,
			);
			if (unlawful.length > 0) {
				block(
					store,
					ref,
					`the canonical-shaped root names unlawful identities: ${unlawful.join(", ")}`,
				);
				return null;
			}
			return { action: "canonical" };
		}
		const old = oldAppLocalizationSchema.safeParse(value);
		if (!old.success) {
			block(
				store,
				ref,
				"the stored localization root parses as neither the canonical shape nor the retired shape",
			);
			return null;
		}
		const root = rewriteOldRoot(old.data, store, ref);
		if (root === undefined) return null;
		return { action: "rewrite", root };
	};

	let rootAction: LanguageIdentityRepairPlan["rootAction"] = "null";
	let rootRewriteText: string | null = null;
	if (source.localizationText === null) {
		findings.push({
			store: "root",
			ref: "root",
			classification: "informational",
			detail:
				"localization is NULL, the canonical English-only spelling; untouched",
		});
	} else {
		const parsed = parsePersistedJsonText(
			source.localizationText,
			`apps.localization for ${source.appId}`,
		);
		const planned = planRootValue(parsed, "root", "root");
		if (planned?.action === "canonical") rootAction = "canonical";
		else if (planned?.action === "rewrite") {
			rootAction = "rewrite";
			rootRewriteText = JSON.stringify(planned.root);
		}
	}

	// ── Baseline snapshots ─────────────────────────────────────────
	//
	// Both admissible baseline identities predate localization, so this arm
	// expects zero hits; it exists so a baseline that somehow carries a root
	// is rewritten rather than silently left in the old shape.

	const baselineRewrites: { seq: number; snapshotText: string }[] = [];
	const rewrittenBaselineRoots = new Map<number, unknown>();
	for (const baseline of source.baselines) {
		const snapshot = parsePersistedJsonText(
			baseline.snapshotText,
			`app_change_fold_baselines snapshot at seq ${baseline.seq} for ${source.appId}`,
		);
		if (!isRecord(snapshot)) {
			block(
				"baseline",
				`seq ${baseline.seq}`,
				"the baseline snapshot is not an object",
			);
			continue;
		}
		if (!Object.hasOwn(snapshot, "localization")) continue;
		const ref = `seq ${baseline.seq}`;
		const planned = planRootValue(snapshot.localization, "baseline", ref);
		if (planned?.action === "canonical") {
			rewrittenBaselineRoots.set(baseline.seq, snapshot.localization);
			continue;
		}
		if (planned?.action !== "rewrite") continue;
		rewrittenBaselineRoots.set(baseline.seq, planned.root);
		const next = { ...snapshot, localization: planned.root };
		baselineRewrites.push({
			seq: baseline.seq,
			snapshotText: JSON.stringify(next),
		});
	}

	// ── Change rows ────────────────────────────────────────────────

	const greatestBaselineSeq = source.baselines.reduce(
		(max, baseline) => Math.max(max, baseline.seq),
		0,
	);
	if (greatestBaselineSeq === 0) {
		block(
			"change-row",
			"baselines",
			"the app has no fold baseline; every app is born with a sequence-one baseline, so this row set is corrupt",
		);
	}

	// The mini-fold starts at the greatest baseline's (possibly rewritten)
	// localization; a lawful baseline never carries one, so this is null.
	let miniState: MiniFoldState = null;
	const baselineRoot = rewrittenBaselineRoots.get(greatestBaselineSeq);
	if (baselineRoot !== undefined) {
		const admitted = appLocalizationSchema.safeParse(baselineRoot);
		if (admitted.success) {
			miniState = {
				source: admitted.data.sourceLanguage,
				default: admitted.data.defaultLanguage,
				order: [...admitted.data.languageOrder],
			};
		}
	}

	const rowRewrites: {
		seq: number;
		mutationsText: string;
		replacedEmptiedBatch: boolean;
	}[] = [];

	for (const row of source.changeRows) {
		const ref = `seq ${row.seq}`;
		if (row.seq <= greatestBaselineSeq) {
			// Archived pre-baseline rows never replay through the current
			// schema, so they are not rewritten; a localization kind name
			// appearing in one is a history this migration does not model.
			const hit = LOCALIZATION_MUTATION_KINDS.find((kind) =>
				row.mutationsText.includes(`"${kind}"`),
			);
			if (hit !== undefined) {
				block(
					"change-row",
					ref,
					`archived pre-baseline row mentions ${hit}; localization postdates the canonical fold horizon, so this row needs human review`,
				);
			}
			continue;
		}

		const parsed = parsePersistedJsonText(
			row.mutationsText,
			`app_changes.mutations at seq ${row.seq} for ${source.appId}`,
		);
		if (!Array.isArray(parsed)) {
			block("change-row", ref, "the stored mutation batch is not an array");
			continue;
		}
		let changed = false;
		let sawLocalization = false;
		const nextElements: unknown[] = [];
		for (const element of parsed) {
			if (
				!isRecord(element) ||
				typeof element.kind !== "string" ||
				!LOCALIZATION_MUTATION_KIND_SET.has(element.kind)
			) {
				nextElements.push(element);
				continue;
			}
			sawLocalization = true;
			const kind = element.kind;
			if (kind === "relabelSourceLanguage" || kind === "addLanguage") {
				const asNew = newIdentityCarrierSchema.safeParse(element);
				if (asNew.success) {
					const issues = identityIssues(asNew.data.language);
					if (issues.length > 0) {
						block(
							"change-row",
							ref,
							`${kind} carries an unlawful identity ${languageTag(asNew.data.language)}: ${issues.join(" ")}`,
						);
						continue;
					}
					nextElements.push(element);
					miniState = miniApply(miniState, {
						kind,
						tag: languageTag(asNew.data.language),
					});
					continue;
				}
				const asOld = oldIdentityCarrierSchema.safeParse(element);
				if (!asOld.success) {
					block(
						"change-row",
						ref,
						`${kind} parses as neither the canonical nor the retired payload`,
					);
					continue;
				}
				const identity = mapCodeToIdentity(
					asOld.data.language.code,
					"change-row",
					ref,
				);
				if (identity === undefined) continue;
				noteDroppedMetadata("change-row", ref, asOld.data.language, identity);
				nextElements.push({ kind, language: identity });
				changed = true;
				miniState = miniApply(miniState, { kind, tag: languageTag(identity) });
				continue;
			}
			if (kind === "updateLanguage") {
				const asOld = oldUpdateLanguageSchema.safeParse(element);
				if (!asOld.success) {
					block(
						"change-row",
						ref,
						"updateLanguage does not parse as the retired payload",
					);
					continue;
				}
				findings.push({
					store: "change-row",
					ref,
					classification: "mechanical",
					detail: `updateLanguage for ${asOld.data.code} is dropped; names and directions derive from the identity`,
				});
				changed = true;
				miniState = miniApply(miniState, { kind: "materialize-only" });
				continue;
			}
			if (kind === "removeLanguage" || kind === "setDefaultLanguage") {
				const carrier = codeReferenceCarrierSchema.safeParse(element);
				if (!carrier.success) {
					block(
						"change-row",
						ref,
						`${kind} does not parse as a language reference`,
					);
					continue;
				}
				const tag = mapCode(carrier.data.code, "change-row", ref);
				if (tag === undefined) continue;
				if (tag !== carrier.data.code) changed = true;
				nextElements.push({ kind, code: tag });
				miniState = miniApply(miniState, { kind, tag });
				continue;
			}
			if (kind === "setTranslation") {
				const carrier = setTranslationCarrierSchema.safeParse(element);
				if (!carrier.success) {
					block(
						"change-row",
						ref,
						"setTranslation does not parse as a translation write",
					);
					continue;
				}
				const language = mapCode(carrier.data.language, "change-row", ref);
				if (language === undefined) continue;
				let entry: unknown = carrier.data.entry;
				if (carrier.data.entry !== null) {
					const translatedFrom = mapCode(
						carrier.data.entry.translatedFrom,
						"change-row",
						ref,
					);
					if (translatedFrom === undefined) continue;
					if (translatedFrom !== carrier.data.entry.translatedFrom) {
						changed = true;
					}
					entry = { ...carrier.data.entry, translatedFrom };
				}
				if (language !== carrier.data.language) changed = true;
				nextElements.push({
					kind,
					language,
					unitId: carrier.data.unitId,
					entry,
				});
				miniState = miniApply(miniState, { kind: "materialize-only" });
				continue;
			}
			const carrier = reviewTranslationCarrierSchema.safeParse(element);
			if (!carrier.success) {
				block(
					"change-row",
					ref,
					"reviewTranslation does not parse as a review write",
				);
				continue;
			}
			const language = mapCode(carrier.data.language, "change-row", ref);
			if (language === undefined) continue;
			if (language !== carrier.data.language) changed = true;
			nextElements.push({ ...carrier.data, language });
			miniState = miniApply(miniState, { kind: "materialize-only" });
		}

		if (!sawLocalization || !changed) continue;

		let replacedEmptiedBatch = false;
		if (nextElements.length === 0) {
			// Every mutation in the batch was an updateLanguage. Its whole
			// surviving effect is materialization, which setDefaultLanguage to
			// the current default reproduces exactly, keeping the row's batch
			// nonempty and the fold byte-identical.
			const current = miniMaterialize(miniState);
			const replacement = { kind: "setDefaultLanguage", code: current.default };
			nextElements.push(replacement);
			miniState = miniApply(miniState, {
				kind: "setDefaultLanguage",
				tag: current.default,
			});
			replacedEmptiedBatch = true;
			findings.push({
				store: "change-row",
				ref,
				classification: "mechanical",
				detail: `the batch emptied by dropping updateLanguage is replaced with setDefaultLanguage ${current.default}, a fold no-op that preserves materialization`,
			});
		}

		const admitted = rewrittenMutationBatchSchema.safeParse(nextElements);
		if (!admitted.success) {
			block(
				"change-row",
				ref,
				`the rewritten batch fails the canonical mutation schema: ${admitted.error.issues.map((issue) => issue.message).join(" ")}`,
			);
			continue;
		}
		rowRewrites.push({
			seq: row.seq,
			mutationsText: JSON.stringify(nextElements),
			replacedEmptiedBatch,
		});
	}

	// ── Translation-batch state ────────────────────────────────────

	const attemptRewrites: {
		id: string;
		intentText: string;
		intentDigest: string;
	}[] = [];
	for (const attempt of source.attempts) {
		const ref = `attempt ${attempt.id}`;
		const parsed = parsePersistedJsonText(
			attempt.intentText,
			`design_localization_attempts.intent ${attempt.id}`,
		);
		const canonical = designLocalizationIntentSchema.safeParse(parsed);
		if (canonical.success) {
			const digest = canonicalJsonDigest(parsed);
			if (digest !== attempt.intentDigest) {
				block(
					"attempt",
					ref,
					"the stored canonical intent does not match its stored digest",
				);
			}
			continue;
		}
		const old = oldDesignIntentSchema.safeParse(parsed);
		if (!old.success) {
			block(
				"attempt",
				ref,
				"the stored intent parses as neither the canonical shape nor the retired shape",
			);
			continue;
		}
		let failed = false;
		const identityOf = (code: string): AppLanguageIdentity => {
			const identity = mapCodeToIdentity(code, "attempt", ref);
			if (identity === undefined) {
				failed = true;
				return { language: "und" };
			}
			return identity;
		};
		const intent: DesignLocalizationIntent = {
			sourceLanguage: identityOf(old.data.sourceLanguage.code),
			defaultLanguage: identityOf(old.data.defaultLanguage),
			targets: old.data.targets.map((target) => ({
				language: identityOf(target.language.code),
				seedFrom: identityOf(target.seedFrom),
				strategy: target.strategy,
			})),
		};
		if (failed) continue;
		const admitted = designLocalizationIntentSchema.safeParse(intent);
		if (!admitted.success) {
			block(
				"attempt",
				ref,
				`the rewritten intent fails the canonical design contract: ${admitted.error.issues.map((issue) => issue.message).join(" ")}`,
			);
			continue;
		}
		attemptRewrites.push({
			id: attempt.id,
			intentText: JSON.stringify(intent),
			intentDigest: canonicalJsonDigest(intent),
		});
	}

	const batchRewrites: {
		id: string;
		sourceLanguage: string;
		targetLanguage: string;
	}[] = [];
	for (const batch of source.batches) {
		const ref = `batch ${batch.id}`;
		const sourceTag = mapCode(batch.sourceLanguage, "batch", ref);
		const targetTag = mapCode(batch.targetLanguage, "batch", ref);
		if (sourceTag === undefined || targetTag === undefined) continue;
		if (
			sourceTag === batch.sourceLanguage &&
			targetTag === batch.targetLanguage
		) {
			continue;
		}
		batchRewrites.push({
			id: batch.id,
			sourceLanguage: sourceTag,
			targetLanguage: targetTag,
		});
	}

	return {
		appId: source.appId,
		findings,
		neededMappings: [...neededMappings].sort(),
		blocked,
		rootAction,
		rootRewriteText,
		rowRewrites,
		baselineRewrites,
		attemptRewrites,
		batchRewrites,
	};
}

// ── Loading ────────────────────────────────────────────────────────

async function loadSourceWith(
	db: Kysely<AppDatabase>,
	appId: string,
	lockAppRow: boolean,
): Promise<LanguageIdentityRepairSource | null> {
	let appQuery = db
		.selectFrom("apps")
		.select(["id", "app_name", "project_id", "mutation_seq"])
		.select(
			sql<string | null>`${sql.ref("apps.localization")}::text`.as(
				"localization_text",
			),
		)
		.where("id", "=", appId);
	if (lockAppRow) appQuery = appQuery.forUpdate();
	const app = await appQuery.executeTakeFirst();
	if (app === undefined) return null;

	const changeRows = await db
		.selectFrom("app_changes")
		.select([
			"seq",
			"kind",
			"batch_id",
			"run_id",
			"actor_id",
			"from_project_id",
			"to_project_id",
		])
		.select(
			sql<string>`${sql.ref("app_changes.mutations")}::text`.as(
				"mutations_text",
			),
		)
		.where("app_id", "=", appId)
		.orderBy("seq", "asc")
		.execute();

	const baselines = await db
		.selectFrom("app_change_fold_baselines")
		.select(["seq", "project_id"])
		.select(
			sql<string>`${sql.ref("app_change_fold_baselines.snapshot")}::text`.as(
				"snapshot_text",
			),
		)
		.where("app_id", "=", appId)
		.orderBy("seq", "asc")
		.execute();

	const attempts = await db
		.selectFrom("design_localization_attempts")
		.select(["id", "intent_digest"])
		.select(
			sql<string>`${sql.ref("design_localization_attempts.intent")}::text`.as(
				"intent_text",
			),
		)
		.where("app_id", "=", appId)
		.orderBy("id", "asc")
		.execute();

	const batches = await db
		.selectFrom("design_localization_batches")
		.innerJoin(
			"design_localization_attempts",
			"design_localization_attempts.id",
			"design_localization_batches.attempt_id",
		)
		.select([
			"design_localization_batches.id as id",
			"design_localization_batches.attempt_id as attempt_id",
			"design_localization_batches.source_language as source_language",
			"design_localization_batches.target_language as target_language",
		])
		.where("design_localization_attempts.app_id", "=", appId)
		.orderBy("design_localization_batches.id", "asc")
		.execute();

	return {
		appId: app.id,
		appName: app.app_name,
		projectId: app.project_id,
		mutationSeq: safePersistedSequence(app.mutation_seq, "apps.mutation_seq"),
		localizationText: app.localization_text,
		changeRows: changeRows.map((row) => ({
			seq: safePersistedSequence(row.seq, "app_changes.seq"),
			kind: row.kind,
			batchId: row.batch_id,
			runId: row.run_id,
			actorId: row.actor_id,
			mutationsText: row.mutations_text,
			fromProjectId: row.from_project_id,
			toProjectId: row.to_project_id,
		})),
		baselines: baselines.map((row) => ({
			seq: safePersistedSequence(row.seq, "app_change_fold_baselines.seq"),
			projectId: row.project_id,
			snapshotText: row.snapshot_text,
		})),
		attempts: attempts.map((row) => ({
			id: row.id,
			intentText: row.intent_text,
			intentDigest: row.intent_digest,
		})),
		batches: batches.map((row) => ({
			id: row.id,
			attemptId: row.attempt_id,
			sourceLanguage: row.source_language,
			targetLanguage: row.target_language,
		})),
	};
}

/** Read-only source load for the scan and the dry run. */
export async function loadLanguageIdentityRepairSource(
	appId: string,
): Promise<LanguageIdentityRepairSource | null> {
	const db = await getAppDb();
	return loadSourceWith(db, appId, false);
}

// ── Execution ──────────────────────────────────────────────────────

export interface LanguageIdentityRepairReport {
	readonly scannedApps: number;
	readonly rewrittenApps: number;
	readonly canonicalRootApps: number;
	readonly nullRootApps: number;
	readonly rewrittenRoots: number;
	readonly rewrittenChangeRows: number;
	readonly replacedEmptiedBatches: number;
	readonly rewrittenBaselines: number;
	readonly rewrittenAttempts: number;
	readonly rewrittenBatchRows: number;
	readonly refoldProvenApps: number;
	readonly verifiedApps: number;
}

function refuseUndecidedPlan(plan: LanguageIdentityRepairPlan): void {
	if (plan.blocked.length > 0) {
		throw new Error(
			`Language identity repair is blocked for app ${plan.appId}: ${plan.blocked
				.map((finding) => `${finding.store} ${finding.ref}: ${finding.detail}`)
				.join("; ")}`,
		);
	}
	if (plan.neededMappings.length > 0) {
		throw new Error(
			`Language identity repair cannot decide these stored codes for app ${plan.appId}: ${plan.neededMappings
				.map((code) => JSON.stringify(code))
				.join(
					", ",
				)}. Add each to LANGUAGE_IDENTITY_EXPLICIT_MAPPINGS in scripts/lib/languageIdentityRepair.ts with its reviewed identity, then rerun; scripts/scan-language-identity.ts lists every occurrence.`,
		);
	}
}

/**
 * Prove one rewritten app inside its repair transaction: the strict head load
 * runs schema admission plus the absolute commit gate, and the bounded fold
 * from the greatest baseline over the rewritten rows must land exactly on
 * that head document and Project.
 */
async function proveRewrittenApp(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<void> {
	const app = await loadAppInTransaction(tx, appId);
	if (app === null) {
		throw new Error(
			`Language identity repair rewrote app ${appId} but the head reload found no app row.`,
		);
	}
	const baseline = await tx
		.selectFrom("app_change_fold_baselines")
		.select(["seq", "project_id"])
		.select(
			sql<string>`${sql.ref("app_change_fold_baselines.snapshot")}::text`.as(
				"snapshot_text",
			),
		)
		.where("app_id", "=", appId)
		.where("seq", "<=", app.mutation_seq)
		.orderBy("seq", "desc")
		.limit(1)
		.executeTakeFirst();
	if (baseline === undefined) {
		throw new Error(
			`Language identity repair cannot prove app ${appId}: no fold baseline at or below seq ${app.mutation_seq}.`,
		);
	}
	const suffixRows = await tx
		.selectFrom("app_changes")
		.select([
			"seq",
			"batch_id",
			"run_id",
			"actor_id",
			"kind",
			"from_project_id",
			"to_project_id",
		])
		.select(
			sql<string>`${sql.ref("app_changes.mutations")}::text`.as(
				"mutations_text",
			),
		)
		.where("app_id", "=", appId)
		.where("seq", ">", safePersistedSequence(baseline.seq))
		.where("seq", "<=", app.mutation_seq)
		.orderBy("seq", "asc")
		.execute();
	const suffix: CanonicalAppChangeSuffixRow[] = suffixRows.map((row) => ({
		seq: row.seq,
		batch_id: row.batch_id,
		run_id: row.run_id,
		actor_id: row.actor_id,
		kind: row.kind,
		mutationsText: row.mutations_text,
		from_project_id: row.from_project_id,
		to_project_id: row.to_project_id,
	}));
	const folded = foldCanonicalAppChangeSuffixBounded({
		baselineSnapshotText: baseline.snapshot_text,
		baselineSeq: baseline.seq,
		baselineProjectId: baseline.project_id,
		targetSeq: app.mutation_seq,
		suffix,
	});
	if (folded.projectId !== app.project_id) {
		throw new Error(
			`Language identity repair fold proof failed for app ${appId}: the fold ends in Project ${folded.projectId} while the app row holds ${app.project_id}.`,
		);
	}
	if (
		canonicalJsonDigest(folded.snapshot) !== canonicalJsonDigest(app.blueprint)
	) {
		throw new Error(
			`Language identity repair fold proof failed for app ${appId}: replaying the rewritten history does not reproduce the rewritten head document.`,
		);
	}
}

interface AppRepairOutcome {
	readonly rootAction: LanguageIdentityRepairPlan["rootAction"];
	readonly rewrote: boolean;
	readonly rewrittenChangeRows: number;
	readonly replacedEmptiedBatches: number;
	readonly rewrittenBaselines: number;
	readonly rewrittenAttempts: number;
	readonly rewrittenBatchRows: number;
	readonly refoldProven: boolean;
}

async function repairOneAppInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<AppRepairOutcome | null> {
	const source = await loadSourceWith(tx, appId, true);
	if (source === null) return null;
	const plan = planLanguageIdentityRepair(source);
	refuseUndecidedPlan(plan);
	if (!languageIdentityPlanHasRewrites(plan)) {
		return {
			rootAction: plan.rootAction,
			rewrote: false,
			rewrittenChangeRows: 0,
			replacedEmptiedBatches: 0,
			rewrittenBaselines: 0,
			rewrittenAttempts: 0,
			rewrittenBatchRows: 0,
			refoldProven: false,
		};
	}

	if (plan.rootRewriteText !== null) {
		await tx
			.updateTable("apps")
			.set({ localization: plan.rootRewriteText })
			.where("id", "=", appId)
			.execute();
	}
	for (const rewrite of plan.rowRewrites) {
		await tx
			.updateTable("app_changes")
			.set({ mutations: rewrite.mutationsText })
			.where("app_id", "=", appId)
			.where("seq", "=", rewrite.seq)
			.execute();
	}
	if (plan.baselineRewrites.length > 0) {
		// The immutability trigger raises unconditionally for every session.
		// The disable window is transactional DDL: it rolls back with the
		// transaction and is invisible outside it, and the digest is
		// recomputed in SQL by the same routine the admit trigger trusts.
		await sql`ALTER TABLE app_change_fold_baselines DISABLE TRIGGER app_change_fold_baselines_immutable`.execute(
			tx,
		);
		for (const rewrite of plan.baselineRewrites) {
			await sql`
				UPDATE app_change_fold_baselines
				SET snapshot = ${rewrite.snapshotText}::jsonb,
					snapshot_digest = nova_app_change_fold_snapshot_digest(${rewrite.snapshotText}::jsonb)
				WHERE app_id = ${appId} AND seq = ${rewrite.seq}
			`.execute(tx);
		}
		await sql`ALTER TABLE app_change_fold_baselines ENABLE TRIGGER app_change_fold_baselines_immutable`.execute(
			tx,
		);
	}
	for (const rewrite of plan.attemptRewrites) {
		await sql`
			UPDATE design_localization_attempts
			SET intent = ${rewrite.intentText}::jsonb,
				intent_digest = ${rewrite.intentDigest}
			WHERE id = ${rewrite.id}
		`.execute(tx);
	}
	for (const rewrite of plan.batchRewrites) {
		await tx
			.updateTable("design_localization_batches")
			.set({
				source_language: rewrite.sourceLanguage,
				target_language: rewrite.targetLanguage,
			})
			.where("id", "=", rewrite.id)
			.execute();
	}

	const touchedCanonicalHistory =
		plan.rootRewriteText !== null ||
		plan.rowRewrites.length > 0 ||
		plan.baselineRewrites.length > 0;
	if (touchedCanonicalHistory) await proveRewrittenApp(tx, appId);

	return {
		rootAction: plan.rootAction,
		rewrote: true,
		rewrittenChangeRows: plan.rowRewrites.length,
		replacedEmptiedBatches: plan.rowRewrites.filter(
			(rewrite) => rewrite.replacedEmptiedBatch,
		).length,
		rewrittenBaselines: plan.baselineRewrites.length,
		rewrittenAttempts: plan.attemptRewrites.length,
		rewrittenBatchRows: plan.batchRewrites.length,
		refoldProven: touchedCanonicalHistory,
	};
}

async function assertFleetHasNoOldShapeLanguageState(): Promise<number> {
	const db = await getAppDb();
	const rows = await db.selectFrom("apps").select("id").orderBy("id").execute();
	for (const { id } of rows) {
		const source = await loadSourceWith(db, id, false);
		if (source === null) continue;
		const plan = planLanguageIdentityRepair(source);
		refuseUndecidedPlan(plan);
		if (languageIdentityPlanHasRewrites(plan)) {
			throw new Error(
				`Language identity post-repair verification found old-shape state left in app ${id}: ${plan.findings
					.filter((finding) => finding.classification !== "informational")
					.map(
						(finding) => `${finding.store} ${finding.ref}: ${finding.detail}`,
					)
					.join("; ")}`,
			);
		}
	}
	return rows.length;
}

/**
 * Rewrite every store of every app (or the given apps) to the structured
 * identity shape, one transaction per app, proving each rewritten app by
 * re-fold plus the absolute commit gate before its transaction commits, then
 * verify the whole fleet plans zero further rewrites. Idempotent: a second
 * run finds nothing to rewrite.
 */
export async function runLanguageIdentityRepair(
	appIds?: readonly string[],
): Promise<LanguageIdentityRepairReport> {
	const db = await getAppDb();
	const ids =
		appIds !== undefined && appIds.length > 0
			? [...appIds]
			: (await db.selectFrom("apps").select("id").orderBy("id").execute()).map(
					(row) => row.id,
				);

	let scannedApps = 0;
	let rewrittenApps = 0;
	let canonicalRootApps = 0;
	let nullRootApps = 0;
	let rewrittenRoots = 0;
	let rewrittenChangeRows = 0;
	let replacedEmptiedBatches = 0;
	let rewrittenBaselines = 0;
	let rewrittenAttempts = 0;
	let rewrittenBatchRows = 0;
	let refoldProvenApps = 0;

	for (const appId of ids) {
		const outcome = await withAppTx((tx) =>
			repairOneAppInTransaction(tx, appId),
		);
		if (outcome === null) continue;
		scannedApps += 1;
		if (outcome.rootAction === "null") nullRootApps += 1;
		if (outcome.rootAction === "canonical") canonicalRootApps += 1;
		if (outcome.rootAction === "rewrite") rewrittenRoots += 1;
		if (outcome.rewrote) rewrittenApps += 1;
		rewrittenChangeRows += outcome.rewrittenChangeRows;
		replacedEmptiedBatches += outcome.replacedEmptiedBatches;
		rewrittenBaselines += outcome.rewrittenBaselines;
		rewrittenAttempts += outcome.rewrittenAttempts;
		rewrittenBatchRows += outcome.rewrittenBatchRows;
		if (outcome.refoldProven) refoldProvenApps += 1;
	}

	const verifiedApps = await assertFleetHasNoOldShapeLanguageState();

	return {
		scannedApps,
		rewrittenApps,
		canonicalRootApps,
		nullRootApps,
		rewrittenRoots,
		rewrittenChangeRows,
		replacedEmptiedBatches,
		rewrittenBaselines,
		rewrittenAttempts,
		rewrittenBatchRows,
		refoldProvenApps,
		verifiedApps,
	};
}
