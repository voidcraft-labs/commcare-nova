/**
 * CommCare suite-entry derivation.
 *
 * Derives the per-form `<entry>` block compiled into `suite.xml`: the form
 * command + locale, any session datums the entry needs (currently the
 * single `case_id` for case-loading forms), and the post-submit `<stack>`
 * operations that decide where the user lands after `<submit/>`. Also
 * owns the post-submit destination ↔ HQ-workflow string mapping that
 * round-trips between the in-memory enum and the wire vocabulary HQ
 * expects.
 *
 * CommCare Core defines three stack-operation kinds — `<create>`,
 * `<push>`, `<clear>`. All three are typed for completeness; only
 * `<create>` is emitted. Simple post-submit destinations produce one
 * unconditional `<create>`; form-link-enabled forms produce one
 * `<create if="...">` per link plus a fallback `<create if="not(c1) and
 * not(c2)...">` that runs the `postSubmit` destination when no link
 * condition matches.
 */

import type { FormType, PostSubmitDestination } from "@/lib/domain";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import { validateCaseType } from "./identifierValidation";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "./predicate";
import { emitNodesetFilter } from "./suite/case-list/nodesetFilter";
import type { FormActions, HqFormLink } from "./types";

// ── Session Datums ─────────────────────────────────────────────────────

/**
 * A datum required by a form entry's `<session>` block.
 *
 * Two shapes share this struct because CCHQ emits both as
 * `<datum>` elements in the same `<session>` block:
 *
 *   - **Nodeset datum** — case-loading forms (followup / close). Carries
 *     `nodeset` + `value` (the user picks a case from a list rendered
 *     against `nodeset`; `value="./@case_id"` extracts the chosen id).
 *     `instanceId` + `instanceSrc` declare which jr:// instance the
 *     nodeset reads from (typically `casedb`).
 *   - **Function datum** — case-creating forms (registration / subcase).
 *     Carries `function` (typically `uuid()`), which CommCare evaluates
 *     once at entry to mint a fresh id for the case the form will
 *     create. No nodeset, no value, no instance dependency.
 *
 * Mutually exclusive on the wire: a datum is one shape or the other.
 * The renderer (`renderEntryXml`) branches on whether `function` is set.
 */
export interface SessionDatum {
	id: string;
	/** Instance the nodeset reads from. Required for nodeset datums; omitted for function datums. */
	instanceId?: string;
	instanceSrc?: string;
	/** Required for nodeset datums; omitted for function datums. */
	nodeset?: string;
	/** Required for nodeset datums; omitted for function datums. */
	value?: string;
	/**
	 * The XPath function CommCare evaluates once at entry. Set for
	 * function datums (case-create's `uuid()`); omitted for nodeset
	 * datums. Sourced from CCHQ's `EntriesHelper.get_new_case_id_datums_meta`.
	 */
	function?: string;
	detailSelect?: string;
	detailConfirm?: string;
	autoselect?: boolean;
}

/** A secondary instance required by a form entry. */
export interface EntryInstance {
	id: string;
	src: string;
}

// ── Stack Operations ───────────────────────────────────────────────────
//
// CommCare Core (StackOperation.java) defines three operation types.
// After form submission, CommCare evaluates operations top-to-bottom:
//
//   1. Each operation's `if` condition is checked (null = always trigger).
//   2. For <create>: a new frame is pushed onto the stack.
//   3. For <push>: steps are added to the current frame.
//   4. For <clear>: frames are removed from the stack.
//   5. If a rewind occurs during <create>/<push>, remaining ops are SKIPPED.
//   6. Multiple <create> ops that all match ALL execute (not mutually exclusive).
//      They're popped in LIFO order during session resolution.
//
// Key difference between no <stack> and empty <create/>:
//   - No <stack>: form frame is popped, user returns to previous level
//   - <create/>: empty frame pushed, resolves to home (no command = no entry)
//   - <clear/>: stack is wiped, session ends, user goes home

/** A child element of a <create> or <push> operation. */
export type StackChild =
	| { type: "command"; value: string }
	| { type: "datum"; id: string; value: string };

/**
 * A single stack operation in suite.xml.
 *
 * Maps directly to CommCare Core's StackOperation class:
 *   OPERATION_CREATE (0) → op: 'create'
 *   OPERATION_PUSH (1)   → op: 'push'
 *   OPERATION_CLEAR (2)  → op: 'clear'
 */
export interface StackOperation {
	/** The operation type. */
	op: "create" | "push" | "clear";
	/** XPath condition — operation executes only when this is true. Omit = always. */
	ifClause?: string;
	/** Commands and datums. Must be empty for 'clear' operations. */
	children: StackChild[];
}

