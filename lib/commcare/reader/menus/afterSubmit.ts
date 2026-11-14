/**
 * Where a form goes after submit: the workflow word, the links HQ runs under
 * `form` (each a destination, in reverse of the order Nova authors them),
 * the otherwise (HQ's fallback word, or a last link whose condition negates
 * every other), and the held-case guard Nova's emitter conjoins to a link
 * that carries a case onto a single-case selection. A guard is a fact of the
 * link's structure, so it is taken off the stored condition before the
 * expression stage binds what is left.
 */
import {
	type BlueprintDoc,
	defaultPostSubmitOf,
	type Expression,
	type FormLink,
	type FormLinkDatum,
	type FormLinkTarget,
	type FormOtherwise,
	guardedLinkDatums,
	menuTargetOffered,
	type OtherwiseDestination,
	otherwiseDestinationsOffered,
	type PostSubmitDestination,
	postSubmitDestinationsOffered,
	postSubmitModuleFacts,
	type Uuid,
} from "@/lib/domain";
import type { FormLinkDatumName } from "@/lib/domain/expression/types";
import { emissionPlan } from "../../emissionPlan";
import {
	entryDatumIds,
	formLinkActionsBuildable,
	formLinkProjectionContext,
	owningModuleOf,
} from "../../formLinkProjection";
import { entryPlanContext, runFormRules } from "../../validator/rules/form";
import type { FormSyntax } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import { caseById } from "../../xpath/wire/rowScope";
import { serializeWire } from "../../xpath/wire/serialize";
import { withCandidate } from "../candidate";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import { syntaxOf } from "../hqInterpolation";
import { HQ_PAGE_LABELS } from "../hqPageLabels";
import { externalKey, type FormLinkTargetKey } from "../identity";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { whereText } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import { provisionalDocument } from "../provisional";
import { sameSyntax } from "../syntaxCompare";
import {
	draftFormByReadId,
	draftModuleById,
	rawModuleById,
	rawModules,
} from "./modules";

const F = "forms-and-case-writes";

type FormClass = "Form" | "AdvancedForm";
const FORM_CLASSES: readonly FormClass[] = ["Form", "AdvancedForm"];

function perClass<U extends Claim["use"]>(
	make: (entry: string, key: string) => Claim<U>,
	entry: string,
	field: string,
): Readonly<Record<FormClass, Claim<U>>> {
	return Object.fromEntries(
		FORM_CLASSES.map((cls) => [
			cls,
			make(`${F}/${entry}`, `schema:${cls}.${field}`),
		]),
	) as Record<FormClass, Claim<U>>;
}

/** The workflow words HQ's form settings page offers, each with its destination; `form` is links. */
const WORDS = {
	default: "app_home",
	root: "firstMenu",
	module: "module",
	parent_module: "parentMenu",
	previous_screen: "previous",
} as const satisfies Record<string, PostSubmitDestination>;
type Word = keyof typeof WORDS;

/** The fallback words, each with its built-in otherwise. */
const FALLBACK_WORDS = {
	root: "firstMenu",
	module: "module",
	parent_module: "parentMenu",
	previous_screen: "previous",
} as const satisfies Record<string, OtherwiseDestination>;

const AFTER_SUBMIT = {
	wordDefault: perClass(
		take,
		"post-form-workflow-default",
		"post_form_workflow",
	),
	wordRoot: perClass(take, "post-form-workflow-root", "post_form_workflow"),
	wordModule: perClass(take, "post-form-workflow-module", "post_form_workflow"),
	wordParentModule: perClass(
		take,
		"post-form-workflow-parent-module",
		"post_form_workflow",
	),
	wordPrevious: perClass(
		take,
		"post-form-workflow-previous-screen",
		"post_form_workflow",
	),
	wordForm: perClass(take, "post-form-workflow-form", "post_form_workflow"),
	wordRefusedByBuild: perClass(
		refuse,
		"post-form-workflow-hq-s-build-refuses-module-in-a-put-in-root",
		"post_form_workflow",
	),
	wordNotOffered: perClass(
		refuse,
		"any-other-post-form-workflow-outside-the-offered-set-previous",
		"post_form_workflow",
	),
	previousOnFirstMenu: refuse(
		`${F}/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu`,
		"schema:Form.post_form_workflow",
	),
	notOfferedFinding: refuse(
		`${F}/any-other-post-form-workflow-outside-the-offered-set-previous`,
		"schema:Form.post_form_workflow",
	),
	fallbackModuleOrPrevious: perClass(
		take,
		"post-form-workflow-fallback-module-or-previous-screen-offered-in",
		"post_form_workflow_fallback",
	),
	fallbackRootOrParent: perClass(
		take,
		"post-form-workflow-fallback-root-or-parent-module-offered-in",
		"post_form_workflow_fallback",
	),
	fallbackNotOffered: perClass(
		refuse,
		"post-form-workflow-fallback-module-parent-module-or-previous",
		"post_form_workflow_fallback",
	),
	fallbackUnconditional: perClass(
		drop,
		"post-form-workflow-fallback-offered-in-that-menu-set-where-no",
		"post_form_workflow_fallback",
	),
	fallbackOutside: perClass(
		drop,
		"post-form-workflow-fallback-outside-the-offered-set-anywhere",
		"post_form_workflow_fallback",
	),
	fallbackNone: perClass(
		drop,
		"post-form-workflow-fallback-null-default-or-any-value-other-than",
		"post_form_workflow_fallback",
	),
	linksUnread: perClass(
		drop,
		"form-links-present-while-post-form-workflow-form",
		"form_links",
	),
	links: perClass(
		take,
		"form-links-target-a-form-any-suite-form",
		"form_links",
	),
	targetForm: take(
		`${F}/form-links-target-a-form-any-suite-form`,
		"schema:FormLink.form_id",
	),
	targetThisForm: take(
		`${F}/form-links-target-the-current-form-or-a-link-cycle`,
		"schema:FormLink.form_id",
	),
	targetFormModule: take(
		`${F}/form-links-form-module-id`,
		"schema:FormLink.form_module_id",
	),
	targetModule: take(
		`${F}/form-links-target-a-top-level-or-child-matched-module-that-does`,
		"schema:FormLink.module_unique_id",
	),
	targetModuleNotOffered: refuse(
		`${F}/form-links-target-any-other-module`,
		"schema:FormLink.module_unique_id",
	),
	linkChecks: refuse(
		`${F}/form-links-failing-hq-s-link-checks-no-form-links-and-bad-form`,
		"schema:FormLink.form_id",
	),
	noLinks: perClass(
		refuse,
		"form-links-failing-hq-s-link-checks-no-form-links-and-bad-form",
		"form_links",
	),
	xpath: derived(`${F}/form-links-xpath`, "schema:FormLink.xpath"),
	datums: take(
		`${F}/form-links-datums-on-a-form-target-names-among-the-target-s`,
		"schema:FormLink.datums",
	),
	datumName: take(
		`${F}/form-links-datums-on-a-form-target-names-among-the-target-s`,
		"schema:FormDatum.name",
	),
	datumXpath: derived(
		`${F}/form-links-datums-on-a-form-target-names-among-the-target-s`,
		"schema:FormDatum.xpath",
	),
	datumsOther: refuse(
		`${F}/form-links-datums-with-other-names-or-on-a-module-target`,
		"schema:FormLink.datums",
	),
	datumsIncomplete: perClass(
		refuse,
		"form-links-datums-that-leave-the-target-s-case-id-empty",
		"form_links",
	),
} as const;

