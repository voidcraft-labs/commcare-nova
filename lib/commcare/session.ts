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
 * `<create>` is currently emitted. Conditional / form-link stacks (one
 * `<create>` per link with a fallback whose condition negates every
 * link condition) belong here too once the SA + UI surface them; the
 * derivation logic will land alongside `derivePostSubmitStack` when
 * called for, with the index resolution done by the compiler.
 */

import type { FormType, PostSubmitDestination } from "@/lib/domain";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import { validateCaseType } from "./identifierValidation";

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
 * Build a complete EntryDefinition for a form.
 *
 * The compiler resolves the form's module/form indices + case type from
 * its uuid before calling this — `deriveEntryDefinition` only deals with
 * the suite-level index world and never touches the doc.
 */
export function deriveEntryDefinition(
	formXmlns: string,
	moduleIndex: number,
	formIndex: number,
	formType: FormType,
	postSubmit: PostSubmitDestination,
	caseType?: string,
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

	// Determine stack operations. When postSubmit === 'app_home' we omit
	// the <stack> entirely — CommCare's default (no stack ops) pops the
	// form frame, which produces the same home-navigation result as an
	// empty <create/> with cleaner XML.
	const operations: StackOperation[] | undefined =
		postSubmit !== "app_home"
			? derivePostSubmitStack(postSubmit, moduleIndex, formType, caseType)
			: undefined;

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

const NOVA_TO_HQ: Record<PostSubmitDestination, string> = {
	app_home: "default",
	root: "root",
	module: "module",
	parent_module: "parent_module",
	previous: "previous_screen",
};

const HQ_TO_NOVA: Record<string, PostSubmitDestination> = {
	default: "app_home",
	root: "root",
	module: "module",
	parent_module: "parent_module",
	previous_screen: "previous",
};

export function toHqWorkflow(postSubmit: PostSubmitDestination): string {
	return NOVA_TO_HQ[postSubmit];
}

export function fromHqWorkflow(workflow: string): PostSubmitDestination {
	return HQ_TO_NOVA[workflow] ?? "app_home";
}