// ── Entry Definition ───────────────────────────────────────────────────

/** Complete entry definition for a form in suite.xml. */
export interface EntryDefinition {
	formXmlns: string;
	commandId: string;
	localeId: string;
	instances: EntryInstance[];
	session?: { datums: SessionDatum[] };
	stack?: { operations: StackOperation[] };
}

// ── Derivation Functions ───────────────────────────────────────────────

const SESSION_REF = "instance('commcaresession')/session/data";

/**
 * Derive session datums required by a form entry.
 *
 * Emits up to one of each kind, in this order:
 *
 *   1. The `case_id` nodeset datum for case-loading forms (followup,
 *      close). Lets the user pick a case from the case list; `value`
 *      extracts the chosen id.
 *   2. A `case_id_new_<casetype>_0` function datum for case-create
 *      forms (registration). CommCare evaluates `uuid()` once at entry
 *      to mint a fresh id for the case the form will create.
 *   3. One `case_id_new_<subcasetype>_<idx>` function datum per active
 *      subcase action with no `repeat_context` (subcases in a repeat
 *      get their id minted per-iteration via a calculate bind rather
 *      than a session datum — handled by the XForm emitter).
 *
 * Index rule for subcases mirrors CCHQ's
 * `commcare-hq/corehq/apps/app_manager/models.py::Form.session_var_for_action`:
 * the index is the subcase's position in `actions.subcases`, plus 1
 * when the form also has an active `open_case` (so the primary
 * case-create is always `_0`).
 *
 * The optional `caseListFilter` is the module's
 * `caseListConfig.filter` predicate; when present, the wire layer
 * appends its bracketed XPath fragment to the nodeset after the
 * `[@case_type][@status]` predicates, narrowing the case set the
 * runtime selects from. Filter precedence (case-type / status
 * first, user filter last) matches CCHQ's canonical builder at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`.
 *
 * `actions` is the form's `FormActions` (post-expansion). The function
 * inspects `actions.open_case.condition` and `actions.subcases` to
 * decide which case-create datums to emit. When omitted (transitional
 * callers haven't been migrated yet), only the case-loading datum is
 * emitted — the pre-existing behavior.
 */
export function deriveSessionDatums(
	formType: FormType,
	moduleIndex: number,
	caseType?: string,
	caseListFilter?: Predicate,
	actions?: FormActions,
): SessionDatum[] {
	const datums: SessionDatum[] = [];

	// (1) Case-loading datum for followup / close.
	if (CASE_LOADING_FORM_TYPES.has(formType) && caseType) {
		const filterFragment = emitNodesetFilter(caseListFilter);
		datums.push({
			id: "case_id",
			instanceId: "casedb",
			instanceSrc: "jr://instance/casedb",
			nodeset: `instance('casedb')/casedb/case[@case_type='${validateCaseType(caseType)}'][@status='open']${filterFragment}`,
			value: "./@case_id",
			detailSelect: `m${moduleIndex}_case_short`,
		});
	}

	if (!actions) return datums;

	// (2) Case-create datum for an active `open_case` action. CCHQ
	// emits this whenever `'open_case' in form.active_actions()`, which
	// in Nova's FormActions shape is condition.type in {always, if}.
	const opensCase =
		actions.open_case.condition.type === "always" ||
		actions.open_case.condition.type === "if";
	const opensSubcaseIndexOffset = opensCase ? 1 : 0;
	if (opensCase && caseType) {
		datums.push({
			id: `case_id_new_${validateCaseType(caseType)}_0`,
			function: "uuid()",
		});
	}

	// (3) Per-subcase datums. Skip subcases whose action is inactive or
	// that live in a repeat — CCHQ also skips repeat-context subcases
	// for session emission and uses a per-iteration calculate bind on
	// the form side. The wire-layer datum index counts ALL active
	// subcases (including any repeat-context ones), then this function
	// only EMITS for the non-repeat-context ones — matching the
	// `Form.session_var_for_action` numbering at the CCHQ side.
	for (let i = 0; i < actions.subcases.length; i++) {
		const sc = actions.subcases[i];
		if (sc.condition.type !== "always" && sc.condition.type !== "if") {
			continue;
		}
		if (sc.repeat_context) continue;
		datums.push({
			id: `case_id_new_${validateCaseType(sc.case_type)}_${i + opensSubcaseIndexOffset}`,
			function: "uuid()",
		});
	}

	return datums;
}