defineClaims(
	"menus.afterSubmit",
	Object.fromEntries(
		Object.entries(AFTER_SUBMIT).flatMap(([name, one]) =>
			"use" in one
				? [[name, one as Claim]]
				: Object.entries(one as Record<string, Claim>).map(([cls, claim]) => [
						`${name}@${cls}`,
						claim,
					]),
		),
	) as Record<string, Claim>,
);

const WORD_CLAIMS: Readonly<
	Record<Word | "form", Readonly<Record<FormClass, Claim<"take">>>>
> = {
	default: AFTER_SUBMIT.wordDefault,
	root: AFTER_SUBMIT.wordRoot,
	module: AFTER_SUBMIT.wordModule,
	parent_module: AFTER_SUBMIT.wordParentModule,
	previous_screen: AFTER_SUBMIT.wordPrevious,
	form: AFTER_SUBMIT.wordForm,
};

type JsonObject = Readonly<Record<string, unknown>>;

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isWord(word: unknown): word is Word {
	return typeof word === "string" && Object.hasOwn(WORDS, word);
}

// ── The reading's state ─────────────────────────────────────────────────

/** One stored link, read. */
interface ReadLink {
	readonly cursor: JsonCursor;
	readonly uuid: Uuid;
	readonly target: FormLinkTarget;
	/** The stored `xpath`. */
	readonly xpath: string;
	/** The carried values, with their stored text. */
	readonly datums: readonly {
		readonly name: FormLinkDatumName;
		readonly xpath: string;
		readonly cursor: JsonCursor;
		/** The value's registration. */
		readonly index: number;
	}[];
	/** The condition's registration, where a condition is left after the guards. */
	readonly condition?: number;
	readonly role: "destination" | "otherwise";
}

interface ReadAfterSubmit {
	readonly module: DraftModule;
	readonly form: DraftForm;
	readonly word: Word | "form" | undefined;
	/** Links in stored order, the otherwise link last; undefined until step 4 reads them. */
	links?: readonly ReadLink[];
	/** Whether every link read into a target the document holds. */
	whole?: boolean;
	otherwise?: FormOtherwise;
	/** Whether every registration of its links bound and was written into the document. */
	bound?: boolean;
}

const READINGS = new WeakMap<ReadContext, ReadAfterSubmit[]>();

function readingsOf(ctx: ReadContext): ReadAfterSubmit[] {
	let readings = READINGS.get(ctx);
	if (readings === undefined) {
		readings = [];
		READINGS.set(ctx, readings);
	}
	return readings;
}

// ── Pass 1 ──────────────────────────────────────────────────────────────

/**
 * Pass 1, from `readMenus`: each form's workflow word claimed by the row its
 * word names. The links and the otherwise are read once every entry's
 * structure is, by `registerLinkExpressions`.
 */
export function readAfterSubmit(ctx: ReadContext, app: DraftApp): void {
	const readings = readingsOf(ctx);
	const stored = rawModules(ctx);
	for (const module of app.modules)
		for (const form of module.forms) {
			const { json } = form;
			const cls = form.docType;
			const word = json.peek("post_form_workflow");
			const menu = stored[form.menu] ?? {};
			let read: Word | "form" | undefined;
			const links = json.peek("form_links");
			if (word === "form") {
				// HQ's build refuses `form` with no link to follow (`no form links`).
				if (!Array.isArray(links) || links.length === 0) {
					json.take(
						"post_form_workflow",
						WORD_CLAIMS.form[cls],
						(value) => value,
					).value;
					ctx.accounting.finding(AFTER_SUBMIT.noLinks[cls], form.place);
					if (json.used("post_form_workflow_fallback"))
						json.drop(
							"post_form_workflow_fallback",
							AFTER_SUBMIT.fallbackNone[cls],
						);
					readings.push({ module, form, word: undefined });
					continue;
				}
				read = "form";
			} else if (!isWord(word)) {
				const label = (HQ_PAGE_LABELS.workflow as Record<string, string>)[
					textOf(word)
				];
				json.refuse(
					"post_form_workflow",
					AFTER_SUBMIT.wordNotOffered[cls],
					label === undefined ? undefined : { name: label },
				);
			} else if (word === "module" && menu.put_in_root === true)
				json.refuse("post_form_workflow", AFTER_SUBMIT.wordRefusedByBuild[cls]);
			else read = word;
			if (read !== undefined)
				json.take(
					"post_form_workflow",
					WORD_CLAIMS[read][cls],
					(value) => value,
				).value;
			if (read !== "form") {
				if (json.used("form_links"))
					json.drop("form_links", AFTER_SUBMIT.linksUnread[cls]);
				if (json.used("post_form_workflow_fallback"))
					json.drop(
						"post_form_workflow_fallback",
						AFTER_SUBMIT.fallbackUnconditional[cls],
					);
			}
			readings.push({ module, form, word: read });
		}
}

