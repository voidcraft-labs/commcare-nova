/**
 * The transform's working document and the slot walk every step shares
 * (part 09 §4).
 *
 * The slots are the head registry's data: `lib/domain/referenceSlots.ts`'s
 * expression and options-source entries, read from the raw rows at each
 * entry's key path through `rewriteExpressionSlotValues`, never a list
 * written here. Each slot keeps its stored value until a step lifts it; the
 * lifted values live beside the raw document, keyed by the slot's stable
 * address, and are written into a copy of it only when a document is built.
 *
 * Two documents are built from the working state. The structure (phase 1)
 * holds every structural change and no expression: each optional slot is
 * absent and each required one holds a placeholder, so field paths, options,
 * case types, entry datums and search inputs are final and nothing depends
 * on an expression. The target (phase 2) holds every lifted value. Both
 * parse under the head's `blueprintDocSchema` and hydrate.
 */

import { lookupTypeIndex } from "@/lib/commcare/validator/lookupTypeContext";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain/blueprint";
import {
	type ExpressionContext,
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { fieldSchema } from "@/lib/domain/fields";
import { formSchema } from "@/lib/domain/forms";
import { moduleSchema } from "@/lib/domain/modules";
import {
	type ExpressionCarrierRef,
	expressionSlotKey,
	rewriteExpressionSlotValues,
} from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import {
	type FrozenXPathPrintContext,
	frozenXPathPrintContext,
} from "../frozenPrinter";
import {
	type JsonRecord,
	type RawDocument,
	rawDocumentAssembly,
} from "../oldShape";
import type {
	BlockerPlace,
	CutoverBlockerCode,
	ExpressionsChangeClass,
	ExpressionsStepId,
} from "../types";

/**
 * A stand-in for a required slot's value while the structure is built: a
 * blank literal, which every expression schema admits structurally. It
 * never reaches a target: every required slot is filled from its stored
 * value or blocks.
 */
const PLACEHOLDER: Expression = {
	kind: "term",
	term: { kind: "literal", value: "" },
};

/** One stored expression slot and what the steps made of it. */
export interface SlotState {
	readonly ref: ExpressionSlotRef;
	readonly key: string;
	readonly owner: ExpressionCarrierRef;
	/** The stored value as read. */
	readonly stored: unknown;
	/**
	 * The head profile's rule set, from the slot's context in the structure;
	 * where that has none, `form` for a stored `{ parts }` text.
	 */
	ruleSet: "form" | "record";
	/** Absence fails the head schema: a link datum's value, a repeat's count or query, a write's value. */
	readonly required: boolean;
	/**
	 * What the slot holds in the target: absent where `undefined`. Unset
	 * (`lifted === false`) until a step lifts it.
	 */
	lifted: false | { readonly value: Expression | undefined };
	/** The blocker a step met lifting the slot, other than a parse refusal. */
	blocked?: CutoverBlockerCode;
	/** The parser's refusal, where the last parse refused the slot. */
	refused?: { readonly codes: readonly string[]; readonly place: BlockerPlace };
	/** The steps that wrote the slot's value, for step 7. */
	readonly writtenBy: Set<ExpressionsStepId>;
	/** The classes the slot's last lift fell in, by the step that lifted it. */
	readonly classes: Map<ExpressionsStepId, ReadonlySet<ExpressionsChangeClass>>;
}

type Built =
	| {
			readonly ok: true;
			readonly persisted: PersistableDoc;
			readonly doc: BlueprintDoc;
	  }
	| { readonly ok: false; readonly issues: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The owners of every slot, in document order: each module, then its forms, each form's fields in tree order. */
function slotOwners(raw: RawDocument): ExpressionCarrierRef[] {
	const owners: ExpressionCarrierRef[] = [];
	const fieldsUnder = (parent: string) => {
		for (const uuid of raw.fieldOrder[parent] ?? []) {
			owners.push({ entity: "field", uuid: uuid as Uuid });
			fieldsUnder(uuid);
		}
	};
	for (const moduleUuid of raw.moduleOrder) {
		owners.push({ entity: "module", uuid: moduleUuid as Uuid });
		for (const formUuid of raw.formOrder[moduleUuid] ?? []) {
			owners.push({ entity: "form", uuid: formUuid as Uuid });
			fieldsUnder(formUuid);
		}
	}
	return owners;
}

function entityOf(
	raw: RawDocument,
	owner: ExpressionCarrierRef,
): JsonRecord | undefined {
	const records =
		owner.entity === "field"
			? raw.fields
			: owner.entity === "form"
				? raw.forms
				: raw.modules;
	return Object.hasOwn(records, owner.uuid) ? records[owner.uuid] : undefined;
}

/** Visit every present slot value of one owner through the head registry. */
function visitSlots(
	raw: RawDocument,
	owner: ExpressionCarrierRef,
	visit: (value: unknown, ref: ExpressionSlotRef) => void,
): void {
	rewriteExpressionSlotValues(
		raw as unknown as Parameters<typeof rewriteExpressionSlotValues>[0],
		owner,
		(value, ref) => {
			visit(value, ref);
			return value;
		},
	);
}

/** A copy of one owner's entity with its slots replaced by key; a missing key keeps the slot. */
function rewriteOwner(
	raw: RawDocument,
	owner: ExpressionCarrierRef,
	values: (key: string, current: unknown) => unknown,
): JsonRecord | undefined {
	const entity = entityOf(raw, owner);
	if (entity === undefined) return undefined;
	const copy = structuredClone(entity) as JsonRecord;
	const single = {
		fields: owner.entity === "field" ? { [owner.uuid]: copy } : raw.fields,
		forms: owner.entity === "form" ? { [owner.uuid]: copy } : raw.forms,
		modules: owner.entity === "module" ? { [owner.uuid]: copy } : raw.modules,
	};
	rewriteExpressionSlotValues(
		single as unknown as Parameters<typeof rewriteExpressionSlotValues>[0],
		owner,
		(value, ref) => values(expressionSlotKey(ref), value),
	);
	return JSON.parse(JSON.stringify(copy)) as JsonRecord;
}

function entitySchemaAdmits(
	owner: ExpressionCarrierRef,
	entity: JsonRecord,
): boolean {
	const schema =
		owner.entity === "field"
			? fieldSchema
			: owner.entity === "form"
				? formSchema
				: moduleSchema;
	return schema.safeParse(entity).success;
}

/**
 * The transform's private state for one app. `raw` is its own copy, which
 * the structural steps edit; a slot's lifted value replaces its stored one
 * only in the documents built from it.
 */
export class WorkingDocument {
	readonly appId: string;
	readonly raw: RawDocument;
	readonly lookupContext: LookupValidationContext;
	/** The `(caseType, property)` pairs step 5 declared, as JSON pair keys. */
	readonly declared = new Set<string>();
	#slots: SlotState[] | undefined;
	#structure: Built | undefined;
	#target: Built | undefined;
	#lookupTypes: LookupTypeIndex | undefined;
	#frozen: FrozenXPathPrintContext | undefined;

	constructor(
		appId: string,
		raw: RawDocument,
		lookupContext: LookupValidationContext,
	) {
		this.appId = appId;
		this.raw = raw;
		this.lookupContext = lookupContext;
	}

	/** The raw document with every slot replaced by `value(slot)`. */
	#assemble(
		value: (slot: SlotState | undefined, stored: unknown) => unknown,
	): Built {
		const bySlot = new Map((this.#slots ?? []).map((slot) => [slot.key, slot]));
		const copy = structuredClone(this.raw) as {
			-readonly [K in keyof RawDocument]: RawDocument[K];
		};
		const fields = { ...copy.fields };
		const forms = { ...copy.forms };
		const modules = { ...copy.modules };
		for (const owner of slotOwners(this.raw)) {
			const rewritten = rewriteOwner(this.raw, owner, (key, stored) =>
				value(bySlot.get(key), stored),
			);
			if (rewritten === undefined) continue;
			if (owner.entity === "field") fields[owner.uuid] = rewritten;
			else if (owner.entity === "form") forms[owner.uuid] = rewritten;
			else modules[owner.uuid] = rewritten;
		}
		copy.fields = fields;
		copy.forms = forms;
		copy.modules = modules;
		const assembled = JSON.parse(
			JSON.stringify(rawDocumentAssembly(this.appId, copy)),
		) as unknown;
		const parsed = blueprintDocSchema.safeParse(assembled);
		if (!parsed.success)
			return { ok: false, issues: parsed.error.issues.length };
		return {
			ok: true,
			persisted: parsed.data,
			doc: hydratePersistedBlueprint(parsed.data),
		};
	}

	/**
	 * Every stored slot, in document and registry order. Read once the
	 * structural steps have run, so a link datum's address holds its lifted
	 * name.
	 */
	slots(): readonly SlotState[] {
		if (this.#slots !== undefined) return this.#slots;
		const found: {
			ref: ExpressionSlotRef;
			key: string;
			owner: ExpressionCarrierRef;
			stored: unknown;
		}[] = [];
		for (const owner of slotOwners(this.raw)) {
			visitSlots(this.raw, owner, (stored, ref) => {
				found.push({ ref, key: expressionSlotKey(ref), owner, stored });
			});
		}
		const required = new Set<string>();
		const owners = new Map<string, ExpressionCarrierRef>();
		for (const slot of found)
			owners.set(`${slot.owner.entity}:${slot.owner.uuid}`, slot.owner);
		for (const owner of owners.values()) {
			const placeheld = rewriteOwner(this.raw, owner, () => PLACEHOLDER);
			if (placeheld === undefined || !entitySchemaAdmits(owner, placeheld))
				continue;
			for (const slot of found) {
				if (slot.owner !== owner) continue;
				const without = rewriteOwner(this.raw, owner, (key) =>
					key === slot.key ? undefined : PLACEHOLDER,
				);
				if (without !== undefined && !entitySchemaAdmits(owner, without))
					required.add(slot.key);
			}
		}
		const slots: SlotState[] = found.map((slot) => ({
			...slot,
			ruleSet:
				isRecord(slot.stored) &&
				!Object.hasOwn(slot.stored, "kind") &&
				Array.isArray(slot.stored.parts)
					? "form"
					: "record",
			required: required.has(slot.key),
			lifted: false,
			writtenBy: new Set<ExpressionsStepId>(),
			classes: new Map(),
		}));
		this.#slots = slots;
		const structure = this.structure();
		for (const slot of slots) {
			const context = structure.ok
				? slotContext(structure.doc, slot.ref, this.lookupTypes())
				: undefined;
			if (context !== undefined) slot.ruleSet = context.profile.ruleSet;
		}
		return slots;
	}

	#buildStructure(): Built {
		return this.#assemble((slot) =>
			slot?.required === true ? PLACEHOLDER : undefined,
		);
	}

	/** Phase 1: the structural document every parse resolves against. */
	structure(): Built {
		if (this.#slots === undefined) this.slots();
		this.#structure ??= this.#buildStructure();
		return this.#structure;
	}

	/**
	 * Phase 2: the document with every lifted value. A slot no step lifted
	 * keeps its stored value, so a document with a refused slot fails the
	 * head schema.
	 */
	target(): Built {
		this.slots();
		this.#target ??= this.#assemble((slot, stored) =>
			slot === undefined || slot.lifted === false ? stored : slot.lifted.value,
		);
		return this.#target;
	}

	/**
	 * The target with each slot no step could lift left out (a stand-in
	 * where the slot is required), so the gate can judge everything else in
	 * a blocked app.
	 */
	judged(): Built {
		this.slots();
		return this.#assemble((slot, stored) =>
			slot === undefined
				? stored
				: slot.lifted !== false
					? slot.lifted.value
					: slot.required
						? PLACEHOLDER
						: undefined,
		);
	}

	/** The Project's lookup column types, as the checker reads them. */
	lookupTypes(): LookupTypeIndex {
		this.#lookupTypes ??= lookupTypeIndex(this.lookupContext);
		return this.#lookupTypes;
	}

	/**
	 * The frozen printer's identity lookups over the raw rows. No step moves
	 * a field, a worker property or a search input, so one serves the run.
	 */
	frozenContext(): FrozenXPathPrintContext {
		this.#frozen ??= frozenXPathPrintContext(this.raw);
		return this.#frozen;
	}

	/** A slot's context in the structure, for parsing and typing its value. */
	structureContext(slot: SlotState): ExpressionContext | undefined {
		const structure = this.structure();
		return structure.ok
			? slotContext(structure.doc, slot.ref, this.lookupTypes())
			: undefined;
	}

	/**
	 * Record a step's value for a slot and the classes it fell in; the built
	 * documents follow it. A slot that holds its stored value unchanged is
	 * lifted with `written: false`, so step 7 leaves it to the law that
	 * already holds for it.
	 */
	lift(
		slot: SlotState,
		value: Expression | undefined,
		step: ExpressionsStepId,
		classes: ReadonlySet<ExpressionsChangeClass> = new Set(),
		written = true,
	): void {
		slot.lifted = { value };
		slot.refused = undefined;
		if (written) slot.writtenBy.add(step);
		slot.classes.set(step, classes);
		this.#target = undefined;
	}

	/** The raw catalog or structure changed (step 5): rebuild both documents. */
	structureChanged(): void {
		this.#structure = undefined;
		this.#target = undefined;
	}
}