/**
 * Derive stack operations for simple post-submit destinations.
 *
 * | Destination      | Operation                                              |
 * |------------------|--------------------------------------------------------|
 * | `default`        | `<create/>` — empty frame, resolves to home            |
 * | `root`           | `<create><command value="'root'"/></create>`            |
 * | `module`         | `<create><command value="'m{idx}'"/></create>`          |
 * | `parent_module`  | Same as module (stub — parent modules not modeled)     |
 * | `previous`       | `<create>` with module cmd + case datums from session  |
 */
export function derivePostSubmitStack(
	postSubmit: PostSubmitDestination,
	moduleIndex: number,
	formType: FormType,
	caseType?: string,
): StackOperation[] {
	switch (postSubmit) {
		case "app_home":
			return [{ op: "create", children: [] }];

		case "root":
			return [
				{ op: "create", children: [{ type: "command", value: "'root'" }] },
			];

		case "module":
			return [
				{
					op: "create",
					children: [{ type: "command", value: `'m${moduleIndex}'` }],
				},
			];

		case "parent_module":
			// Stub: falls back to module until parent modules are modeled.
			return [
				{
					op: "create",
					children: [{ type: "command", value: `'m${moduleIndex}'` }],
				},
			];

		case "previous":
			return [
				{
					op: "create",
					children: [
						{ type: "command", value: `'m${moduleIndex}'` },
						...(CASE_LOADING_FORM_TYPES.has(formType) && caseType
							? [
									{
										type: "datum" as const,
										id: "case_id",
										value: `${SESSION_REF}/case_id`,
									},
								]
							: []),
					],
				},
			];
	}
}

/**
 * Derive stack operations for a form whose `formLinks` array is populated.
 *
 * Each link becomes one `<create>` — conditional when the link carries an
 * XPath condition, unconditional when it doesn't. For `form` targets the
 * create pushes the module command followed by the form command (CommCare
 * requires the module frame on the stack before the form frame). For
 * `module` targets it pushes only the module command, landing the user on
 * the module's form list. Link-level `datums` are appended verbatim —
 * they override auto-derived session variables when the defaults don't
 * fit (e.g. conditionally passing a different case_id).
 *
 * When at least one link has a condition, an additional fallback create
 * is appended whose `if` negates every link condition (`not(c1) and
 * not(c2) and …`). The fallback's body is the same operation
 * `derivePostSubmitStack` would emit for the form's `postSubmit`
 * destination, so the form still navigates somewhere sensible when none
 * of the conditions matches. No fallback is emitted when every link is
 * unconditional — one of them is guaranteed to fire.
 *
 * Indices are resolved by the caller before this function runs; link
 * targets here speak HQ's 0-based module/form index vocabulary, not
 * domain uuids.
 */
export function deriveFormLinkStack(
	links: HqFormLink[],
	fallback: PostSubmitDestination,
	sourceModuleIndex: number,
	sourceFormType: FormType,
	sourceCaseType?: string,
): StackOperation[] {
	const ops: StackOperation[] = [];
	const conditions: string[] = [];

	for (const link of links) {
		if (link.condition) conditions.push(link.condition);

		const children: StackChild[] = [];

		// Form targets need the module frame AND the form frame; module
		// targets need only the module. CommCare's session resolver walks
		// the stack top-down, so the order here (module before form)
		// matches the enclosing-context semantics the mobile runtime
		// expects.
		if (link.target.type === "form") {
			children.push({
				type: "command",
				value: `'m${link.target.moduleIndex}'`,
			});
			children.push({
				type: "command",
				value: `'m${link.target.moduleIndex}-f${link.target.formIndex}'`,
			});
		} else {
			children.push({
				type: "command",
				value: `'m${link.target.moduleIndex}'`,
			});
		}

		// Link-level datum overrides. When CommCare's auto-derivation
		// would install the wrong session variable (e.g. the target form
		// expects a different case than the source form just submitted),
		// the authoring surface lets users supply the datum explicitly.
		if (link.datums) {
			for (const d of link.datums) {
				children.push({ type: "datum", id: d.name, value: d.xpath });
			}
		}

		ops.push({
			op: "create",
			...(link.condition && { ifClause: link.condition }),
			children,
		});
	}

	// Fallback frame: only needed when at least one link is conditional.
	// If every link is unconditional, the first one always fires and
	// appending a fallback would produce unreachable XML.
	if (conditions.length > 0) {
		const negated = conditions.map((c) => `not(${c})`).join(" and ");
		const fallbackOps = derivePostSubmitStack(
			fallback,
			sourceModuleIndex,
			sourceFormType,
			sourceCaseType,
		);
		for (const op of fallbackOps) {
			ops.push({ ...op, ifClause: negated });
		}
	}

	return ops;
}

