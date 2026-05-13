// lib/domain/predicate/errors.ts
//
// Error-message helpers for the predicate AST + compiler stack.
//
// ## Why a dedicated module
//
// Throws across the foundation fall into four repeating shapes —
// exhaustive-switch defaults, internal-invariant violations,
// type-checker bypass, and missing-predicate-thunk caller setup —
// and the value of a thrown Error is dominated by the `.message`
// text the developer reads in the failing test or stack trace. Four
// small helpers produce consistent, multi-section messages for
// those shapes so call sites do not have to redesign the voice
// each time. The remaining one-off shapes (domain semantic, schema
// bypass) inline directly with the same voice the helpers
// establish.
//
// Both layers consume the helpers — the type checker
// (`checkPredicate` / `checkExpression` / `resolveTermType` /
// `literalType` / `caseTypeToJsonSchema`) and the SQL compiler stack
// (`compileTerm` / `compilePredicate` / `compileExpression` /
// `compileRelationPath`). Voice is layer-neutral so neither's
// throws read as miscategorised at the other's call sites.
//
// ## Design principles (drawing on Elm / Rust / Roc compiler-error work)
//
//   - **Header line** is short enough to read alone in a stack trace
//     and names the function, the kind of failure, and (when
//     applicable) the offending value. Headers are third-person
//     impersonal (`"Internal bug — \`<where>\` ..."`).
//   - **Body** is multi-line and uses indentation to separate the
//     diagnostic facts (`got` / `expected`) from the narrative.
//   - **Voice** is third-person impersonal in narrative paragraphs
//     ("The type checker is the gate every compiler trusts"); the
//     `unhandledKindMessage` helper switches to first-person for the
//     enumerable-kinds list ("I know how to handle these <family>
//     kinds:") because Elm's first-person framing reads cleanly when
//     the message is offering a confirmation list to the reader.
//     Code identifiers and AST kind literals are wrapped in
//     backticks; user-supplied or runtime-observed values are
//     wrapped in single quotes.
//   - **Hint line** states the concrete next step. The hint is
//     always actionable — "add the missing case", "route the AST
//     through `checkPredicate`", "wire `ctx.compilePredicate`".
//   - **Internal-bug framing** for invariants the type system or
//     schema is supposed to enforce (Rust ICE-equivalent); the
//     message names "Internal bug" up front so the reader knows
//     this is a programmer error in the AST construction layer,
//     not a domain error. "Internal bug" rather than "compiler
//     bug" so the framing reads cleanly at type-checker call sites
//     too — neither layer monopolises the helper.
//
// ## Why these messages stay verbose
//
// These throws fire when an upstream invariant is bypassed —
// rarely in steady state, urgently when they do. A reader who hits
// one is investigating, not skimming, so the message optimizes for
// "explain the invariant + name the fix" over brevity. Multi-line
// messages render fine in Vitest's `toThrow` matcher output and in
// stack traces; the first line stands alone for grep / log readers.

const INDENT = "    ";

// ---------------------------------------------------------------
// unhandledKindMessage — exhaustive-switch ICE
// ---------------------------------------------------------------

interface UnhandledKindArgs {
	/** The function or method that reached the throw, e.g. `"compilePredicate"` or `"checkPredicate"`. */
	readonly where: string;

	/** The AST family being switched on, e.g. `"Predicate"` / `"Term"`. */
	readonly family: string;

	/** The offending kind (typed `unknown` because the caller has already widened it via `_exhaustive: never`). */
	readonly received: unknown;

	/** The valid kind literals the switch was supposed to cover. */
	readonly knownKinds: readonly string[];
}

/**
 * Format the message for the `never`-typed default arm of an
 * exhaustive switch.
 *
 * Reaching this throw means a new AST kind was added without
 * updating the switch, OR TypeScript's exhaustive `never` check
 * was bypassed (`as any`, runtime AST construction, partial
 * discriminated-union widening). Either way the fix is on the
 * caller side: extend the switch.
 *
 * The message names the family kinds explicitly so the reader can
 * confirm which one is missing without cross-referencing the AST
 * type definition.
 */
export function unhandledKindMessage(args: UnhandledKindArgs): string {
	const { where, family, received, knownKinds } = args;
	const receivedDisplay = JSON.stringify(received) ?? String(received);
	return [
		`Internal bug — \`${where}\` received an unhandled ${family} kind: ${receivedDisplay}.`,
		``,
		`I know how to handle these ${family} kinds:`,
		``,
		`${INDENT}${knownKinds.join(", ")}`,
		``,
		`Reaching this throw means a new ${family} variant was added without`,
		`updating \`${where}\`, or TypeScript's exhaustive \`never\` check was`,
		`bypassed (typically through \`as any\`, an AST built at runtime, or a`,
		`partial discriminated-union widening). Add the missing case to the`,
		`switch in \`${where}\` to fix it.`,
	].join("\n");
}

// ---------------------------------------------------------------
// compilerBugMessage — internal-invariant violation
// ---------------------------------------------------------------

interface CompilerBugArgs {
	/** The function or method that detected the invariant violation. */
	readonly where: string;

	/** The invariant that was violated, phrased as the negation that triggered the throw. */
	readonly invariant: string;