// ── The held-case guards ────────────────────────────────────────────────

/** A conjunction's top-level conjuncts, in order: `a and b and c` read left to right. */
function conjuncts(node: FormSyntax): FormSyntax[] {
	if (node.kind === "binary" && node.op === "and")
		return [...conjuncts(node.left), ...conjuncts(node.right)];
	return [node];
}

/** `nodes` joined with `and`, left to right, as a printed conjunction parses. */
function conjunction(nodes: readonly FormSyntax[]): FormSyntax | undefined {
	return nodes.reduce<FormSyntax | undefined>(
		(left, right) =>
			left === undefined
				? right
				: { kind: "binary", op: "and", left, right, from: 0, to: 0 },
		undefined,
	);
}

const SENTINEL = "\u0000carried value";

/** `node` with every string literal `SENTINEL` replaced by `value`. */
function substitute(node: FormSyntax, value: FormSyntax): FormSyntax {
	const at = (child: FormSyntax) => substitute(child, value);
	switch (node.kind) {
		case "string":
			return node.value === SENTINEL ? value : node;
		case "group":
		case "negative":
		case "axis":
			return { ...node, value: at(node.value) };
		case "child":
			return {
				...node,
				...(node.left === undefined ? {} : { left: at(node.left) }),
				step: at(node.step),
			};
		case "filter":
			return { ...node, base: at(node.base), where: at(node.where) };
		case "binary":
			return { ...node, left: at(node.left), right: at(node.right) };
		case "call":
			return { ...node, args: node.args.map(at) };
		default:
			return node;
	}
}

/** The guard Nova's emitter conjoins for one carried value: the case it carries is on the
 *  device, of the selection's type (`formLinkProjection.ts::formLinkCarriedCaseGuards`). */
function expectedGuard(
	value: FormSyntax,
	caseType: string | undefined,
): FormSyntax | undefined {
	const guard = w.gt(
		w.call("count", [
			caseById(
				w.str(SENTINEL),
				"casedb",
				caseType === "" ? undefined : caseType,
			),
		]),
		w.num(0),
	);
	const printed = syntaxOf(
		serializeWire(guard, { target: "hq-json", interpolation: "none" }).text,
		undefined,
	);
	return printed.ok ? substitute(printed.syntax, value) : undefined;
}

/** The guards Nova writes for a link, in its carried values' order; undefined where a carried
 *  value's stored text does not parse. */
function expectedGuards(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: Pick<FormLink, "target" | "datums">,
	storedDatums: readonly string[],
): FormSyntax[] | undefined {
	const guarded = new Set(
		guardedLinkDatums(doc, formUuid, link).map((datum) => datum.name),
	);
	const guards: FormSyntax[] = [];
	for (const [index, datum] of (link.datums ?? []).entries()) {
		if (!guarded.has(datum.name)) continue;
		const text = storedDatums[index];
		const value = text === undefined ? undefined : syntaxOf(text, undefined);
		if (value === undefined || !value.ok) return undefined;
		const name = datum.name;
		const caseType =
			name.kind === "selected-case"
				? doc.modules[name.module]?.caseType
				: undefined;
		const guard = expectedGuard(value.syntax, caseType);
		if (guard === undefined) return undefined;
		guards.push(guard);
	}
	return guards;
}

/** Which trailing conjuncts of a stored link `xpath` are the emitter's held-case guards (9.4).
 *  `storedDatums` are the link's carried values as stored, index for index with its `datums`. */
export function linkGuards(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: Pick<FormLink, "target" | "datums">,
	xpath: string,
	storedDatums: readonly string[] = [],
): {
	readonly guards: "none" | "written" | "added";
	readonly expected: number;
} {
	const expected = guardedLinkDatums(doc, formUuid, link).length;
	if (expected === 0) return { guards: "none", expected };
	const guards = expectedGuards(doc, formUuid, link, storedDatums);
	const parsed = xpath.trim() === "" ? undefined : syntaxOf(xpath, undefined);
	if (guards === undefined || parsed === undefined || !parsed.ok)
		return { guards: "added", expected };
	const parts = conjuncts(parsed.syntax);
	if (parts.length < expected) return { guards: "added", expected };
	const tail = parts.slice(parts.length - expected);
	return tail.every((part, index) =>
		sameSyntax(part, guards[index] as FormSyntax),
	)
		? { guards: "written", expected }
		: { guards: "added", expected };
}

/** What is left of a stored `xpath` once its last `strip` conjuncts are taken off, as text. */
function strippedText(xpath: string, strip: number): string {
	if (strip === 0) return xpath;
	const parsed = syntaxOf(xpath, undefined);
	if (!parsed.ok) return xpath;
	const parts = conjuncts(parsed.syntax);
	const kept = parts.slice(0, parts.length - strip);
	if (kept.length === 0) return "";
	const first = kept[0] as FormSyntax;
	const last = kept[kept.length - 1] as FormSyntax;
	// The conjuncts kept stand together at the head of the text, in stored order.
	return parsed.text.slice(first.from, last.to);
}

// ── Step 4: links ───────────────────────────────────────────────────────

interface StoredLink {
	readonly cursor: JsonCursor;
	readonly value: JsonObject;
	readonly target: FormLinkTarget;
	readonly key: FormLinkTargetKey;
	readonly datums: readonly {
		readonly name: FormLinkDatumName;
		readonly xpath: string;
		readonly cursor: JsonCursor;
	}[];
}

