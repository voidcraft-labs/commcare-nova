/**
 * Planner and history-preserving writer for choice values the stored-value
 * grammar refuses (`SELECT_OPTION_VALUE_INVALID` /
 * `CASE_PROPERTY_OPTION_VALUE_INVALID`).
 *
 * The gate is allowance-free and judges the whole document, and every editor
 * commits one field per batch, so an app holding a refused value on two
 * fields (or on a catalog property, which no editor can write) cannot be
 * repaired from any editor: fixing one field is refused for the other. This
 * is the one repair path. It rewrites every refused value to the slug the
 * validator suggests (`repairSelectOptionValue`: the value's own words,
 * else the label's, else the minted placeholder; never a sibling's value),
 * keeps the catalog and every field writing the same case property in
 * agreement, and follows the rename into everything that spells the old
 * token: the case rows holding it, the close conditions naming it, the
 * id-mapping columns rendering a label for it, the expression literals
 * comparing against it, and the translation unit ids KEYED BY IT (a catalog
 * option's and an id-mapping label's), whose entries move to the new id so
 * the commit kernel's orphan prune cannot delete the translated wording. An
 * old value renamed two different ways in one app is reported rather than
 * followed, because which one an expression meant is a person's call. The
 * document lands through `appendSyntheticBatch`, which derives the mutations
 * and requires the target to be gate-clean.
 */

import { sql } from "kysely";
import { getCaseStoreDatabase } from "../../lib/case-store/postgres/connection";
import { parser } from "../../lib/commcare/xpath";
import { appendSyntheticBatch } from "../../lib/db/apps";
import { BlueprintCommitRejectedError } from "../../lib/db/commitGuard";
import { getAppDb } from "../../lib/db/pg";
import {
	fieldCaseWrite,
	isXPathExpression,
	mintSelectOptionPlaceholder,
	type PersistableDoc,
	type ProseTemplate,
	proseTemplateText,
	repairSelectOptionValue,
	type SelectOptionValueProblem,
	selectOptionValueProblem,
} from "../../lib/domain";
import { isScalarFieldExpressionSlotId } from "../../lib/domain/expressionSource";
import { makeTranslationUnitId } from "../../lib/domain/localization";
import {
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
} from "../../lib/domain/translationUnits";
import { safePersistedSequence } from "../../lib/utils/persistedSequence";
import { loadPersistedBlueprintReadOnly } from "./loadPersistedBlueprint";

const REPAIR_ACTOR = "system:select-option-value-grammar" as const;
const REPAIR_BATCH_PREFIX = "select-option-value-grammar-v1";

/** One refused value and the slug that replaces it. */
export interface SelectOptionValueRewrite {
	readonly where:
		| {
				readonly kind: "field-option";
				readonly fieldUuid: string;
				readonly fieldId: string;
				readonly formName: string;
				readonly caseType?: string;
				readonly property?: string;
		  }
		| {
				readonly kind: "catalog-option";
				readonly caseType: string;
				readonly property: string;
		  };
	readonly problem: SelectOptionValueProblem;
	readonly from: string;
	readonly to: string;
}

/** A stored expression that still spells an old value as a string literal. */
export interface SelectOptionValueLiteralReference {
	readonly carrier: string;
	readonly slot: string;
	readonly value: string;
}

/** A string literal in a stored expression rewritten to the new slug. */
export interface SelectOptionValueLiteralRewrite
	extends SelectOptionValueLiteralReference {
	readonly to: string;
}

/** A case property whose rows may hold an old token. */
export interface CasePropertyRewrite {
	readonly caseType: string;
	readonly property: string;
	readonly values: ReadonlyMap<string, string>;
}

export interface SelectOptionValueRepairPlan {
	readonly targetDoc: PersistableDoc;
	readonly rewrites: readonly SelectOptionValueRewrite[];
	readonly closeConditionRewrites: number;
	readonly casePropertyRewrites: readonly CasePropertyRewrite[];
	/** Expression literals rewritten because the old value has exactly one
	 *  new spelling in this app. */
	readonly literalRewrites: readonly SelectOptionValueLiteralRewrite[];
	/** Expression literals left alone because the old value was renamed
	 *  differently in two places, so which one was meant is a person's call. */
	readonly literalReferences: readonly SelectOptionValueLiteralReference[];
}