	/** Optional extra context — e.g. the chain of helpers, what the helper's contract was. */
	readonly detail?: string;
}

/**
 * Format the message for an internal-invariant violation.
 *
 * Used when one helper produces a result that should be impossible
 * per its contract — e.g. `compileRelationPath` returning a
 * `self`-marker for a non-self input, or `between` reaching the SQL
 * compiler with neither bound (the schema's `.refine()` should have
 * rejected it upstream).
 *
 * Different from `unhandledKindMessage` because the offending input
 * is not a single AST kind — it's a structural shape an upstream
 * gate was supposed to reject.
 */
export function compilerBugMessage(args: CompilerBugArgs): string {
	const { where, invariant, detail } = args;
	const lines = [`Internal bug — \`${where}\`: ${invariant}.`];
	if (detail) {
		lines.push(``, detail);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------
// typeCheckerBypassMessage — AST violates a checker-enforced rule
// ---------------------------------------------------------------

interface TypeCheckerBypassArgs {
	/** The function or method that detected the bypass. */
	readonly where: string;

	/** A one-sentence summary of what is wrong, e.g. `"property 'foo' is not declared on case type 'patient'"`. */
	readonly summary: string;

	/** What the checker would have required. Rendered in the `expected` slot. */
	readonly expected?: string;

	/** What was actually observed. Rendered in the `got` slot. */
	readonly received?: string;

	/** Site-specific actionable next step. Defaults to a generic checker-routing instruction. */
	readonly hint?: string;
}

const DEFAULT_BYPASS_HINT =
	"route the AST through `checkPredicate` (or construct it via the typed builders in `lib/domain/predicate/builders.ts`) before calling the compiler.";

/**
 * Format the message for a type-checker-bypass error.
 *
 * Used when the AST reached the compiler with a shape `checkPredicate`
 * / `checkExpression` would have rejected — typically an unknown
 * case type, an undeclared property, an under-qualified relation
 * walk, a literal whose type does not match the property it is
 * compared against. The message names the upstream gate so the
 * reader can route through it.
 */
export function typeCheckerBypassMessage(args: TypeCheckerBypassArgs): string {
	const { where, summary, expected, received, hint } = args;
	const lines = [`\`${where}\` — ${summary} (type-checker bypass).`];
	if (expected !== undefined || received !== undefined) {
		lines.push(``);
		if (expected !== undefined) {
			lines.push(`${INDENT}expected: ${expected}`);
		}
		if (received !== undefined) {
			lines.push(`${INDENT}got:      ${received}`);
		}
	}
	lines.push(
		``,
		"The type checker (`checkPredicate` / `checkExpression` in",
		"`lib/domain/predicate/typeChecker.ts`) is the gate every compiler",
		"trusts. Reaching this throw means the AST was compiled without",
		"being checked, or was constructed/mutated at runtime after the",
		"check pass.",
		``,
		`Hint: ${hint ?? DEFAULT_BYPASS_HINT}`,
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------
// missingPredicateThunkMessage — caller did not wire ctx.compilePredicate
// ---------------------------------------------------------------

interface MissingPredicateThunkArgs {
	/** The function or method that detected the missing thunk, e.g. `"compileExpression"`. */
	readonly where: string;

	/** The expression-side AST arm whose evaluation needs the thunk, e.g. `"if"` or `"count(via, where)"`. */
	readonly arm: string;

	/** A short noun-phrase describing the slot whose `Predicate` operand needs compiling, e.g. `"\`if\` arm carries a \`Predicate\` condition"` or `"\`count(via, where)\`'s \`where\` clause is a \`Predicate\`"`. */
	readonly slot: string;
}

/**
 * Format the message for the "predicate thunk not wired" caller-setup
 * error.
 *
 * The expression compiler does not import `compilePredicate` directly
 * — the cycle would close on itself, since the predicate compiler in
 * turn calls `compileExpression` for its widened operand slots. The
 * cycle break is `ExpressionCompileContext.compilePredicate`, an
 * optional callback the integrating caller supplies. Two arms (`if`
 * and `count(via, where)`) carry `Predicate` operands and so trigger
 * this throw when the callback is absent.
 *
 * Distinct from `typeCheckerBypassMessage` because the AST is well-
 * typed; the failure is in the runtime call-site setup, not the AST
 * shape. Distinct from `compilerBugMessage` because the fix is on the
 * caller side (wire the callback), not on the compiler side.
 */
export function missingPredicateThunkMessage(
	args: MissingPredicateThunkArgs,
): string {
	const { where, arm, slot } = args;
	return [
		`\`${where}\` — \`${arm}\` reached the expression compiler without a wired predicate compiler.`,
		``,
		`The ${slot}, but \`ctx.compilePredicate\` is \`undefined\`. The expression`,
		"compiler does not import `compilePredicate` directly (the cycle would",
		"close on itself); the integrating caller is responsible for supplying",
		"the callback.",
		``,
		"Hint: pass `compilePredicate` (from `lib/case-store/sql`) on",
		"`ExpressionCompileContext.compilePredicate` before invoking",
		"`compileExpression` on any AST that may contain `if` or `count(via, where)`.",
	].join("\n");
}
