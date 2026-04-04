/**
 * CommCare Session, Datum & Stack Management
 *
 * Single source of truth for deriving CommCare session mechanics from the blueprint.
 * Controls entry definitions (what datums a form requires) and stack operations
 * (where to navigate after form submission) in suite.xml.
 *
 * CommCare Core processes three stack operation types after form submission:
 *   <create>  — Push a new navigation frame (module/form target + datums)
 *   <push>    — Add steps to the current frame (append datums/commands)
 *   <clear>   — Remove frames from the stack (wipe navigation history)
 *
 * All three are modeled here. Currently only <create> is generated;
 * <push> and <clear> are typed for completeness and future use.
 *
 * Architecture:
 *   - Post-submit navigation (implemented: all 5 destinations)
 *   - Form linking / conditional navigation (validated, generation not wired to UI/tools)
 *   - Case selection datums (implemented)
 *   - Advanced module multi-datum sessions (future)
 *   - Case search datums (future)
 *   - Parent/child module navigation (future)
 */

import type {
	AppBlueprint,
	BlueprintForm,
	FormLink,
	PostSubmitDestination,
} from "../../schemas/blueprint";
import { validateCaseType } from "./validate";

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

// ── Re-export FormLink types from schema for convenience ───────────────

export type { FormLinkDatum } from "../../schemas/blueprint";
export type { FormLink };

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
 * Currently: single case_id datum for followup forms.
 * Future: multiple datums for advanced modules, parent datums, search datums.
 */
export function deriveSessionDatums(
	formType: "registration" | "followup" | "survey",
	moduleIndex: number,
	caseType?: string,
): SessionDatum[] {
	if (formType !== "followup" || !caseType) return [];

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
	formType: "registration" | "followup" | "survey",
	caseType?: string,
): StackOperation[] {
	switch (postSubmit) {
		case "default":
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
						...(formType === "followup" && caseType
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
 * Derive stack operations for form linking.
 *
 * Generates one <create> per link (with ifClause from link.condition),
 * plus a fallback <create> whose condition negates all link conditions.
 *
 * Datum management:
 *   - For form targets: includes module command + form command + session datums
 *   - For module targets: includes module command only
 *   - Manual datums from FormLink.datums override auto-derived ones
 *
 * NOT YET WIRED TO UI OR SA TOOLS.
 * Validated by the validation suite; generation works when called directly.
 * UI and SA tool support will be added when form linking is exposed.
 */
export function deriveFormLinkStack(
	links: FormLink[],
	fallback: PostSubmitDestination,
	sourceModuleIndex: number,
	sourceFormType: "registration" | "followup" | "survey",
	sourceCaseType?: string,
): StackOperation[] {
	const ops: StackOperation[] = [];
	const conditions: string[] = [];

	for (const link of links) {
		if (link.condition) conditions.push(link.condition);

		const children: StackChild[] = [];

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

		// Manual datum overrides
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

	// Fallback frame: when any link has a condition, generate a fallback
	// whose condition negates ALL link conditions.
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
 */
export function deriveEntryDefinition(
	formXmlns: string,
	moduleIndex: number,
	formIndex: number,
	formType: "registration" | "followup" | "survey",
	postSubmit: PostSubmitDestination,
	caseType?: string,
	formLinks?: FormLink[],
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

	// Determine stack operations
	let operations: StackOperation[] | undefined;

	if (formLinks && formLinks.length > 0) {
		// Form linking takes priority over simple post_submit
		operations = deriveFormLinkStack(
			formLinks,
			postSubmit,
			moduleIndex,
			formType,
			caseType,
		);
	} else if (postSubmit !== "default") {
		operations = derivePostSubmitStack(
			postSubmit,
			moduleIndex,
			formType,
			caseType,
		);
	}
	// When postSubmit === 'default' and no form links: omit <stack> entirely.
	// CommCare's default behavior (no stack ops) pops the form frame.
	// But HQ emits an empty <create/> for WORKFLOW_DEFAULT when
	// enable_post_form_workflow is on. We omit it for cleaner XML —
	// the empty <create/> produces the same home-navigation result.

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

// ── Form Link Validation Helpers ───────────────────────────────────────

/**
 * Detect circular form links: A→B→A.
 *
 * Walks the link graph from each form, checking if any path leads
 * back to a previously visited form. Returns the cycle path if found.
 */
export function detectFormLinkCycles(
	blueprint: AppBlueprint,
): Array<{ chain: string[]; formKey: string }> {
	const cycles: Array<{ chain: string[]; formKey: string }> = [];

	// Build adjacency: formKey → set of target formKeys
	const adj = new Map<string, Set<string>>();
	for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
		const mod = blueprint.modules[mIdx];
		for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
			const form = mod.forms[fIdx];
			if (!form.form_links?.length) continue;
			const key = `m${mIdx}f${fIdx}`;
			const targets = new Set<string>();
			for (const link of form.form_links) {
				if (link.target.type === "form") {
					targets.add(`m${link.target.moduleIndex}f${link.target.formIndex}`);
				}
				// Module targets don't create cycles (they navigate to a menu, not a form)
			}
			if (targets.size > 0) adj.set(key, targets);
		}
	}

	// DFS for each starting form
	for (const startKey of adj.keys()) {
		const visited = new Set<string>();
		const stack = [{ key: startKey, chain: [startKey] }];

		while (stack.length > 0) {
			const { key, chain } = stack.pop()!;
			const targets = adj.get(key);
			if (!targets) continue;

			for (const target of targets) {
				if (target === startKey) {
					cycles.push({ chain: [...chain, target], formKey: startKey });
				} else if (!visited.has(target)) {
					visited.add(target);
					stack.push({ key: target, chain: [...chain, target] });
				}
			}
		}
	}

	return cycles;
}

// ── HQ Workflow Mapping ────────────────────────────────────────────────

const NOVA_TO_HQ: Record<PostSubmitDestination, string> = {
	default: "default",
	root: "root",
	module: "module",
	parent_module: "parent_module",
	previous: "previous_screen",
};

const HQ_TO_NOVA: Record<string, PostSubmitDestination> = {
	default: "default",
	root: "root",
	module: "module",
	parent_module: "parent_module",
	previous_screen: "previous",
};

export function toHqWorkflow(postSubmit: PostSubmitDestination): string {
	return NOVA_TO_HQ[postSubmit];
}

export function fromHqWorkflow(workflow: string): PostSubmitDestination {
	return HQ_TO_NOVA[workflow] ?? "default";
}