/** One stored link's target and carried values, claimed; undefined where it reads to nothing the
 *  document holds (a finding stands at it or at its target). */
function readLinkTarget(
	ctx: ReadContext,
	snapshot: BlueprintDoc,
	datumIds: (
		moduleUuid: Uuid,
		formUuid: Uuid,
	) => ReturnType<typeof entryDatumIds>,
	reading: ReadAfterSubmit,
	cursor: JsonCursor,
	value: JsonObject,
): StoredLink | undefined {
	const formId = value.form_id;
	const moduleId = value.module_unique_id;
	const hasForm = typeof formId === "string" && formId !== "";
	const hasModule = typeof moduleId === "string" && moduleId !== "";
	if (hasForm === hasModule) {
		cursor.refuseWhole(AFTER_SUBMIT.linkChecks);
		return undefined;
	}
	let target: FormLinkTarget;
	let key: FormLinkTargetKey;
	if (hasForm) {
		const named = draftFormByReadId(ctx, formId);
		if (named === undefined) {
			const exists = rawModules(ctx).some(
				(menu) =>
					Array.isArray(menu.forms) &&
					menu.forms.some(
						(form) => isJsonObject(form) && form.unique_id === formId,
					),
			);
			if (!exists) cursor.refuseWhole(AFTER_SUBMIT.linkChecks);
			else cursor.take("form_id", AFTER_SUBMIT.targetForm, (one) => one).value;
			return undefined;
		}
		const folded = ctx.draft.foldedMenus.find(
			(one) => one.formUuid === named.form.uuid,
		);
		const menuId =
			folded === undefined ? named.module.uniqueId : folded.menu.uniqueId;
		const formModuleId = value.form_module_id;
		if (
			typeof formModuleId === "string" &&
			formModuleId !== "" &&
			formModuleId !== menuId
		) {
			cursor.refuseWhole(AFTER_SUBMIT.linkChecks);
			return undefined;
		}
		const self = named.form === reading.form;
		cursor.take(
			"form_id",
			self ? AFTER_SUBMIT.targetThisForm : AFTER_SUBMIT.targetForm,
			(one) => one,
		).value;
		cursor.take("form_module_id", AFTER_SUBMIT.targetFormModule, (one) => one)
			.value;
		target = self
			? { type: "this-form" }
			: {
					type: "form",
					moduleUuid: named.module.uuid,
					formUuid: named.form.uuid,
				};
		key = self ? ["this-form"] : ["form", named.form.xmlns];
	} else {
		const named = draftModuleById(ctx.draft, moduleId);
		if (named === undefined) {
			if (rawModuleById(ctx, moduleId) === undefined)
				cursor.refuseWhole(AFTER_SUBMIT.linkChecks);
			else
				cursor.take("module_unique_id", AFTER_SUBMIT.targetModule, (one) => one)
					.value;
			return undefined;
		}
		if (!menuTargetOffered(snapshot, reading.module.uuid, named.uuid)) {
			cursor.refuse("module_unique_id", AFTER_SUBMIT.targetModuleNotOffered);
			return undefined;
		}
		cursor.take("module_unique_id", AFTER_SUBMIT.targetModule, (one) => one)
			.value;
		target = { type: "module", moduleUuid: named.uuid };
		key = ["module", named.uniqueId];
	}
	const stored = Array.isArray(value.datums)
		? value.datums.filter(isJsonObject)
		: [];
	if (stored.length === 0) return { cursor, value, target, key, datums: [] };
	if (target.type === "module") {
		cursor.refuse("datums", AFTER_SUBMIT.datumsOther);
		return undefined;
	}
	const targetForm =
		target.type === "form" ? target.formUuid : reading.form.uuid;
	const targetModule =
		target.type === "form" ? target.moduleUuid : reading.module.uuid;
	const rows = datumIds(targetModule, targetForm);
	const names: FormLinkDatumName[] = [];
	for (const datum of stored) {
		const name = textOf(datum.name);
		const row = rows.find((one) => one.id === name || one.chainId === name);
		const ref = row?.refs.find((one) => one.kind === "selected-case");
		if (ref === undefined) {
			cursor.refuse("datums", AFTER_SUBMIT.datumsOther);
			return undefined;
		}
		names.push(ref);
	}
	const cursors = cursor.list("datums", "FormDatum", AFTER_SUBMIT.datums);
	const datums = cursors.map((datumCursor, index) => {
		datumCursor.take("name", AFTER_SUBMIT.datumName, (one) => one).value;
		return {
			name: names[index] as FormLinkDatumName,
			xpath: textOf(stored[index]?.xpath),
			cursor: datumCursor,
		};
	});
	return { cursor, value, target, key, datums };
}

/** Whether the last stored link is the otherwise in its second shape: its `xpath` negates every
 *  other link's non-blank `xpath` in stored order, then holds exactly its own guards. */
function lastIsOtherwise(
	snapshot: BlueprintDoc,
	formUuid: Uuid,
	links: readonly StoredLink[],
): boolean {
	if (links.length < 2) return false;
	const last = links[links.length - 1] as StoredLink;
	const others = links
		.slice(0, -1)
		.map((one) => textOf(one.value.xpath))
		.filter((text) => text.trim() !== "");
	if (others.length === 0) return false;
	const parsed = syntaxOf(textOf(last.value.xpath), undefined);
	if (!parsed.ok) return false;
	const parts = conjuncts(parsed.syntax);
	const link = asLink(last);
	const guards = linkGuards(
		snapshot,
		formUuid,
		link,
		textOf(last.value.xpath),
		last.datums.map((one) => one.xpath),
	);
	const own = guards.guards === "written" ? guards.expected : 0;
	if (parts.length !== others.length + own) return false;
	return others.every((text, index) => {
		const other = syntaxOf(text, undefined);
		return (
			other.ok &&
			sameSyntax(parts[index] as FormSyntax, {
				kind: "call",
				name: "not",
				args: [other.syntax],
				from: 0,
				to: 0,
			})
		);
	});
}

