/**
 * Nova's own documents, emitted by the production emitter and read back by
 * the whole reader: the corpora of the read-back property and of the gate's
 * coverage. A reading here runs every stage over HQ's export of the
 * document, with the identities the document already holds, so a slot of
 * the reading is the slot of the same UUID in the document.
 */
import { isDeepStrictEqual } from "node:util";
import * as fc from "fast-check";
import { advancedDocArbitrary } from "@/lib/commcare/__tests__/advancedDocArbitrary";
import { expressionDocArbitrary } from "@/lib/commcare/__tests__/expressionDocArbitrary";
import { namesDocArbitrary } from "@/lib/commcare/__tests__/namesDocArbitrary";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { moduleCaseTypeForActions } from "@/lib/domain/basicCaseSlots";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import {
	expressionSlotKey,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import type { LookupWireNaming } from "../../../lookup/naming";
import { inventoryIndex } from "../../../surface/inventory";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { type ClosedAccounting, createReadContext } from "../../context";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, STAGES } from "../../index";
import type {
	PendingExpression,
	PendingOutcome,
} from "../../pendingExpressions";
import type { ReaderInput, ReaderLookupCatalog, ReadFacts } from "../../types";
import { expressionEnvOf } from "../../xform";
import { canonicalExpression } from "../canonical";
import type {
	ExpressionClaim,
	ExpressionReadEnv,
	RecordDialectJudge,
} from "../index";
import { judgeSlot, preparedSource, slotPrint } from "../readExpression";

/** One corpus: a document arbitrary of the emitter's own tests, sampled at a fixed seed. */
export interface ReadBackCorpus {
	readonly name: string;
	readonly arbitrary: fc.Arbitrary<BlueprintDoc>;
	readonly seed: number;
}

export const READ_BACK_CORPORA: readonly ReadBackCorpus[] = [
	{ name: "expressions", arbitrary: expressionDocArbitrary, seed: 20261113 },
	{ name: "field trees", arbitrary: blueprintDocArbitrary, seed: 20261114 },
	{ name: "menus and searches", arbitrary: suiteDocArbitrary, seed: 20261115 },
	{ name: "advanced menus", arbitrary: advancedDocArbitrary, seed: 20261116 },
	{ name: "names", arbitrary: namesDocArbitrary, seed: 20261117 },
];

/** `count` documents of one corpus, the same on every run. */
export function corpusDocs(
	corpus: ReadBackCorpus,
	count: number,
): BlueprintDoc[] {
	return fc.sample(corpus.arbitrary, { numRuns: count, seed: corpus.seed });
}

/** One registration of a reading, with what the expression stage answered for it. */
export interface ReadSlot {
	readonly index: number;
	readonly registration: PendingExpression;
	readonly outcome: PendingOutcome;
}

/** A whole reading of a document's export, stopped at nothing. */
export interface EmissionReading {
	/** The bound document the expression stage gave; undefined where no stage reached it. */
	readonly doc: BlueprintDoc | undefined;
	readonly slots: readonly ReadSlot[];
	readonly closed: ClosedAccounting;
	/** What the expression stage read with. */
	readonly env: ExpressionReadEnv;
	/** The rewrites the reading reported, each at its slot's key. */
	readonly rewrites: ReadFacts["rewrites"];
}

/** The tables an app reads: their names for the export, and the source
 *  project space's catalog for the reading. */
export interface ReadTables {
	readonly naming: LookupWireNaming;
	readonly catalog: ReaderLookupCatalog;
}

/** Every stage of a reading over HQ's export of `doc`, under `doc`'s own identities. */
export function readEmission(
	doc: BlueprintDoc,
	recordDialect: RecordDialectJudge,
	tables?: ReadTables,
): Promise<EmissionReading> {
	return readBody(
		exportedBody(
			doc,
			tables === undefined ? {} : { expand: { lookupNaming: tables.naming } },
		),
		doc,
		recordDialect,
		tables,
	);
}

/** Every stage of a reading over `body`, an export of `doc` a test may have
 *  changed, under `doc`'s identities; `told` is what else the reader is told
 *  of the source project space. */
export async function readBody(
	body: Readonly<Record<string, unknown>>,
	doc: BlueprintDoc,
	recordDialect: RecordDialectJudge,
	tables?: ReadTables,
	told: Pick<ReaderInput, "saveOnlyEditedApplied"> = {},
): Promise<EmissionReading> {
	const input = await inputFor(body, {
		resolver: matchingResolver(
			"app-1",
			externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
		),
		knownCaseTypes: knownCaseTypesOf(doc),
		recordDialect,
		...(tables === undefined ? {} : { lookup: tables.catalog }),
		...told,
	});
	const ctx = createReadContext(input, { claims: "full" }, inventoryIndex());
	for (const stage of STAGES) stage(ctx);
	const closed = ctx.close();
	const slots = ctx.pending.list().map((registration, index) => ({
		index,
		registration,
		outcome: ctx.pending.outcome(index),
	}));
	return {
		doc: ctx.doc,
		slots,
		closed,
		env: expressionEnvOf(ctx),
		rewrites: [...ctx.facts.rewrites],
	};
}