/**
 * Build a complete EntryDefinition for a form.
 *
 * The compiler resolves the form's module/form indices + case type +
 * indexed form_links from their uuids before calling this —
 * `deriveEntryDefinition` only deals with the suite-level index world
 * and never touches the doc.
 *
 * `formLinks` takes priority over `postSubmit` when non-empty: the stack
 * becomes one conditional `<create>` per link plus a fallback that fires
 * the `postSubmit` destination when no condition matches. An empty (or
 * omitted) `formLinks` falls back to the simple `postSubmit` derivation.
 *
 * `caseListFilter` is the module's `caseListConfig.filter` predicate;
 * the wire layer routes it through `deriveSessionDatums` so the
 * resulting case-loading datum's nodeset narrows to the authored
 * filter's match set. The filter is meaningful only on case-loading
 * form types — `deriveSessionDatums` ignores it for registration /
 * survey forms because they emit no case-loading datum at all.
 *
 * `searchButtonDisplayCondition` is the module's
 * `caseSearchConfig.searchButtonDisplayCondition` predicate. It
 * lowers to the `<action relevant>` attribute on the case-list
 * detail's search-action element, which evaluates in the enclosing
 * `<entry>` context — so every instance the predicate references
 * needs an `<instance>` declaration here alongside the filter's
 * instances.
 *
 * `caseListColumnExpressions` carries every calc-column expression
 * the module's case-list short / long detail emits. CCHQ's runtime
 * resolves a detail's `instance(...)` references against the
 * enclosing entry's declarations (the entry's `<datum
 * detail-select="m{N}_case_short" ... >` ties the two together);
 * CCHQ's server-side `InstancesHelper.add_entry_instances` walks
 * `detail.get_all_xpaths()` for every detail the entry references
 * and adds the missing declarations on the regenerated suite. Nova's
 * local `.ccz` emission has no equivalent post-process, so the
 * accumulator walks each calc expression's term set here.
 */
export function deriveEntryDefinition(
	formXmlns: string,
	moduleIndex: number,
	formIndex: number,
	formType: FormType,
	postSubmit: PostSubmitDestination,
	caseType?: string,
	formLinks?: HqFormLink[],
	caseListFilter?: Predicate,
	searchButtonDisplayCondition?: Predicate,
	caseListColumnExpressions?: readonly ValueExpression[],
	actions?: FormActions,
): EntryDefinition {
	const commandId = `m${moduleIndex}-f${formIndex}`;
	const localeId = `forms.m${moduleIndex}f${formIndex}`;

	const datums = deriveSessionDatums(
		formType,
		moduleIndex,
		caseType,
		caseListFilter,
		actions,
	);
	const instances: EntryInstance[] = [];
	const seen = new Set<string>();

	if (datums.length > 0) {
		for (const d of datums) {
			// Function datums (case-create's uuid()) don't read any instance;
			// only nodeset datums declare an instance dependency.
			if (!d.instanceId) continue;
			if (!seen.has(d.instanceId)) {
				seen.add(d.instanceId);
				instances.push({ id: d.instanceId, src: d.instanceSrc ?? "" });
			}
		}
	}

	// Predicate-derived instance accumulation. Every predicate whose
	// XPath fragment lives inside an `<entry>`-scoped slot
	// contributes its instance set here — the case-list filter (lives
	// inside the case-loading datum's nodeset) and the search-button
	// display condition (lives on the case-list detail's
	// `<action relevant>` attribute, evaluated against the enclosing
	// entry's instances). The Term-kind → instance-id mapping is
	// fixed in `instanceSourceFor` so emission stays consistent
	// across surfaces (`<entry>`, `<remote-request>`, future
	// `<query>` slots).
	const predicatesContributing: Predicate[] = [];
	if (caseListFilter !== undefined) predicatesContributing.push(caseListFilter);
	if (searchButtonDisplayCondition !== undefined) {
		predicatesContributing.push(searchButtonDisplayCondition);
	}
	for (const predicate of predicatesContributing) {
		for (const id of collectPredicateInstances(predicate)) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id) });
		}
	}
	// Calc-column expressions land on `m{N}_case_short` /
	// `m{N}_case_long`. CCHQ resolves the detail's XPath against the
	// enclosing entry's instance declarations — accumulate every
	// instance the expression reaches so the local `.ccz` carries the
	// same declarations CCHQ's server-side post-process would add on a
	// regenerated suite.
	if (caseListColumnExpressions !== undefined) {
		for (const expression of caseListColumnExpressions) {
			for (const id of collectExpressionInstances(expression)) {
				if (seen.has(id)) continue;
				seen.add(id);
				instances.push({ id, src: instanceSourceFor(id) });
			}
		}
	}

	// Determine stack operations. Three cases:
	//   1. Form has form_links → emit one <create> per link plus a
	//      negated-conditions fallback (when any link is conditional).
	//   2. No form_links, postSubmit !== 'app_home' → emit the simple
	//      post-submit stack.
	//   3. No form_links, postSubmit === 'app_home' → omit <stack>
	//      entirely; CommCare's default (no stack ops) pops the form
	//      frame, producing the same home-navigation result as an empty
	//      <create/> with cleaner XML.
	let operations: StackOperation[] | undefined;
	if (formLinks && formLinks.length > 0) {
		operations = deriveFormLinkStack(
			formLinks,
			postSubmit,
			moduleIndex,
			formType,
			caseType,
		);
	} else if (postSubmit !== "app_home") {
		operations = derivePostSubmitStack(
			postSubmit,
			moduleIndex,
			formType,
			caseType,
		);
	}

	return {
		formXmlns,
		commandId,
		localeId,
		instances,
		...(datums.length > 0 && { session: { datums } }),
		...(operations && { stack: { operations } }),
	};
}