/** A stored link as the domain shape `guardedLinkDatums` reads. */
function asLink(link: StoredLink): Pick<FormLink, "target" | "datums"> {
	return link.datums.length === 0
		? { target: link.target }
		: {
				target: link.target,
				datums: link.datums.map((one) => ({
					name: one.name,
					xpath: pendingPlaceholder("value"),
				})) as [FormLinkDatum, ...FormLinkDatum[]],
			};
}

/**
 * The end of step 4: each `form` workflow's links read into destinations and
 * an otherwise, each link's held-case guards taken off its stored condition,
 * and what is left registered for the expression stage with each carried
 * value. Every structure a link reads is in the drafts by now, and nothing
 * is bound.
 */
export function registerLinkExpressions(ctx: ReadContext, app: DraftApp): void {
	const forms = new Set(app.modules.flatMap((module) => module.forms));
	const readings = readingsOf(ctx).filter(
		(one) => one.word === "form" && forms.has(one.form),
	);
	if (readings.length === 0) return;
	const snapshot = provisionalDocument(ctx);
	const inputs = readProjectionInputs(ctx);
	const plan = emissionPlan(snapshot);
	const projection = formLinkProjectionContext(plan.doc, {
		expressionDoc: snapshot,
		attachmentTarget: inputs.attachmentTarget,
		lookupNaming: inputs.lookupNaming,
	});
	const datumIds = (moduleUuid: Uuid, formUuid: Uuid) =>
		entryDatumIds(
			plan.doc,
			projection,
			owningModuleOf(projection, formUuid) ?? moduleUuid,
			formUuid,
		);
	for (const reading of readings) {
		const { form } = reading;
		const cls = form.docType;
		const values = Array.isArray(form.json.peek("form_links"))
			? (form.json.peek("form_links") as unknown[])
			: [];
		const cursors = form.json.list(
			"form_links",
			"FormLink",
			AFTER_SUBMIT.links[cls],
		);
		const stored: StoredLink[] = [];
		let whole = true;
		cursors.forEach((cursor, index) => {
			const value = values.filter(isJsonObject)[index] ?? {};
			let read: StoredLink | undefined;
			try {
				read = readLinkTarget(ctx, snapshot, datumIds, reading, cursor, value);
			} catch {
				ctx.accounting.circumstance("unrecognized", form.place, {
					name: "schema:FormLink.datums",
				});
				read = undefined;
			}
			if (read === undefined) whole = false;
			else stored.push(read);
		});
		reading.whole = whole;
		if (whole) {
			readOtherwiseAndLinks(ctx, snapshot, reading, stored);
			continue;
		}
		// A link that reads to nothing has its finding; the rest are read past.
		for (const link of stored) {
			link.cursor.derived("xpath", AFTER_SUBMIT.xpath);
			for (const datum of link.datums)
				datum.cursor.derived("xpath", AFTER_SUBMIT.datumXpath);
		}
		if (form.json.used("post_form_workflow_fallback"))
			form.json.drop(
				"post_form_workflow_fallback",
				AFTER_SUBMIT.fallbackNone[cls],
			);
	}
}

/** The otherwise (9.3), then the destinations, each registered (9.4). */
function readOtherwiseAndLinks(
	ctx: ReadContext,
	snapshot: BlueprintDoc,
	reading: ReadAfterSubmit,
	stored: readonly StoredLink[],
): void {
	const { form } = reading;
	const cls = form.docType;
	const json = form.json;
	const fallback = json.peek("post_form_workflow_fallback");
	const conditional = stored.some(
		(one) => textOf(one.value.xpath).trim() !== "",
	);
	let otherwise: FormOtherwise | undefined;
	let destinations = stored;
	let otherwiseLink: StoredLink | undefined;
	if (typeof fallback === "string" && Object.hasOwn(FALLBACK_WORDS, fallback)) {
		const destination = FALLBACK_WORDS[fallback as keyof typeof FALLBACK_WORDS];
		const offered = otherwiseDestinationsOffered(snapshot, form.uuid).includes(
			destination,
		);
		if (conditional && offered) {
			json.take(
				"post_form_workflow_fallback",
				destination === "module" || destination === "previous"
					? AFTER_SUBMIT.fallbackModuleOrPrevious[cls]
					: AFTER_SUBMIT.fallbackRootOrParent[cls],
				(value) => value,
			).value;
			otherwise = { kind: "destination", destination };
		} else if (conditional) {
			json.refuse(
				"post_form_workflow_fallback",
				AFTER_SUBMIT.fallbackNotOffered[cls],
			);
			reading.whole = false;
		} else
			json.drop(
				"post_form_workflow_fallback",
				offered
					? AFTER_SUBMIT.fallbackUnconditional[cls]
					: AFTER_SUBMIT.fallbackOutside[cls],
			);
	} else {
		if (json.used("post_form_workflow_fallback"))
			json.drop("post_form_workflow_fallback", AFTER_SUBMIT.fallbackNone[cls]);
		if (lastIsOtherwise(snapshot, form.uuid, stored)) {
			otherwiseLink = stored[stored.length - 1];
			destinations = stored.slice(0, -1);
		}
	}
	// Each link's id counts the links of its target in Nova's order, then the otherwise link.
	const counts = new Map<string, number>();
	const mint = (link: StoredLink): Uuid | undefined => {
		const target = JSON.stringify(link.key);
		const n = counts.get(target) ?? 0;
		counts.set(target, n + 1);
		return ctx.accounting.identity(
			ctx.resolver.claim(
				externalKey.formLink(form.xmlns, link.key, n),
				whereText(form.place),
			),
			form.place,
			"schema:FormLink.xpath",
		);
	};
	const ordered = [...destinations].reverse();
	const reads: ReadLink[] = [];
	for (const link of ordered) {
		const uuid = mint(link);
		if (uuid === undefined) {
			reading.whole = false;
			return;
		}
		reads.push(registerLink(ctx, snapshot, form, link, uuid, "destination"));
	}
	if (otherwiseLink !== undefined) {
		const uuid = mint(otherwiseLink);
		if (uuid === undefined) {
			reading.whole = false;
			return;
		}
		reads.push(
			registerLink(ctx, snapshot, form, otherwiseLink, uuid, "otherwise"),
		);
		const last = reads[reads.length - 1] as ReadLink;
		otherwise = {
			kind: "link",
			uuid,
			target: last.target,
			...(last.datums.length === 0
				? {}
				: {
						datums: last.datums.map((one) => ({
							name: one.name,
							xpath: pendingPlaceholder("value"),
						})) as [FormLinkDatum, ...FormLinkDatum[]],
					}),
		};
	}
	reading.links = reads;
	reading.otherwise = otherwise;
	const formLinks = reads
		.filter((one) => one.role === "destination")
		.map(
			(one): FormLink => ({
				uuid: one.uuid,
				target: one.target,
				...(one.datums.length === 0
					? {}
					: {
							datums: one.datums.map((datum) => ({
								name: datum.name,
								xpath: pendingPlaceholder("value"),
							})) as [FormLinkDatum, ...FormLinkDatum[]],
						}),
			}),
		);
	ctx.writeDraft(() => {
		Object.assign(form.form, {
			...(formLinks.length === 0 ? {} : { formLinks }),
			...(otherwise === undefined ? {} : { otherwise }),
		});
	});
}

