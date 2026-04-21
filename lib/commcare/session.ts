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
import { validateCaseType } from "./identifierValidation";
import type { HqFormLink } from "./types";

// ── Session Datums ─────────────────────────────────────────────────────

/** A datum required by a form entry's `<session>` block. */
export interface SessionDatum {
	id: string;
	instanceId: string;
	instanceSrc: string;
	nodeset: string;
	value: string;
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
 * Currently emits a single `case_id` datum for case-loading forms
 * (followup, close). Advanced-module multi-datum sessions, parent
 * datums, and search datums will extend this when those features ship.
 */
export function deriveSessionDatums(
	formType: FormType,
	moduleIndex: number,
	caseType?: string,
): SessionDatum[] {
	if (!CASE_LOADING_FORM_TYPES.has(formType) || !caseType) return [];

	return [
		{
			id: "case_id",
			instanceId: "casedb",
			instanceSrc: "jr://instance/casedb",
			nodeset: `instance('casedb')/casedb/case[@case_type='${validateCaseType(caseType)}'][@status='open']`,
			value: "./@case_id",
			detailSelect: `m${moduleIndex}_case_short`,
		},
	];
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
 */
export function deriveEntryDefinition(
	formXmlns: string,
	moduleIndex: number,
	formIndex: number,
	formType: FormType,
	postSubmit: PostSubmitDestination,
	caseType?: string,
	formLinks?: HqFormLink[],
): EntryDefinition {
	const commandId = `m${moduleIndex}-f${formIndex}`;
	const localeId = `forms.m${moduleIndex}f${formIndex}`;

	const datums = deriveSessionDatums(formType, moduleIndex, caseType);
	const instances: EntryInstance[] = [];

	if (datums.length > 0) {
		const seen = new Set<string>();
		for (const d of datums) {
			if (!seen.has(d.instanceId)) {
				seen.add(d.instanceId);
				instances.push({ id: d.instanceId, src: d.instanceSrc });
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