type MutableDoc = {
	-readonly [K in keyof PersistableDoc]: PersistableDoc[K];
};

/**
 * Move each overlay entry from its old translation unit id to its new one, in
 * every language. The whole post-move map is built away from the live record
 * before anything is written back: one unit's destination is another unit's
 * source key whenever two values swap, and deleting in place would drop the
 * entry that had not been moved yet. The wording itself is untouched, and so
 * is `sourceFingerprint` — these ids are keyed by the stored value, but the
 * source they fingerprint is the label, which the repair never changes.
 */
function moveTranslationUnits(
	target: MutableDoc,
	moves: ReadonlyMap<string, string>,
): void {
	if (moves.size === 0) return;
	for (const translations of Object.values(
		target.localization?.translations ?? {},
	)) {
		const moved: Record<string, unknown> = {};
		for (const [unitId, entry] of Object.entries(translations)) {
			moved[moves.get(unitId) ?? unitId] = entry;
		}
		for (const unitId of Object.keys(translations)) {
			delete (translations as Record<string, unknown>)[unitId];
		}
		Object.assign(translations, moved);
	}
}

/**
 * Plan the repair for one document. Pure: the returned `targetDoc` is a deep
 * copy with every refused value replaced; `doc` is untouched.
 */
export function planSelectOptionValueRepair(
	doc: PersistableDoc,
): SelectOptionValueRepairPlan {
	const target = structuredClone(doc) as MutableDoc;
	const rewrites: SelectOptionValueRewrite[] = [];

	/* Every option list that names the same case property is one value
	 * space: the catalog's options and every field writing that property.
	 * Their refused values are renamed together, against the union of their
	 * admitted values, so a field and its catalog never disagree about what
	 * an old token became. A select with no case binding is its own space. */
	const spaces = new Map<string, OptionSpace>();
	const spaceFor = (key: string): OptionSpace => {
		let space = spaces.get(key);
		if (space === undefined) {
			space = { lists: [], taken: new Set() };
			spaces.set(key, space);
		}
		return space;
	};

	for (const caseType of target.caseTypes ?? []) {
		for (const property of caseType.properties) {
			if (property.options === undefined) continue;
			const space = spaceFor(`${caseType.name}\u0000${property.name}`);
			space.lists.push({
				options: property.options,
				where: {
					kind: "catalog-option",
					caseType: caseType.name,
					property: property.name,
				},
			});
		}
	}

	const formNameOfField = fieldFormNames(target);
	for (const field of Object.values(target.fields)) {
		if (field === undefined) continue;
		if (field.kind !== "single_select" && field.kind !== "multi_select") {
			continue;
		}
		if (field.optionsSource.kind !== "inline") continue;
		const write = fieldCaseWrite(field);
		const key =
			write === undefined
				? `field\u0000${field.uuid}`
				: `${write.caseType}\u0000${write.property}`;
		spaceFor(key).lists.push({
			options: field.optionsSource.options,
			where: {
				kind: "field-option",
				fieldUuid: field.uuid,
				fieldId: field.id,
				formName: formNameOfField.get(field.uuid) ?? "",
				...(write !== undefined && {
					caseType: write.caseType,
					property: write.property,
				}),
			},
		});
	}

	/* Two translation unit ids are keyed by the stored value itself rather
	 * than by a uuid — a catalog option's, and an id-mapping column's
	 * mapping label. Renaming the value re-keys those units, and the commit
	 * kernel prunes an overlay entry whose unit no longer exists, so an
	 * unfollowed rename DELETES the translated wording. Snapshot each list's
	 * values before the rename so the overlay can follow its own ids. */
	const valuesBeforeRename = new Map<object, string[]>();
	for (const space of spaces.values()) {
		for (const list of space.lists) {
			valuesBeforeRename.set(
				list.options,
				list.options.map((option) => option.value),
			);
		}
	}

	const valueMapByKey = new Map<string, Map<string, string>>();
	for (const [key, space] of spaces) {
		for (const list of space.lists) {
			for (const option of list.options) {
				if (selectOptionValueProblem(option.value) === undefined) {
					space.taken.add(option.value);
				}
			}
		}
		const renamed = new Map<string, string>();
		for (const list of space.lists) {
			list.options.forEach((option, index) => {
				const problem = selectOptionValueProblem(option.value);
				if (problem === undefined) return;
				let to = renamed.get(option.value);
				if (to === undefined) {
					to = repairSelectOptionValue(
						option.value,
						proseTemplateText(option.label),
						mintSelectOptionPlaceholder(index + 1).value,
						space.taken,
					);
					space.taken.add(to);
					renamed.set(option.value, to);
				}
				rewrites.push({
					where: list.where,
					problem,
					from: option.value,
					to,
				});
				option.value = to;
			});
		}
		if (renamed.size > 0) valueMapByKey.set(key, renamed);
	}

	/* An id-mapping or image-map column names the stored value it renders a
	 * label or an image for. Its wire arm is `selected(field, '<value>')`, so
	 * a column left spelling the old token stops matching and the cell falls
	 * through to the raw property value. (Both slots already refuse
	 * whitespace, so only a quote-bearing rename reaches here.) */
	const unitMoves = new Map<string, string>();
	for (const module of Object.values(target.modules)) {
		for (const column of module?.caseListConfig?.columns ?? []) {
			if (column.kind !== "id-mapping" && column.kind !== "image-map") {
				continue;
			}
			const caseType = module?.caseType;
			if (caseType === undefined) continue;
			const values = valueMapByKey.get(`${caseType}\u0000${column.field}`);
			if (values === undefined) continue;
			for (const entry of column.mapping) {
				const to = values.get(entry.value);
				if (to === undefined) continue;
				if (column.kind === "id-mapping") {
					unitMoves.set(
						makeTranslationUnitId(
							"column",
							column.uuid,
							"mapping",
							entry.value,
						),
						makeTranslationUnitId("column", column.uuid, "mapping", to),
					);
				}
				entry.value = to;
			}
		}
	}

	/* A catalog option's translation unit is keyed by (case type, property,
	 * value, same-value occurrence), so every renamed catalog option moves
	 * its wording to the new id. A field option's unit is keyed by the
	 * option's uuid and needs no move. */
	for (const space of spaces.values()) {
		for (const list of space.lists) {
			if (list.where.kind !== "catalog-option") continue;
			const before = valuesBeforeRename.get(list.options);
			if (before === undefined) continue;
			const beforeOptions = before.map((value) => ({ value }));
			for (const [index, option] of list.options.entries()) {
				const from = before[index];
				if (from === undefined || from === option.value) continue;
				unitMoves.set(
					casePropertyOptionTranslationUnitId(
						list.where.caseType,
						list.where.property,
						from,
						casePropertyOptionOccurrence(beforeOptions, index),
					),
					casePropertyOptionTranslationUnitId(
						list.where.caseType,
						list.where.property,
						option.value,
						casePropertyOptionOccurrence(list.options, index),
					),
				);
			}
		}
	}
	moveTranslationUnits(target, unitMoves);

	/* A close condition names a field's answer by value. */
	let closeConditionRewrites = 0;
	for (const form of Object.values(target.forms)) {
		const condition = form?.closeCondition;
		if (condition === undefined) continue;
		const field = target.fields[condition.field];
		if (field === undefined) continue;
		const write = fieldCaseWrite(field);
		const key =
			write === undefined
				? `field\u0000${field.uuid}`
				: `${write.caseType}\u0000${write.property}`;
		const to = valueMapByKey.get(key)?.get(condition.answer);
		if (to === undefined) continue;
		form.closeCondition = { ...condition, answer: to };
		closeConditionRewrites++;
	}

	const casePropertyRewrites: CasePropertyRewrite[] = [];
	for (const [key, values] of valueMapByKey) {
		const [caseType, property] = key.split("\u0000");
		if (
			caseType === "field" ||
			caseType === undefined ||
			property === undefined
		)
			continue;
		casePropertyRewrites.push({ caseType, property, values });
	}

	/* An old value with ONE new spelling across the app can be followed
	 * into the expressions that compare against it; one renamed two ways
	 * (two unbound selects whose sibling sets collided differently) cannot
	 * be, and is reported instead. */
	const spellings = new Map<string, Set<string>>();
	for (const values of valueMapByKey.values()) {
		for (const [from, to] of values) {
			let set = spellings.get(from);
			if (set === undefined) {
				set = new Set();
				spellings.set(from, set);
			}
			set.add(to);
		}
	}
	const unambiguous = new Map<string, string>();
	for (const [from, set] of spellings) {
		const [only] = set;
		if (set.size === 1 && only !== undefined) unambiguous.set(from, only);
	}
	const literals =
		spellings.size === 0
			? { rewritten: [], remaining: [] }
			: rewriteLiteralReferences(
					target,
					new Set(spellings.keys()),
					unambiguous,
				);

	return {
		targetDoc: target,
		rewrites,
		closeConditionRewrites,
		casePropertyRewrites,
		literalRewrites: literals.rewritten,
		literalReferences: literals.remaining,
	};
}