/** One link's guards taken off, its condition and carried values registered. */
function registerLink(
	ctx: ReadContext,
	snapshot: BlueprintDoc,
	form: DraftForm,
	link: StoredLink,
	uuid: Uuid,
	role: "destination" | "otherwise",
): ReadLink {
	const xpath = textOf(link.value.xpath);
	const guards = linkGuards(
		snapshot,
		form.uuid,
		asLink(link),
		xpath,
		link.datums.map((one) => one.xpath),
	);
	let condition: number | undefined;
	const left =
		role === "otherwise"
			? ""
			: strippedText(xpath, guards.guards === "written" ? guards.expected : 0);
	if (left.trim() === "") link.cursor.derived("xpath", AFTER_SUBMIT.xpath);
	else
		condition = ctx.pending.register(
			{
				ref: {
					entity: "form",
					uuid: form.uuid,
					slot: "form_link_condition",
					member: { linkUuid: uuid },
				},
				text: left,
				mode: { target: "hq-json", interpolation: "none" },
				place: form.place,
				key: "schema:FormLink.xpath",
			},
			{ json: link.cursor, key: "xpath" },
		);
	if (guards.guards === "added")
		ctx.facts.sameStateRewrites.push({
			entry: AFTER_SUBMIT.xpath.entry,
			path: `${link.cursor.pointer}/xpath`,
			register: "link-held-case-guards-added",
		});
	const datums = link.datums.map((datum) => ({
		...datum,
		index: ctx.pending.register(
			{
				ref: {
					entity: "form",
					uuid: form.uuid,
					slot: "form_link_datum_xpath",
					member: { linkUuid: uuid, datum: datum.name },
				},
				text: datum.xpath,
				mode: { target: "hq-json", interpolation: "none" },
				place: form.place,
				key: "schema:FormDatum.xpath",
			},
			{ json: datum.cursor, key: "xpath" },
		),
	}));
	return {
		cursor: link.cursor,
		uuid,
		target: link.target,
		xpath,
		datums,
		...(condition === undefined ? {} : { condition }),
		role,
	};
}

// ── Pass 2 ──────────────────────────────────────────────────────────────

/** Each bound condition and carried value written into the document's links. */
function writeBound(ctx: ReadContext, reading: ReadAfterSubmit): boolean {
	const doc = ctx.doc;
	const links = reading.links;
	if (doc === undefined || links === undefined) return false;
	let bound = true;
	const value = (index: number): Expression | undefined => {
		const expression = ctx.pending.outcome(index).expression;
		if (expression === undefined) bound = false;
		return expression;
	};
	const conditions = new Map<Uuid, Expression>();
	const datums = new Map<Uuid, Expression[]>();
	for (const link of links) {
		if (link.condition !== undefined) {
			const condition = value(link.condition);
			if (condition !== undefined) conditions.set(link.uuid, condition);
		}
		datums.set(
			link.uuid,
			link.datums.map(
				(datum) => value(datum.index) ?? pendingPlaceholder("value"),
			),
		);
	}
	if (!bound) return false;
	ctx.doc = withCandidate(doc, (draft) => {
		const form = draft.forms[reading.form.uuid];
		if (form === undefined) return;
		for (const link of form.formLinks ?? []) {
			const condition = conditions.get(link.uuid);
			if (condition !== undefined)
				link.condition = condition as typeof link.condition;
			const values = datums.get(link.uuid) ?? [];
			for (const [index, datum] of (link.datums ?? []).entries())
				datum.xpath = (values[index] ?? datum.xpath) as typeof datum.xpath;
		}
		const otherwise = form.otherwise;
		if (otherwise?.kind === "link") {
			const values = datums.get(otherwise.uuid) ?? [];
			for (const [index, datum] of (otherwise.datums ?? []).entries())
				datum.xpath = (values[index] ?? datum.xpath) as typeof datum.xpath;
		}
	});
	return true;
}

/** The document's link a read link became: a destination, or the otherwise link. */
function documentLink(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: ReadLink,
): Pick<FormLink, "target" | "datums"> | undefined {
	const form = doc.forms[formUuid];
	return (
		form?.formLinks?.find((one) => one.uuid === link.uuid) ??
		(form?.otherwise?.kind === "link" && form.otherwise.uuid === link.uuid
			? form.otherwise
			: undefined)
	);
}