/** One stored expression of a document, under the key its slot reads by. */
export interface StoredSlot {
	readonly ref: SlotContextRef;
	readonly key: string;
	readonly expression: Expression;
}

/** Every expression `doc` stores, on every menu, form and field. */
export function storedSlots(doc: BlueprintDoc): StoredSlot[] {
	const owners = [
		...doc.moduleOrder.map((uuid) => ({ entity: "module" as const, uuid })),
		...Object.keys(doc.forms).map((uuid) => ({
			entity: "form" as const,
			uuid: uuid as Uuid,
		})),
		...Object.keys(doc.fields).map((uuid) => ({
			entity: "field" as const,
			uuid: uuid as Uuid,
		})),
	];
	return owners.flatMap((owner) =>
		expressionSlotValues(doc, owner).map(({ ref, expression }) => ({
			ref,
			key: expressionSlotKey(ref),
			expression,
		})),
	);
}

/**
 * Whether the read document can hold `tree` in the registration's slot as the
 * source writes it: the checker admits it there, and it prints the source's
 * own syntax. Where it cannot, what the stored tree needed is a fact of the
 * document the export does not carry, and no reading of the text gives it.
 */
function holdsAsWritten(
	read: BlueprintDoc,
	registration: PendingExpression,
	tree: Expression,
	env: ExpressionReadEnv,
): boolean {
	const context = slotContext(read, registration.ref, new Map());
	if (context === undefined || checkExpression(tree, context).errors.length > 0)
		return false;
	const prepared = preparedSource(read, registration);
	if (!prepared.ok) return true;
	const judged = judgeSlot(read, registration, env, {
		candidate: tree,
		source: prepared.syntax,
		foldSites: [],
		spans: new Map(),
	});
	return judged.kind === "bound" && judged.equal;
}

/** How one stored slot of a document read back. */
export type SlotVerdict =
	/** The read holds the canonical tree of what the document stored. */
	| { readonly kind: "same" }
	/** The read document cannot hold the canonical tree as the source writes
	 *  it: the checker refuses it there, or it prints other syntax, because
	 *  what it needs is a fact of the document no export carries (a property
	 *  type no writer gives). */
	| {
			readonly kind: "document-fact";
			readonly claim: ExpressionClaim | undefined;
	  }
	/** The export carries no text for the slot: a case list or search slot of
	 *  a menu that loads no case, whose HQ menu holds HQ's empty case list and
	 *  default search settings. */
	| { readonly kind: "dormant" }
	| {
			readonly kind: "differs";
			readonly want: Expression;
			readonly got: Expression | undefined;
			readonly text: string | undefined;
			readonly claim: ExpressionClaim | undefined;
	  };

export interface JudgedSlot {
	readonly stored: StoredSlot;
	readonly verdict: SlotVerdict;
}

/**
 * Every expression `doc` stores, judged against the reading of its export:
 * the read document's tree in the same slot against `canonicalExpression` of
 * the stored tree, both in the read document's own context (the case
 * catalog a reading derives is the context every read slot is judged in).
 */
export function judgeReadBack(
	doc: BlueprintDoc,
	reading: EmissionReading,
): JudgedSlot[] {
	const read = reading.doc;
	const readSlots = new Map<string, Expression>();
	if (read !== undefined)
		for (const slot of storedSlots(read))
			readSlots.set(slot.key, slot.expression);
	const registrations = new Map<string, ReadSlot>();
	for (const slot of reading.slots) {
		const key = expressionSlotKey(slot.registration.ref);
		if (!registrations.has(key)) registrations.set(key, slot);
	}
	return storedSlots(doc).map((stored) => {
		const registration = registrations.get(stored.key);
		const claim = registration?.outcome.claim;
		const context =
			read === undefined ? undefined : slotContext(read, stored.ref, new Map());
		const want =
			context === undefined || read === undefined
				? stored.expression
				: canonicalExpression(
						stored.expression,
						context,
						slotPrint(read, stored.ref, reading.env),
					);
		if (
			registration === undefined &&
			stored.ref.entity === "module" &&
			stored.ref.slot !== "module_display_condition" &&
			moduleCaseTypeForActions(doc, stored.ref.uuid) === ""
		)
			return { stored, verdict: { kind: "dormant" } };
		const got = readSlots.get(stored.key);
		// The canonical tree is taken in the read document's context, so a read
		// by name of a slug the reading holds as a worker property is that
		// property's read on both sides (`worker-field-by-name`), compared as is.
		if (isDeepStrictEqual(got, want))
			return { stored, verdict: { kind: "same" } };
		if (
			read !== undefined &&
			registration !== undefined &&
			context !== undefined &&
			!holdsAsWritten(read, registration.registration, want, reading.env)
		)
			return { stored, verdict: { kind: "document-fact", claim } };
		return {
			stored,
			verdict: {
				kind: "differs",
				want,
				got,
				text: registration?.registration.text,
				claim,
			},
		};
	});
}