interface OptionSpace {
	readonly lists: Array<{
		readonly options: Array<{ value: string; label: ProseTemplate }>;
		readonly where: SelectOptionValueRewrite["where"];
	}>;
	readonly taken: Set<string>;
}

function fieldFormNames(doc: PersistableDoc): Map<string, string> {
	const names = new Map<string, string>();
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		if (form === undefined) continue;
		const walk = (parentUuid: string): void => {
			for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
				names.set(uuid, form.name);
				walk(uuid);
			}
		};
		walk(formUuid);
	}
	return names;
}

/**
 * Every string literal in a stored expression that spells one of the old
 * values, rewritten to the new slug where that slug is the value's only
 * new spelling and reported otherwise. The Preview evaluates these
 * conditions against the stored token today, so a relevance or validation
 * rule comparing against `'Child client'` would silently stop matching once
 * the choice saves `child_client`; following the rename keeps the form's
 * behavior. A field's XPath slots are found through the slot registry and
 * each text part is parsed with the Lezer grammar, so a literal is located
 * by its node and never by a regex (a literal cannot span a reference part,
 * so it lies whole inside one text part); Predicate / ValueExpression
 * literals are typed nodes found by a walk over the document.
 */
function rewriteLiteralReferences(
	target: MutableDoc,
	oldValues: ReadonlySet<string>,
	unambiguous: ReadonlyMap<string, string>,
): {
	rewritten: SelectOptionValueLiteralRewrite[];
	remaining: SelectOptionValueLiteralReference[];
} {
	const rewritten: SelectOptionValueLiteralRewrite[] = [];
	const remaining: SelectOptionValueLiteralReference[] = [];
	const visit = (
		carrier: string,
		slot: string,
		value: string,
		apply: (to: string) => void,
	): void => {
		const to = unambiguous.get(value);
		if (to === undefined) {
			remaining.push({ carrier, slot, value });
			return;
		}
		apply(to);
		rewritten.push({ carrier, slot, value, to });
	};

	for (const field of Object.values(target.fields)) {
		if (field === undefined) continue;
		const record = field as unknown as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!isScalarFieldExpressionSlotId(key)) continue;
			const expression = record[key];
			if (!isXPathExpression(expression)) continue;
			for (const part of expression.parts) {
				if (part.kind !== "text") continue;
				const text = part.text;
				const hits: Array<{ from: number; to: number; value: string }> = [];
				parser.parse(text).iterate({
					enter(node) {
						if (node.type.name !== "StringLiteral") return;
						const value = text.slice(node.from + 1, node.to - 1);
						if (oldValues.has(value)) {
							hits.push({ from: node.from, to: node.to, value });
						}
					},
				});
				/* Splice from the end so earlier offsets stay valid; the
				 * original quote characters are kept and the slug holds none. */
				for (const hit of hits.reverse()) {
					visit(`field ${field.id}`, key, hit.value, (to) => {
						part.text = `${part.text.slice(0, hit.from + 1)}${to}${part.text.slice(hit.to - 1)}`;
					});
				}
			}
		}
	}

	const walk = (node: unknown, path: string): void => {
		if (Array.isArray(node)) {
			for (const [index, item] of node.entries()) {
				walk(item, `${path}[${index}]`);
			}
			return;
		}
		if (typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (
			record.kind === "literal" &&
			typeof record.value === "string" &&
			oldValues.has(record.value)
		) {
			visit(path, "literal", record.value, (to) => {
				record.value = to;
			});
			return;
		}
		for (const [key, child] of Object.entries(record)) {
			if (key === "fields" || key === "refIndex") continue;
			walk(child, `${path}.${key}`);
		}
	};
	walk({ modules: target.modules, forms: target.forms }, "doc");
	return { rewritten, remaining };
}