/** The guards of a read link, decided again over the document with its stored `xpath` (9.4):
 *  its target and carried selections are the ones step 4 wrote, so this agrees with the mark
 *  `registerLinkExpressions` read over the provisional document. */
function guardsOf(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: ReadLink,
): ReturnType<typeof linkGuards> | undefined {
	const domain = documentLink(doc, formUuid, link);
	return domain === undefined
		? undefined
		: linkGuards(
				doc,
				formUuid,
				domain,
				link.xpath,
				link.datums.map((one) => one.xpath),
			);
}

/** The stored `xpath` of a link as Nova's emission writes it, the guards it adds included, as
 *  a list of conjuncts; undefined where a text does not parse. */
function adjustedConjuncts(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: ReadLink,
): FormSyntax[] | undefined {
	const parsed =
		link.xpath.trim() === "" ? undefined : syntaxOf(link.xpath, undefined);
	if (parsed !== undefined && !parsed.ok) return undefined;
	const parts = parsed === undefined ? [] : conjuncts(parsed.syntax);
	const domain = documentLink(doc, formUuid, link);
	if (domain === undefined) return undefined;
	const marked = guardsOf(doc, formUuid, link);
	if (marked?.guards !== "added") return parts;
	const guards = expectedGuards(
		doc,
		formUuid,
		domain,
		link.datums.map((one) => one.xpath),
	);
	return guards === undefined ? undefined : [...parts, ...guards];
}

/** Two conjunct lists the same, conjunct for conjunct. */
function sameConjuncts(
	a: readonly FormSyntax[],
	b: readonly FormSyntax[],
): boolean {
	return (
		a.length === b.length &&
		a.every((one, index) => sameSyntax(one, b[index] as FormSyntax))
	);
}

/** Pass 2, from `settleMenus`, before its one expansion: the workflow word judged and written
 *  where it is not the form's default, or the links' bound conditions and carried values
 *  written into the document. */
export function settleAfterSubmit(ctx: ReadContext, form: DraftForm): void {
	const reading = readingsOf(ctx).find((one) => one.form === form);
	const doc = ctx.doc;
	if (
		reading === undefined ||
		doc === undefined ||
		doc.forms[form.uuid] === undefined
	)
		return;
	if (reading.word === undefined) return;
	if (reading.word !== "form") {
		settleWord(ctx, reading, reading.word);
		return;
	}
	if (reading.whole !== true || reading.links === undefined) return;
	reading.bound = writeBound(ctx, reading);
	if (reading.bound && leavesTargetCaseEmpty(ctx, form)) {
		ctx.accounting.finding(
			AFTER_SUBMIT.datumsIncomplete[form.docType],
			form.place,
		);
		reading.bound = false;
		// No later reader takes a link Nova refused.
		const current = ctx.doc as BlueprintDoc;
		ctx.doc = withCandidate(current, (draft) => {
			const target = draft.forms[form.uuid];
			if (target === undefined) return;
			delete target.formLinks;
			delete target.otherwise;
		});
	}
}

/** Whether the gate's `FORM_LINK_DATUMS_INCOMPLETE` holds of the form's links over the
 *  document: a destination whose case the link's carried values, or automatic matching, leave
 *  empty. */
function leavesTargetCaseEmpty(ctx: ReadContext, form: DraftForm): boolean {
	const doc = ctx.doc;
	if (doc === undefined) return false;
	const moduleUuid = doc.moduleOrder.find((uuid) =>
		(doc.formOrder[uuid] ?? []).includes(form.uuid),
	);
	if (moduleUuid === undefined) return false;
	try {
		return runFormRules(doc, form.uuid, moduleUuid, entryPlanContext(doc)).some(
			(error) => error.code === "FORM_LINK_DATUMS_INCOMPLETE",
		);
	} catch {
		// A form the rules cannot project is the expansion's to report.
		return false;
	}
}

/** Pass 2, over `settleMenus`' one expansion: the form's `post_form_workflow`,
 *  `post_form_workflow_fallback` and `form_links` as Nova's emission writes them, against the
 *  stored ones, after the guards Nova adds. `emitted` is the expansion's form. */
export function acceptAfterSubmit(
	ctx: ReadContext,
	form: DraftForm,
	emitted: Readonly<Record<string, unknown>> | undefined,
): void {
	const reading = readingsOf(ctx).find((one) => one.form === form);
	const doc = ctx.doc;
	if (
		reading?.word === undefined ||
		doc === undefined ||
		doc.forms[form.uuid] === undefined ||
		ctx.accounting.hasFindingAt(form.place)
	)
		return;
	if (reading.word !== "form") {
		// (R1): the word Nova writes for the destination read is the stored word.
		if (emitted?.post_form_workflow !== reading.word)
			ctx.accounting.circumstance("unrecognized", form.place, {
				name: `schema:${form.docType}.post_form_workflow`,
			});
		return;
	}
	if (reading.bound !== true) return;
	const own = doc.forms[form.uuid];
	const entries = [
		...(own?.formLinks ?? []),
		...(own?.otherwise?.kind === "link" ? [own.otherwise] : []),
	];
	if (!formLinkActionsBuildable(doc, form.uuid, entries)) {
		ctx.accounting.circumstance("unrecognized", form.place, {
			name: "formLinkActionsBuildable",
		});
		return;
	}
	if (emitted === undefined) {
		ctx.accounting.circumstance("unrecognized", form.place, {
			name: "schema:Form.form_links",
		});
		return;
	}
	compareLinks(ctx, doc, reading, emitted);
}

