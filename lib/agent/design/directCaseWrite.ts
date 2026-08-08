/**
 * The direct-write lowering rule (the plan's §13.11).
 *
 * A fact whose value IS the answer to a question lowers to that visible
 * field's own `caseWrite` — no hidden calculated writer in between. A
 * calculated writer exists to add semantics (transformation, composition, a
 * conditional constant, a session/lookup/generated value, a second
 * destination, a blank/update behavior the visible field cannot express);
 * minting one that merely copies an answer to a case property is accidental
 * identity duplication, and it shows up later as a form full of shadow fields
 * nobody can trace back to a requirement.
 *
 * This function is the deterministic half of that rule — the conditions
 * PROVABLE from the design layer plus the caller's form-lowering context. It
 * is pure and total: it answers "may this input write the case property
 * directly?", never "how do I build the field". The executor prompt states the
 * same rule in prose; conformance replays this function against what was
 * built to tell an intentional calculated writer from an accidental one.
 */

import type {
	FactDataShape,
	FactDefinition,
	Task,
	TaskInput,
} from "@/lib/agent/design/contract";
import { slugifyId } from "@/lib/domain/idSlug";

/**
 * What the surrounding form already decided, which the design layer cannot
 * know on its own.
 *
 * `directSlotTaken` is the platform's one-direct-write-per-field rule
 * (`SINGLE_DIRECT_CASE_WRITE_PER_FIELD`): a visible field carries at most one
 * case-write destination, so if another target already claimed this field's
 * slot, this fact needs a writer of its own.
 *
 * `repeatScopeCompatible` is the repeat/context match: a per-iteration answer
 * cannot write the form's primary case, and a form-root answer cannot write a
 * per-iteration child case.
 */
export interface FormLoweringContext {
	readonly caseType: string;
	/** Whether the visible field's caseWrite slot is already claimed by
	 *  another target. */
	readonly directSlotTaken: boolean;
	readonly repeatScopeCompatible: boolean;
}

export type DirectCaseWritePlan = { kind: "direct"; property: string } | null;

/**
 * Shapes that have no scalar case-property spelling.
 *
 * `attachment` needs save-to-case attachment emission, which is a declared
 * platform gap (`GAP_CASE_ATTACHMENT_EMISSION`); `unknown` means the design
 * never settled the shape, and a direct write would silently pick one.
 */
const NON_STORABLE_SHAPES: ReadonlySet<FactDataShape> = new Set([
	"attachment",
	"unknown",
]);

/**
 * The case property a fact lowers to: its design name, slugified the same way
 * every other Nova id is derived (`lib/domain/idSlug`) — lowercase, every
 * non-alphanumeric run collapsed to `_`, edges trimmed. A name that slugifies
 * to nothing has no property spelling, and the plan refuses rather than
 * inventing one.
 */
function directWriteProperty(fact: FactDefinition): string | null {
	const property = slugifyId(fact.name, "");
	return property.length > 0 ? property : null;
}

/**
 * Plan a direct answer-to-case write, or `null` when a calculated writer is
 * required.
 *
 * Returns `{ kind: "direct" }` only when EVERY design-provable condition
 * holds:
 *
 *  1. the fact's source is exactly this answer — not derived, session,
 *     lookup, external, or constant, and not some other input's answer;
 *  2. the input actually persists to this fact (an ephemeral input used only
 *     in a decision writes nothing);
 *  3. the task genuinely writes this fact — its own write intents name it, or
 *     the contract's writer list does (which the graph validator proves is
 *     exactly the tasks writing it directly or through a transition they
 *     trigger, so a transition-borne write counts);
 *  4. the shape is a storable scalar;
 *  5. the fact name has a case-property spelling;
 *  6. repeat/context scope is compatible;
 *  7. the field's single direct-write slot is free.
 */
export function directCaseWritePlan(args: {
	readonly input: TaskInput;
	readonly fact: FactDefinition;
	readonly task: Task;
	readonly formContext: FormLoweringContext;
}): DirectCaseWritePlan {
	const { input, fact, task, formContext } = args;

	const source = fact.source;
	if (source.kind !== "answer" || source.taskInputId !== input.id) return null;
	if (input.factId !== fact.id) return null;

	const written =
		task.writes.some((write) => write.targetFactId === fact.id) ||
		fact.writerTaskIds.includes(task.id);
	if (!written) return null;

	if (NON_STORABLE_SHAPES.has(fact.dataShape)) return null;
	if (!formContext.repeatScopeCompatible) return null;
	if (formContext.directSlotTaken) return null;

	const property = directWriteProperty(fact);
	if (property === null) return null;

	return { kind: "direct", property };
}