// ── XML Serialization ──────────────────────────────────────────────────

/** Render an EntryDefinition to a suite.xml `<entry>` string. */
export function renderEntryXml(entry: EntryDefinition): string {
	const parts: string[] = [];

	parts.push(`  <entry>`);
	parts.push(`    <form>${entry.formXmlns}</form>`);
	parts.push(`    <command id="${entry.commandId}">`);
	parts.push(`      <text><locale id="${entry.localeId}"/></text>`);
	parts.push(`    </command>`);

	for (const inst of entry.instances) {
		parts.push(`    <instance id="${inst.id}" src="${inst.src}"/>`);
	}

	if (entry.session) {
		parts.push(`    <session>`);
		for (const d of entry.session.datums) {
			if (d.function !== undefined) {
				// Function datum — `<datum id="..." function="uuid()"/>`.
				// CommCare evaluates the function once at entry; there is no
				// nodeset, value, or detail to wire up.
				parts.push(`      <datum id="${d.id}" function="${d.function}"/>`);
				continue;
			}
			// Nodeset datum — case-loading shape.
			const detailAttr = d.detailSelect
				? ` detail-select="${d.detailSelect}"`
				: "";
			const confirmAttr = d.detailConfirm
				? ` detail-confirm="${d.detailConfirm}"`
				: "";
			parts.push(
				`      <datum id="${d.id}" nodeset="${d.nodeset}" value="${d.value}"${detailAttr}${confirmAttr}/>`,
			);
		}
		parts.push(`    </session>`);
	}

	if (entry.stack) {
		parts.push(renderStackXml(entry.stack.operations));
	}

	parts.push(`  </entry>`);
	return parts.join("\n");
}

/** Render stack operations to a suite.xml `<stack>` string. */
export function renderStackXml(operations: StackOperation[]): string {
	if (operations.length === 0) return "";

	const elements = operations.map((op) => {
		const ifAttr = op.ifClause ? ` if="${op.ifClause}"` : "";

		if (op.op === "clear") {
			return `      <clear${ifAttr}/>`;
		}

		const tag = op.op; // 'create' or 'push'

		if (op.children.length === 0) {
			return `      <${tag}${ifAttr}/>`;
		}

		const children = op.children.map((child) => {
			if (child.type === "command") {
				return `        <command value="${child.value}"/>`;
			}
			return `        <datum id="${child.id}" value="${child.value}"/>`;
		});

		return `      <${tag}${ifAttr}>\n${children.join("\n")}\n      </${tag}>`;
	});

	return `    <stack>\n${elements.join("\n")}\n    </stack>`;
}

// ── HQ Workflow Mapping ────────────────────────────────────────────────
//
// One-way: domain `PostSubmitDestination` → HQ wire `post_form_workflow`
// string. The reverse direction (parsing the wire value back to a
// domain enum) isn't needed because the compile pipeline reads
// post-submit straight from the doc; the wire shape is write-only from
// Nova's perspective. Eliminating the reverse mapping also removes a
// fidelity trap: `app_home` and an absent-destination both encode to
// `"default"` on the wire, so the reverse lookup was lossy.

const NOVA_TO_HQ: Record<PostSubmitDestination, string> = {
	app_home: "default",
	root: "root",
	module: "module",
	parent_module: "parent_module",
	previous: "previous_screen",
};

export function toHqWorkflow(postSubmit: PostSubmitDestination): string {
	return NOVA_TO_HQ[postSubmit];
}