/** A word other than `form`: offered there, and stored only where it is not the default. */
function settleWord(
	ctx: ReadContext,
	reading: ReadAfterSubmit,
	word: Word,
): void {
	const doc = ctx.doc as BlueprintDoc;
	const { form } = reading;
	const destination = WORDS[word];
	const facts = postSubmitModuleFacts(doc, reading.module.uuid);
	if (word === "previous_screen" && facts?.formsOnFirstMenu === true) {
		ctx.accounting.finding(AFTER_SUBMIT.previousOnFirstMenu, form.place);
		return;
	}
	if (!postSubmitDestinationsOffered(doc, form.uuid).includes(destination)) {
		ctx.accounting.finding(AFTER_SUBMIT.notOfferedFinding, form.place, {
			name: HQ_PAGE_LABELS.workflow[word],
		});
		return;
	}
	if (destination === defaultPostSubmitOf(doc, form.uuid)) return;
	ctx.doc = withCandidate(doc, (draft) => {
		const target = draft.forms[form.uuid];
		if (target !== undefined) target.postSubmit = destination;
	});
}

/** The stored links against the expansion's, in stored order. */
function compareLinks(
	ctx: ReadContext,
	doc: BlueprintDoc,
	reading: ReadAfterSubmit,
	emitted: Readonly<Record<string, unknown>>,
): void {
	const { form } = reading;
	const links = reading.links as readonly ReadLink[];
	const differs = (name: string) =>
		ctx.accounting.circumstance("unrecognized", form.place, { name });
	if (emitted.post_form_workflow !== "form") {
		differs("schema:Form.post_form_workflow");
		return;
	}
	const storedFallback = form.json.peek("post_form_workflow_fallback");
	const ourFallback = emitted.post_form_workflow_fallback ?? null;
	if (
		reading.otherwise?.kind === "destination"
			? storedFallback !== ourFallback
			: ourFallback !== null
	) {
		differs("schema:Form.post_form_workflow_fallback");
		return;
	}
	const ours = Array.isArray(emitted.form_links)
		? emitted.form_links.filter(isJsonObject)
		: [];
	// Stored order is Nova's emitted order: destinations reversed, then the otherwise link.
	const destinations = links
		.filter((one) => one.role === "destination")
		.reverse();
	const otherwise = links.find((one) => one.role === "otherwise");
	const order = [
		...destinations,
		...(otherwise === undefined ? [] : [otherwise]),
	];
	if (ours.length !== order.length) {
		differs("schema:Form.form_links");
		return;
	}
	const adjusted = new Map<ReadLink, FormSyntax[]>();
	for (const link of order) {
		const parts = adjustedConjuncts(doc, form.uuid, link);
		if (parts === undefined) {
			differs("schema:FormLink.xpath");
			return;
		}
		adjusted.set(link, parts);
	}
	for (const [index, link] of order.entries()) {
		const our = ours[index] as JsonObject;
		const stored = link.cursor;
		for (const key of [
			"form_id",
			"form_module_id",
			"module_unique_id",
		] as const) {
			const a = stored.peek(key);
			const b = our[key];
			const blank = (value: unknown) =>
				value === null || value === undefined || value === "";
			if (!(a === b || (blank(a) && blank(b)))) {
				differs(`schema:FormLink.${key}`);
				return;
			}
		}
		let expected = adjusted.get(link) as FormSyntax[];
		if (link.role === "otherwise") {
			// The otherwise link negates every destination's adjusted condition, then its own guards.
			const count = guardsOf(doc, form.uuid, link)?.expected ?? 0;
			const ownGuards =
				count === 0 ? [] : expected.slice(expected.length - count);
			const negations = destinations
				.map((one) => conjunction(adjusted.get(one) as FormSyntax[]))
				.filter((one): one is FormSyntax => one !== undefined)
				.map(
					(one): FormSyntax => ({
						kind: "call",
						name: "not",
						args: [one],
						from: 0,
						to: 0,
					}),
				);
			expected = [...negations, ...ownGuards];
		}
		const ourText = typeof our.xpath === "string" ? our.xpath : "";
		const ourParsed =
			ourText.trim() === "" ? undefined : syntaxOf(ourText, undefined);
		if (ourParsed !== undefined && !ourParsed.ok) {
			differs("schema:FormLink.xpath");
			return;
		}
		if (
			!sameConjuncts(
				expected,
				ourParsed === undefined ? [] : conjuncts(ourParsed.syntax),
			)
		) {
			differs("schema:FormLink.xpath");
			return;
		}
		const ourDatums = Array.isArray(our.datums)
			? our.datums.filter(isJsonObject)
			: [];
		if (ourDatums.length !== link.datums.length) {
			differs("schema:FormLink.datums");
			return;
		}
		for (const [at, datum] of link.datums.entries()) {
			const theirs = ourDatums[at] as JsonObject;
			const storedName = textOf(
				(Array.isArray(stored.peek("datums"))
					? (stored.peek("datums") as unknown[])
					: []
				).filter(isJsonObject)[at]?.name,
			);
			if (theirs.name !== storedName) {
				differs("schema:FormDatum.name");
				return;
			}
			const a = syntaxOf(datum.xpath, undefined);
			const b = syntaxOf(textOf(theirs.xpath), undefined);
			if (!a.ok || !b.ok || !sameSyntax(a.syntax, b.syntax)) {
				differs("schema:FormDatum.xpath");
				return;
			}
		}
	}
}

/**
 * The reader's canonical choice `default-post-submit-is-absent`: a form with
 * no destinations whose stored after-submit is its own default stores none.
 * Both print one workflow word; the reader returns this one.
 */
export function defaultPostSubmitAbsent(doc: BlueprintDoc): BlueprintDoc {
	const forms = { ...doc.forms };
	let changed = false;
	for (const [uuid, form] of Object.entries(doc.forms)) {
		if (form.formLinks !== undefined || form.postSubmit === undefined) continue;
		if (form.postSubmit !== defaultPostSubmitOf(doc, uuid as Uuid)) continue;
		const { postSubmit: _, ...rest } = form;
		forms[uuid] = rest;
		changed = true;
	}
	return changed ? { ...doc, forms } : doc;
}