export interface SelectOptionValueRepairSnapshot {
	readonly appId: string;
	readonly appName: string;
	readonly mutationSeq: number;
	readonly blueprint: PersistableDoc;
}

/** Every live app, oldest first. */
export async function listRepairCandidateAppIds(): Promise<string[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("apps")
		.select("id")
		.where("deleted_at", "is", null)
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	return rows.map((row) => row.id);
}

export async function loadSelectOptionValueRepairSnapshot(
	appId: string,
): Promise<SelectOptionValueRepairSnapshot | null> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const row = await tx
				.selectFrom("apps")
				.select(["id", "app_name", "mutation_seq"])
				.where("id", "=", appId)
				.executeTakeFirst();
			if (row === undefined) return null;
			const blueprint = await loadPersistedBlueprintReadOnly(tx, appId);
			if (blueprint === null) return null;
			return {
				appId,
				appName: row.app_name,
				mutationSeq: safePersistedSequence(
					row.mutation_seq,
					`apps.mutation_seq for app ${appId}`,
				),
				blueprint,
			};
		});
}

/**
 * How many case rows of `appId` hold one of the old tokens for this
 * property: a single select stores the token as a string, a multi select as
 * an array of tokens.
 */
export async function countCaseRowsHoldingOldValues(
	appId: string,
	rewrite: CasePropertyRewrite,
): Promise<number> {
	const db = await getCaseStoreDatabase();
	let total = 0;
	for (const from of rewrite.values.keys()) {
		const result = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM cases
			WHERE app_id = ${appId}
				AND case_type = ${rewrite.caseType}
				AND (
					properties ->> ${rewrite.property} = ${from}
					OR (
						jsonb_typeof(properties -> ${rewrite.property}) = 'array'
						AND properties -> ${rewrite.property} ? ${from}
					)
				)
		`.execute(db);
		total += Number(result.rows[0]?.count ?? 0);
	}
	return total;
}

/**
 * Rewrite the rows `countCaseRowsHoldingOldValues` counts: the string
 * token is replaced, and inside an array only the matching element is.
 * Returns the number of rows touched.
 */
export async function rewriteCaseRows(
	appId: string,
	rewrite: CasePropertyRewrite,
): Promise<number> {
	const db = await getCaseStoreDatabase();
	let total = 0;
	for (const [from, to] of rewrite.values) {
		const path = sql`ARRAY[${rewrite.property}]::text[]`;
		const result = await sql`
			UPDATE cases
			SET properties = CASE
				WHEN jsonb_typeof(properties -> ${rewrite.property}) = 'string'
					THEN jsonb_set(properties, ${path}, to_jsonb(${to}::text))
				WHEN jsonb_typeof(properties -> ${rewrite.property}) = 'array'
					THEN jsonb_set(
						properties,
						${path},
						(
							SELECT coalesce(
								jsonb_agg(
									CASE WHEN element = to_jsonb(${from}::text)
										THEN to_jsonb(${to}::text)
										ELSE element END
								),
								'[]'::jsonb
							)
							FROM jsonb_array_elements(properties -> ${rewrite.property}) AS element
						)
					)
				ELSE properties
			END
			WHERE app_id = ${appId}
				AND case_type = ${rewrite.caseType}
				AND (
					properties ->> ${rewrite.property} = ${from}
					OR (
						jsonb_typeof(properties -> ${rewrite.property}) = 'array'
						AND properties -> ${rewrite.property} ? ${from}
					)
				)
		`.execute(db);
		total += Number(result.numAffectedRows ?? 0);
	}
	return total;
}

/**
 * An app this repair could not converge — the gate still refuses the repaired
 * document for a finding the repair does not own, or the write itself failed.
 * The app was locked before the repair ran and stays locked after, so the
 * repair names it and moves on rather than holding the fleet hostage.
 */
export interface SelectOptionValueRepairBlock {
	readonly appId: string;
	readonly appName: string;
	readonly reason: string;
}

export interface SelectOptionValueRepairReport {
	readonly scannedApps: number;
	readonly repairedApps: number;
	readonly rewrittenValues: number;
	readonly rewrittenCaseRows: number;
	readonly rewrittenCloseConditions: number;
	readonly rewrittenLiterals: number;
	readonly literalReferences: number;
	readonly blockedApps: readonly SelectOptionValueRepairBlock[];
}

/**
 * Apply the repair to every live app that needs it: the document first,
 * through the synthetic writer (which refuses a target that is not
 * gate-clean, leaving the app untouched), then the case rows. The rows
 * follow the document rather than share its transaction because the two
 * live behind different handles; a failure between them leaves a document
 * whose next scan reports the rows still holding the old token.
 *
 * A per-app failure is collected into `blockedApps` instead of thrown. This
 * runs on every deploy, ahead of the revision it converges for, and the worst
 * this repair can do to an app it cannot fix is leave it exactly where it
 * already was: locked, and named in the Job's log. Failing the Job is
 * strictly worse — it blocks the deploy for everyone AND strands every app
 * the repair could have fixed. Only the snapshot load sits outside the guard,
 * so a database that has gone away still fails the Job loudly rather than
 * reporting a fleet of blocked apps.
 */
export async function runSelectOptionValueRepair(
	appIds: readonly string[],
): Promise<SelectOptionValueRepairReport> {
	let scannedApps = 0;
	let repairedApps = 0;
	let rewrittenValues = 0;
	let rewrittenCaseRows = 0;
	let rewrittenCloseConditions = 0;
	let rewrittenLiterals = 0;
	let literalReferences = 0;
	const blockedApps: SelectOptionValueRepairBlock[] = [];
	for (const appId of appIds) {
		const snapshot = await loadSelectOptionValueRepairSnapshot(appId);
		if (snapshot === null) continue;
		scannedApps++;
		try {
			const plan = planSelectOptionValueRepair(snapshot.blueprint);
			if (plan.rewrites.length === 0) continue;
			await appendSyntheticBatch({
				appId,
				expectedBaseSeq: snapshot.mutationSeq,
				targetDoc: plan.targetDoc,
				batchId: `${REPAIR_BATCH_PREFIX}:${appId}`,
				authority: {
					kind: "system",
					actorId: REPAIR_ACTOR,
					reason:
						"Rewrite choice values the stored-value grammar refuses (spaces, quotes, empty) to the slug the validator suggests.",
				},
			});
			for (const rewrite of plan.casePropertyRewrites) {
				rewrittenCaseRows += await rewriteCaseRows(appId, rewrite);
			}
			rewrittenValues += plan.rewrites.length;
			rewrittenCloseConditions += plan.closeConditionRewrites;
			rewrittenLiterals += plan.literalRewrites.length;
			literalReferences += plan.literalReferences.length;
		} catch (error) {
			blockedApps.push({
				appId,
				appName: snapshot.appName,
				reason:
					error instanceof BlueprintCommitRejectedError
						? error.message
						: `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
			});
			continue;
		}
		repairedApps++;
	}
	return {
		scannedApps,
		repairedApps,
		rewrittenValues,
		rewrittenCaseRows,
		rewrittenCloseConditions,
		rewrittenLiterals,
		literalReferences,
		blockedApps,
	};
}

/** One line per rewrite, for the scan and the dry run. */
export function describeRewrite(rewrite: SelectOptionValueRewrite): string {
	const where =
		rewrite.where.kind === "catalog-option"
			? `catalog ${rewrite.where.caseType}.${rewrite.where.property}`
			: `field ${rewrite.where.fieldId} in "${rewrite.where.formName}"${
					rewrite.where.caseType !== undefined
						? ` (${rewrite.where.caseType}.${rewrite.where.property})`
						: ""
				}`;
	return `${where}: ${JSON.stringify(rewrite.from)} (${rewrite.problem}) -> ${JSON.stringify(rewrite.to)}`;
}
