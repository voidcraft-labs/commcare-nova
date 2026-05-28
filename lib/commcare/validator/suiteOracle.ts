/**
 * Post-emit suite.xml ORACLE.
 *
 * Mirrors the contract CommCare's device runtime enforces over `suite.xml` —
 * the navigation / detail / entry manifest the mobile + web runtimes parse and
 * then resolve against at session time. Any state Nova's compiler can reach
 * must pass this oracle: a failing suite here is a generator bug, never an
 * authoring error a user could fix. Co-developed with a property fuzzer
 * (`__tests__/suiteOracle.fuzz.test.ts`) that compiles schema-valid
 * `BlueprintDoc`s and asserts the oracle returns clean — that fuzzer is what
 * proves the suite emitter total and also defines the oracle's faithfulness: a
 * check that flags legitimately-emitted output is the ORACLE being wrong, never
 * a new reject rule.
 *
 * ## Two failure categories
 *
 * The device handles a malformed suite in two very different ways, and the
 * oracle owns both:
 *
 *   - **Category 1 — fatal at parse.** `SuiteParser` and its sub-parsers throw
 *     `InvalidStructureException` (or a raw `RuntimeException`) while reading
 *     the suite, so the device rejects the whole app at load. Missing required
 *     attributes, bad enum values, and non-path datum values / nodesets land
 *     here.
 *
 *   - **Category 2 — parse-clean, runtime-fatal.** This is the dangerous gap.
 *     `SuiteParser::parse` builds `details` / `entries` / `endpoints` as plain
 *     `Hashtable`s, and `Suite::getDetail` / `getEntry` / `getEndpoint` are
 *     bare `get(id)` calls that return `null` on a miss with NO validation. So
 *     a dangling cross-reference (a `<menu>` command naming no `<entry>`, a
 *     `<datum detail-select>` naming no `<detail>`, an `instance('foo')`
 *     reference with no `<instance id="foo">`) parses cleanly and only
 *     detonates LATER, at session runtime — at menu open
 *     (`CommCareSession.java::getStillValidEntriesFromMenu` →
 *     `RuntimeException("No entry found for menu command [...]")`), at title
 *     render (`FormDataUtil.java::getMenuTitleString` NPE), or at XPath
 *     evaluation (`EvaluationContext.java::resolveReference` →
 *     `XPathMissingInstanceException`). The device load gate will NEVER catch
 *     these, so Nova must guarantee them itself. This is the heart of the
 *     oracle.
 *
 * ## Sort — silently tolerated
 *
 * `DetailFieldParser::parseSort` is deliberately permissive: a bad `@order` /
 * `@direction` / `@type` / `@blanks` is swallowed (the comment in Core spells
 * out the "be flexible for now" intent) and the sort silently falls back to a
 * default rather than throwing. The runtime then *behaves wrong* — sorts the
 * wrong way, or not at all — and never surfaces a diagnostic. Nothing in the
 * device will ever flag these, so the oracle must: bad sort attributes are
 * generator bugs the fuzzer is meant to catch.
 *
 * ## Two XPath surfaces
 *
 * Classified with the same shared Lezer-backed gate the XForm oracle uses
 * (`xform/pathExpression.ts`):
 *   - PATH-only — session `<datum nodeset>` and (when present) its `value`,
 *     `<data nodeset>`, and `<data ref>` WHEN the same `<data>` also carries a
 *     `nodeset` (Core's `ListQueryData` branch routes ref through
 *     `getPathExpr`). Core routes these through `XPathReference.getPathExpr`,
 *     which throws on a non-path. `isPathExpression` mirrors that.
 *   - ANY-expression — every other XPath surface (`<xpath function>` in detail
 *     templates / headers / sort text, `<data ref>` WITHOUT a nodeset, `<data
 *     exclude>`, stack-frame `<datum value>`, `<post relevant>`, stack-op `if`
 *     conditions, prompt defaults). Core only requires these parse as XPath.
 *     `isParseableXPath` mirrors that.
 *
 * ## Runtime-provided instances + locales
 *
 * Some `instance('...')` ids and some `<locale id>` references resolve from the
 * runtime itself, not from a `<instance>` declaration or an `app_strings.txt`
 * entry. Referencing one of those is NOT a finding. The runtime-provided sets
 * (`RUNTIME_INSTANCE_IDS`, `RUNTIME_LOCALE_IDS`) are the safety net — most of
 * Nova's emitters DO declare their instances explicitly; the allowlist exists
 * so a legitimately runtime-resolved reference is never flagged.
 */

import type { Document, Element } from "domhandler";
import { findAll, getAttributeValue, getChildren, isTag } from "domutils";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { collectInstanceRefs } from "@/lib/commcare/xform/instanceRefs";
import {
	isParseableXPath,
	isPathExpression,
} from "@/lib/commcare/xform/pathExpression";
import {
	type ValidationError,
	type ValidationLocation,
	validationError,
} from "./errors";

const XML_OPTS = { xmlMode: true } as const;

/**
 * Secondary-instance ids the runtime resolves WITHOUT requiring a `<instance>`
 * declaration on the enclosing element. A wire XPath referencing one of these
 * is in scope whether or not the element declares it, so the C2-4 check treats
 * them as always-resolvable. The set is the closed vocabulary Nova's emitters
 * actually produce — verified by `rg "instance\\('...'\\)"` over `lib/commcare`
 * (non-test): `casedb`, `commcaresession`, `results`, `results:inline`,
 * `search-input:results`. Nothing else.
 *
 *   - `casedb` / `commcaresession` — platform-seeded into every session's
 *     `formInstances` by Core (`commcare-core .../session/CommCareSession.java::
 *     addInstancesFromFrame` feeds the per-frame instance scope
 *     `EvaluationContext.resolveReference` reads). They resolve even when no
 *     `<instance>` declares them. Nova declares them on entries ANYWAY to stay
 *     byte-compatible with the suite CCHQ regenerates from an HQ upload
 *     (`commcare-hq/.../suite_xml/post_process/instances.py::
 *     InstancesHelper.add_entry_instances`); both the declared form and the
 *     ambient form resolve, so they belong in this set regardless.
 *   - `results` / `results:inline` — the remote-search result rosters the
 *     `<remote-request>` runtime materializes.
 *   - `search-input:results` — the in-flight search input values CCHQ exposes
 *     during `<remote-request>` evaluation.
 *
 * `session` and `registry` are intentionally absent: Nova never emits a ref to
 * either (Core's canonical session id is `commcaresession`; registry queries
 * are a CCHQ feature Nova doesn't model). An over-broad allowlist is latent
 * under-strictness — adding an id here that the emitter never produces would
 * silently waive the C2-4 check for a shape that, if it ever appeared, would be
 * a real bug.
 */
const RUNTIME_INSTANCE_IDS: ReadonlySet<string> = new Set([
	"casedb",
	"commcaresession",
	"results",
	"results:inline",
	"search-input:results",
]);

/**
 * Locale ids the runtime resolves from a built-in default rather than from
 * `app_strings.txt`. Nova's detail emitters reference `cchq.case` as the
 * case-detail `<title>` without registering it — CommCare HQ ships it with a
 * `default="Case"` fallback (`commcare-hq/.../app_manager/id_strings.py::
 * _case_detail_title_locale`), so an unregistered `cchq.case` reference renders
 * "Case" rather than throwing. Any other built-in the emitter references
 * without registering goes here.
 */
const RUNTIME_LOCALE_IDS: ReadonlySet<string> = new Set(["cchq.case"]);

/** Stack-operation tags Core's `StackOpParser` accepts. */
const VALID_STACK_OPS: ReadonlySet<string> = new Set([
	"create",
	"push",
	"clear",
]);

/** `<sort direction>` enum per `DetailFieldParser::parseSort`. */
const VALID_SORT_DIRECTIONS: ReadonlySet<string> = new Set([
	"ascending",
	"descending",
]);

/** `<sort type>` enum per `DetailFieldParser::parseSort`. */
const VALID_SORT_TYPES: ReadonlySet<string> = new Set([
	"int",
	"double",
	"string",
]);

/** `<sort blanks>` enum per `DetailFieldParser::parseBlanksPreference`. */
const VALID_SORT_BLANKS: ReadonlySet<string> = new Set(["first", "last"]);

// ── Shared structural model ────────────────────────────────────────

/**
 * An entry-like top-level element (`<entry>` or `<remote-request>`) plus the
 * instance ids declared directly on it. CommCare resolves an `instance('foo')`
 * reference appearing inside the element against the element's own `<instance>`
 * declarations (or the runtime-provided set), so instance scope is per-entry,
 * not global.
 */
interface EntryScope {
	/** The `<entry>` / `<remote-request>` element. */
	readonly element: Element;
	/** Instance ids declared on this element via `<instance id="...">`. */
	readonly declaredInstances: ReadonlySet<string>;
}

/**
 * The model every invariant reads off, built once per suite by a single DOM
 * walk so the oracle never re-traverses the tree per check.
 */
interface SuiteModel {
	/** Parsed document (well-formedness already proven by the strict gate). */
	readonly doc: Document;
	/** The `<suite>` root element. */
	readonly suite: Element;
	/** Every `<detail id>` value present in the suite. */
	readonly detailIds: ReadonlySet<string>;
	/**
	 * Every command id an `<entry>` / `<remote-request>` / `<view>` defines —
	 * the resolution target for a `<menu>` command reference (C2-1).
	 */
	readonly commandIds: ReadonlySet<string>;
	/** The entry-like scopes, each with its declared instance set (C2-4). */
	readonly entryScopes: readonly EntryScope[];
	/**
	 * For each `<detail id>`, the entry scopes that load it (via a `<datum
	 * detail-select>` / `detail-confirm>` naming the id). A detail's
	 * `instance(...)` refs resolve against the SPECIFIC entry that loads it, so
	 * the C2-4 detail check intersects every referrer's declared instances —
	 * a ref must resolve in EVERY scope the detail is reachable from. A detail
	 * with no referrers is absent from this map (its refs resolve against
	 * nothing, so it's skipped rather than checked against the empty
	 * intersection).
	 */
	readonly detailReferrers: ReadonlyMap<string, readonly EntryScope[]>;
}

/**
 * Collect the instance ids declared on an entry-like element. Mirrors Core's
 * per-entry instance resolution: an `instance('foo')` inside the element
 * resolves against THESE declarations (union the runtime-provided set), not a
 * global table.
 */
function collectDeclaredInstances(entry: Element): Set<string> {
	const ids = new Set<string>();
	for (const inst of getChildren(entry)) {
		if (!isTag(inst) || inst.name !== "instance") continue;
		const id = getAttributeValue(inst, "id");
		if (id) ids.add(id);
	}
	return ids;
}

// ── Path / locale / instance helpers ───────────────────────────────

/**
 * Locale ids referenced by `<locale id="...">` elements anywhere under `root`.
 * Used by the C2-6 locale-resolution check against the emitted app_strings set.
 */
function collectLocaleRefs(root: Element | Document): string[] {
	const ids: string[] = [];
	for (const el of findAll((e) => e.name === "locale", root.children)) {
		const id = getAttributeValue(el, "id");
		if (id) ids.push(id);
	}
	return ids;
}

/**
 * The XPath strings carried by `<xpath function="...">` elements anywhere under
 * `root`. These are the detail-template / header / sort display expressions —
 * all ANY-expression surfaces whose validity + instance refs the oracle checks.
 */
function collectXPathFunctions(root: Element | Document): string[] {
	const out: string[] = [];
	for (const el of findAll((e) => e.name === "xpath", root.children)) {
		const fn = getAttributeValue(el, "function");
		if (fn !== undefined) out.push(fn);
	}
	return out;
}

// ── Category 1 — datum value/nodeset (C1-1/C1-2/C2-8) ──────────────

/**
 * Whether a `<datum>`'s nearest meaningful ancestor is a stack frame
 * (`<create>` / `<push>`) rather than a `<session>`. The two contexts route
 * through different Core parsers with different contracts, so the datum check
 * must discriminate them by walking the parent chain. A datum directly under
 * `<session>` is a session datum (`SessionDatumParser`); one under a stack op
 * is a stack-frame step (`StackFrameStepParser`).
 */
function isStackFrameDatum(datum: Element): boolean {
	for (let p = datum.parent; p !== null; p = p.parent) {
		if (!isTag(p)) continue;
		if (p.name === "create" || p.name === "push") return true;
		if (p.name === "session" || p.name === "entry") return false;
	}
	return false;
}

/**
 * `<datum>` value + nodeset checks, faithful to the two Core parsers that read
 * a `<datum>` and their distinct contracts.
 *
 * SESSION datums (`commcare-core .../xml/SessionDatumParser.java::parse`):
 *   - With `@function` present → `ComputedDatum`: carries neither `nodeset` nor
 *     `value`; nothing is required.
 *   - Otherwise → `EntityDatum`: `nodeset` is REQUIRED — the parser throws
 *     `InvalidStructureException("Expected @nodeset…")` when absent — and routes
 *     through `XPathReference.getPathExpr` (PATH). `value` is NOT required
 *     (read with `getAttributeValue`, may be null); when present it must be a
 *     PATH (lazily through `getPathExpr` at `EntityDatum::getEntityFromID`,
 *     C2-8). The earlier version of this check had the requirement INVERTED
 *     (required `value`, treated `nodeset` as optional).
 *
 * STACK-FRAME datums (`commcare-core .../xml/StackFrameStepParser.java::
 * parseValue`): `value` is REQUIRED (the `@value` attribute or direct child
 * text) and parsed as ANY XPath through `XPathParseTool` — NOT a PATH. No
 * nodeset. (Child-text values are out of the oracle's scope; Nova only emits
 * the `@value` attribute form.)
 */
function checkDatums(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const datum of findAll(
		(el) => el.name === "datum",
		model.doc.children,
	)) {
		const datumId = getAttributeValue(datum, "id") ?? "(unnamed)";
		const value = getAttributeValue(datum, "value");
		const nodeset = getAttributeValue(datum, "nodeset");

		if (isStackFrameDatum(datum)) {
			// Stack-frame datum: `value` required, ANY-XPath. No nodeset contract.
			if (value === undefined) {
				errors.push(
					validationError(
						"SUITE_DATUM_NO_VALUE",
						"app",
						`The suite has a stack-frame <datum id="${datumId}"> with no value attribute. CommCare requires a stack datum to carry the expression that computes its value. This is a bug in the suite generator.`,
						loc,
					),
				);
			} else if (value !== "" && !isParseableXPath(value)) {
				errors.push(
					validationError(
						"SUITE_DATUM_NON_PATH_VALUE",
						"app",
						`The suite has a stack-frame <datum id="${datumId}" value="${value}"> whose value doesn't parse as valid XPath. CommCare evaluates a stack datum's value and rejects the suite when it can't parse it. Look at how this stack datum's value was built. This is a bug in the suite generator.`,
						loc,
					),
				);
			}
			continue;
		}

		// Session datum. A `<datum function=…>` (ComputedDatum) requires nothing;
		// the entity-datum contract below only applies when `function` is absent.
		const isComputed = getAttributeValue(datum, "function") !== undefined;
		if (isComputed) continue;

		// Entity datum: `nodeset` REQUIRED + PATH.
		if (nodeset === undefined) {
			errors.push(
				validationError(
					"SUITE_DATUM_NO_NODESET",
					"app",
					`The suite has a session <datum id="${datumId}"> with no nodeset attribute. CommCare requires an entity datum to declare the case set it selects from, and rejects the suite at parse when it's absent. This is a bug in the suite generator.`,
					loc,
				),
			);
		} else if (nodeset !== "" && !isPathExpression(nodeset)) {
			errors.push(
				validationError(
					"SUITE_DATUM_NON_PATH_NODESET",
					"app",
					`The suite has a session <datum id="${datumId}" nodeset="${nodeset}"> whose nodeset isn't a location path. CommCare parses a datum nodeset as a node reference and rejects anything that isn't a path. Look at how this datum's nodeset was built. This is a bug in the suite generator.`,
					loc,
				),
			);
		}

		// Entity datum: `value` OPTIONAL, but a PATH when present (C2-8).
		if (value !== undefined && value !== "" && !isPathExpression(value)) {
			errors.push(
				validationError(
					"SUITE_DATUM_NON_PATH_VALUE",
					"app",
					`The suite has a session <datum id="${datumId}" value="${value}"> whose value isn't a location path. CommCare parses an entity datum's value as a node reference and rejects anything that isn't a path. Look at how this datum's value was built. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

// ── Category 1 — detail structure (C1-8/9/10) ──────────────────────

/**
 * `<detail>` structural checks (C1-8 / C1-9 / C1-10). Core's `DetailParser`
 * requires a `<title>` opener; `DetailFieldParser` requires every `<field>` to
 * carry a `<header>` and a `<template>`. A detail missing any of these throws
 * `InvalidStructureException` at parse — the device rejects the whole suite.
 *
 * Nested details (a `<detail>` whose children are `<detail>` blocks rather than
 * `<field>`s — the tabbed long-detail shape) carry their fields one level
 * deeper; Nova doesn't emit nested details today, so this checks the direct
 * `<field>` children of every `<detail>`.
 */
function checkDetails(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const detail of findAll(
		(el) => el.name === "detail",
		model.doc.children,
	)) {
		const detailId = getAttributeValue(detail, "id") ?? "(unnamed)";
		const children = getChildren(detail).filter((c): c is Element => isTag(c));

		// C1-8: a detail must open with a `<title>` (DetailParser requires it
		// before any field). A `<detail>` that nests sub-`<detail>` blocks
		// (tabbed long detail) carries its own title too.
		const hasTitle = children.some((c) => c.name === "title");
		if (!hasTitle) {
			errors.push(
				validationError(
					"SUITE_DETAIL_NO_TITLE",
					"app",
					`The suite has a <detail id="${detailId}"> with no <title>. CommCare requires every detail to open with a title element. This is a bug in the suite generator.`,
					loc,
				),
			);
		}

		// C1-9 / C1-10: every `<field>` carries a `<header>` AND a `<template>`.
		for (const field of children.filter((c) => c.name === "field")) {
			const fieldChildren = getChildren(field).filter((c): c is Element =>
				isTag(c),
			);
			if (!fieldChildren.some((c) => c.name === "header")) {
				errors.push(
					validationError(
						"SUITE_FIELD_NO_HEADER",
						"app",
						`The suite has a <field> in <detail id="${detailId}"> with no <header>. CommCare requires every detail field to declare a header. This is a bug in the suite generator.`,
						loc,
					),
				);
			}
			if (!fieldChildren.some((c) => c.name === "template")) {
				errors.push(
					validationError(
						"SUITE_FIELD_NO_TEMPLATE",
						"app",
						`The suite has a <field> in <detail id="${detailId}"> with no <template>. CommCare requires every detail field to declare a template. This is a bug in the suite generator.`,
						loc,
					),
				);
			}
		}
	}

	return errors;
}

// ── Category 1 — entry / remote-request / query / post (C1-3..7/16) ─

/**
 * `<entry>` / `<remote-request>` structural checks.
 *
 *   - C1-7: every `<entry>` defines display text (a `<command>` with a
 *     `<text>` / `<display>`, or a bare `<text>`). Core's `EntryParser`
 *     requires the entry name up front.
 *   - C1-6: a `<remote-request>` must contain a `<post>` (raw RuntimeException
 *     otherwise).
 *   - C1-5 / C1-16: `<post>` requires a `url`; its optional `relevant` must be
 *     valid XPath.
 *   - C1-3 / C1-4: a `<query>` requires `url` + `storage-instance`.
 */
function checkEntries(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// C1-7: every `<entry>` carries display text. Core builds the entry's
	// command text from a `<command><text>` / `<display>` or a direct `<text>`;
	// an entry with neither has no name to render in the menu.
	for (const entry of findAll(
		(el) => el.name === "entry",
		model.doc.children,
	)) {
		if (!entryHasDisplayText(entry)) {
			errors.push(
				validationError(
					"SUITE_ENTRY_NO_DISPLAY",
					"app",
					`The suite has an <entry> with no display text — no <command> text and no <text>. CommCare needs every entry to declare what to show in the menu. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	// C1-6 + post checks: a `<remote-request>` must contain a `<post>`.
	for (const rr of findAll(
		(el) => el.name === "remote-request",
		model.doc.children,
	)) {
		const posts = getChildren(rr).filter(
			(c): c is Element => isTag(c) && c.name === "post",
		);
		if (posts.length === 0) {
			errors.push(
				validationError(
					"SUITE_REMOTE_REQUEST_NO_POST",
					"app",
					`The suite has a <remote-request> with no <post>. CommCare requires a remote-request to declare the post that claims the selected case. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
		for (const post of posts) {
			// C1-5: `<post>` requires a url.
			if (getAttributeValue(post, "url") === undefined) {
				errors.push(
					validationError(
						"SUITE_POST_NO_URL",
						"app",
						`The suite has a <post> with no url attribute. CommCare needs the post to name the endpoint it submits to. This is a bug in the suite generator.`,
						loc,
					),
				);
			}
			// C1-16: `<post relevant>`, when present, must be valid XPath.
			const relevant = getAttributeValue(post, "relevant");
			if (
				relevant !== undefined &&
				relevant !== "" &&
				!isParseableXPath(relevant)
			) {
				errors.push(
					validationError(
						"SUITE_INVALID_XPATH",
						"app",
						`The suite has a <post relevant="${relevant}"> whose expression doesn't parse as valid XPath. CommCare evaluates the post's relevant condition and rejects the suite when it can't parse it. Look at how this claim guard was built. This is a bug in the suite generator.`,
						loc,
					),
				);
			}
		}
	}

	// C1-3 / C1-4: every `<query>` requires url + storage-instance.
	for (const query of findAll(
		(el) => el.name === "query",
		model.doc.children,
	)) {
		if (getAttributeValue(query, "url") === undefined) {
			errors.push(
				validationError(
					"SUITE_QUERY_NO_URL",
					"app",
					`The suite has a <query> with no url attribute. CommCare needs the query to name the search endpoint it calls. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
		if (getAttributeValue(query, "storage-instance") === undefined) {
			errors.push(
				validationError(
					"SUITE_QUERY_NO_STORAGE_INSTANCE",
					"app",
					`The suite has a <query> with no storage-instance attribute. CommCare needs the query to name the instance its results land in. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

/**
 * Whether an `<entry>` declares display text. Core accepts either a
 * `<command>` carrying a `<text>` / `<display>` child, or a direct `<text>` on
 * the entry. A `<command>` with no text and no display fails the entry-name
 * requirement.
 */
function entryHasDisplayText(entry: Element): boolean {
	for (const child of getChildren(entry)) {
		if (!isTag(child)) continue;
		if (child.name === "text") return true;
		if (child.name === "command") {
			const cmdChildren = getChildren(child).filter((c): c is Element =>
				isTag(c),
			);
			if (cmdChildren.some((c) => c.name === "text" || c.name === "display")) {
				return true;
			}
		}
	}
	return false;
}

// ── Category 1 — prompts (C1-17) ───────────────────────────────────

/**
 * `<prompt>` checks (C1-17): every prompt carries a `key`, and keys are unique
 * within their `<query>`. Core's `QueryPromptParser` keys the prompt table on
 * `@key`; a missing key has nothing to bind, and a duplicate key silently
 * last-writer-wins.
 *
 * `<prompt default>` validity is covered by the generic ANY-XPath sweep
 * (`checkXPathSurfaces`) — `@default` is one of the attributes collected there.
 */
function checkPrompts(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const query of findAll(
		(el) => el.name === "query",
		model.doc.children,
	)) {
		const seenKeys = new Set<string>();
		for (const prompt of findAll(
			(el) => el.name === "prompt",
			query.children,
		)) {
			const key = getAttributeValue(prompt, "key");
			if (key === undefined) {
				errors.push(
					validationError(
						"SUITE_PROMPT_NO_KEY",
						"app",
						`The suite has a <prompt> with no key attribute. CommCare binds each search prompt's typed value by its key, so a key-less prompt can't be reached. This is a bug in the suite generator.`,
						loc,
					),
				);
				continue;
			}
			if (seenKeys.has(key)) {
				errors.push(
					validationError(
						"SUITE_PROMPT_DUPLICATE_KEY",
						"app",
						`The suite declares two <prompt> elements with key "${key}" in one <query>. CommCare keeps only the last one. This is a bug in the suite generator.`,
						loc,
					),
				);
			} else {
				seenKeys.add(key);
			}
		}
	}

	return errors;
}

// ── Category 1 — stack ops (C1-19) ─────────────────────────────────

/**
 * Stack-operation tag check (C1-19). A `<stack>` may contain only `<create>` /
 * `<push>` / `<clear>`; Core's `StackOpParser` rejects any other tag. The `if`
 * conditional on a stack op is an ANY-XPath surface covered by
 * `checkXPathSurfaces` (it sweeps `if` along with the other expression attrs).
 */
function checkStacks(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const stack of findAll(
		(el) => el.name === "stack",
		model.doc.children,
	)) {
		for (const op of getChildren(stack)) {
			if (!isTag(op)) continue;
			if (!VALID_STACK_OPS.has(op.name)) {
				errors.push(
					validationError(
						"SUITE_STACK_BAD_OP",
						"app",
						`The suite has a <${op.name}> inside a <stack>, but CommCare only accepts create / push / clear there. Look at how this stack frame was built. This is a bug in the suite generator.`,
						loc,
					),
				);
			}
		}
	}

	return errors;
}

// ── Category 1 — suite version (C1-26) ─────────────────────────────

/**
 * `<suite version>` integer check (C1-26). Core parses the version as an
 * integer; a non-integer value fails the parse.
 */
function checkSuiteVersion(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const version = getAttributeValue(model.suite, "version");
	// An absent version defaults cleanly in Core; only a present non-integer is
	// a parse failure.
	if (version === undefined) return [];
	if (!/^-?\d+$/.test(version)) {
		return [
			validationError(
				"SUITE_VERSION_NOT_INTEGER",
				"app",
				`The suite declares version="${version}", but CommCare parses the suite version as an integer. This is a bug in the suite generator.`,
				loc,
			),
		];
	}
	return [];
}

// ── Category 1 — XPath validity sweep (C1-11/12/24, prompt/if/data) ─

/**
 * Sweep every ANY-expression XPath surface in the suite and assert each parses
 * as valid XPath. Covers:
 *   - `<xpath function="...">` — detail templates / headers / sort text
 *     (C1-24).
 *   - `<prompt default="...">` (C1-18).
 *   - stack-op `if="..."` conditionals (C1-22).
 *   - `@relevant` on detail fields / `<action>` (C1-12).
 *
 * `<data>`'s `ref` / `nodeset` / `exclude` are NOT swept here — they live in
 * `checkQueryData`, which mirrors `QueryDataParser`'s context-dependent
 * contract (ref required; ref + nodeset both PATH when nodeset is present;
 * exclude parseable).
 *
 * Unparseable XPath is a Core parse failure (`XPathParseTool`). This sweep does
 * NOT classify path-vs-any — it only proves parseability, which every one of
 * these surfaces requires. The path-only surfaces (`<datum value/nodeset>`,
 * `<data ref/nodeset>`) get the stricter PATH check in their own functions.
 */
function checkXPathSurfaces(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const surfaces: Array<{ expr: string; where: string }> = [];

	// `<xpath function>` display expressions.
	for (const fn of collectXPathFunctions(model.suite)) {
		surfaces.push({ expr: fn, where: "an <xpath function>" });
	}

	// Attribute-borne expression surfaces. Each is an ANY-expression slot Core
	// parses through `XPathParseTool`.
	const attrSurfaces: Array<{ tag: string; attr: string; label: string }> = [
		{ tag: "prompt", attr: "default", label: "a <prompt default>" },
		{ tag: "create", attr: "if", label: "a stack <create if>" },
		{ tag: "push", attr: "if", label: "a stack <push if>" },
		{ tag: "clear", attr: "if", label: "a stack <clear if>" },
		{ tag: "action", attr: "relevant", label: "an <action relevant>" },
		{ tag: "field", attr: "relevant", label: "a <field relevant>" },
		{ tag: "detail", attr: "relevant", label: "a <detail relevant>" },
	];
	for (const { tag, attr, label } of attrSurfaces) {
		for (const el of findAll((e) => e.name === tag, model.suite.children)) {
			const expr = getAttributeValue(el, attr);
			if (expr !== undefined && expr !== "") {
				surfaces.push({ expr, where: label });
			}
		}
	}

	for (const { expr, where } of surfaces) {
		if (!isParseableXPath(expr)) {
			errors.push(
				validationError(
					"SUITE_INVALID_XPATH",
					"app",
					`The suite has ${where} whose expression "${expr}" doesn't parse as valid XPath. CommCare evaluates this expression and rejects the suite when it can't parse it. Look at how it was built. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

/**
 * `<data>` checks, faithful to `commcare-core .../xml/QueryDataParser.java`'s
 * context-dependent contract:
 *
 *   - C1-13: `ref` is REQUIRED — `parse()` throws `InvalidStructureException`
 *     when `ref == null`.
 *   - C1-14 (dual-path): `buildQueryData` branches on `nodeset`. When `nodeset`
 *     is present it builds a `ListQueryData` routing BOTH `nodeset` AND `ref`
 *     through `XPathReference.getPathExpr` (PATH-required for each). When
 *     `nodeset` is absent it builds a `ValueQueryData` routing `ref` through
 *     `parseXpath` (ANY-XPath only). So `ref`'s contract changes with the
 *     presence of `nodeset` — PATH alongside a nodeset, merely-parseable
 *     without one.
 *   - `exclude`, when present, routes through `parseXpath` (ANY-XPath).
 */
function checkQueryData(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const data of findAll(
		(el) => el.name === "data",
		model.suite.children,
	)) {
		const key = getAttributeValue(data, "key") ?? "(unnamed)";
		const ref = getAttributeValue(data, "ref");
		const nodeset = getAttributeValue(data, "nodeset");
		const exclude = getAttributeValue(data, "exclude");
		const hasNodeset = nodeset !== undefined && nodeset !== "";

		// C1-13: `ref` is required.
		if (ref === undefined) {
			errors.push(
				validationError(
					"SUITE_DATA_NO_REF",
					"app",
					`The suite has a query <data key="${key}"> with no ref attribute. CommCare requires every query <data> to declare a ref and rejects the suite at parse when it's absent. This is a bug in the suite generator.`,
					loc,
				),
			);
		} else if (ref !== "") {
			// C1-14: when a nodeset is present, `ref` must be a PATH (the
			// ListQueryData branch routes it through getPathExpr); otherwise it
			// need only parse (the ValueQueryData branch).
			if (hasNodeset) {
				if (!isPathExpression(ref)) {
					errors.push(
						validationError(
							"SUITE_DATA_NON_PATH_REF",
							"app",
							`The suite has a query <data key="${key}" ref="${ref}"> that also carries a nodeset, but its ref isn't a location path. When a <data> has both ref and nodeset, CommCare parses each as a node reference and rejects anything that isn't a path. Look at how this query-data ref was built. This is a bug in the suite generator.`,
							loc,
						),
					);
				}
			} else if (!isParseableXPath(ref)) {
				errors.push(
					validationError(
						"SUITE_INVALID_XPATH",
						"app",
						`The suite has a query <data key="${key}" ref="${ref}"> whose ref doesn't parse as valid XPath. CommCare evaluates a value-query ref and rejects the suite when it can't parse it. Look at how this query-data ref was built. This is a bug in the suite generator.`,
						loc,
					),
				);
			}
		}

		// C1-14: a present `nodeset` must be a PATH.
		if (hasNodeset && nodeset !== undefined && !isPathExpression(nodeset)) {
			errors.push(
				validationError(
					"SUITE_NON_PATH_XPATH",
					"app",
					`The suite has a query <data nodeset="${nodeset}"> whose nodeset isn't a location path. When a <data> carries a nodeset, CommCare parses it as a node reference and rejects anything that isn't a path. Look at how this query-data nodeset was built. This is a bug in the suite generator.`,
					loc,
				),
			);
		}

		// `exclude`, when present, must parse as valid XPath.
		if (exclude !== undefined && exclude !== "" && !isParseableXPath(exclude)) {
			errors.push(
				validationError(
					"SUITE_INVALID_XPATH",
					"app",
					`The suite has a query <data key="${key}" exclude="${exclude}"> whose exclude expression doesn't parse as valid XPath. CommCare evaluates the exclude filter and rejects the suite when it can't parse it. Look at how this query-data exclude was built. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

// ── Category 2 — id uniqueness (C2-9 / C2-10) ──────────────────────

/**
 * Command-id (C2-9) + detail-id (C2-10) uniqueness across the whole suite.
 * Core's `SuiteParser` builds both as `Hashtable`s keyed on id, so a duplicate
 * silently last-writer-wins — the earlier definition becomes unreachable. Both
 * tables key globally (not per-menu / per-module), so the scan is suite-wide.
 */
function checkIdUniqueness(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const commandCounts = new Map<string, number>();
	for (const cmd of findAll(
		(el) =>
			el.name === "command" &&
			el.parent !== null &&
			isTag(el.parent) &&
			(el.parent.name === "entry" ||
				el.parent.name === "remote-request" ||
				el.parent.name === "view"),
		model.doc.children,
	)) {
		const id = getAttributeValue(cmd, "id");
		if (id) commandCounts.set(id, (commandCounts.get(id) ?? 0) + 1);
	}
	for (const [id, count] of commandCounts) {
		if (count > 1) {
			errors.push(
				validationError(
					"SUITE_DUPLICATE_COMMAND",
					"app",
					`The suite defines command id "${id}" ${count} times across its entries. CommCare keys commands in a table by id and keeps only the last, making the earlier one unreachable. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	const detailCounts = new Map<string, number>();
	for (const detail of findAll(
		(el) => el.name === "detail",
		model.doc.children,
	)) {
		const id = getAttributeValue(detail, "id");
		// Only top-level details carry suite-global ids; a nested sub-detail
		// (tabbed long detail) inside another detail is scoped to its parent.
		const parent = detail.parent;
		if (parent !== null && isTag(parent) && parent.name === "detail") continue;
		if (id) detailCounts.set(id, (detailCounts.get(id) ?? 0) + 1);
	}
	for (const [id, count] of detailCounts) {
		if (count > 1) {
			errors.push(
				validationError(
					"SUITE_DUPLICATE_DETAIL",
					"app",
					`The suite defines detail id "${id}" ${count} times. CommCare keys details in a table by id and keeps only the last, making the earlier one unreachable. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

// ── Category 2 — menu→command resolution (C2-1) ────────────────────

/**
 * Every `<command id>` a `<menu>` references must resolve to a command an
 * `<entry>` / `<remote-request>` / `<view>` defines (C2-1). At menu open Core's
 * `getStillValidEntriesFromMenu` does `globalEntryMap.get(cmd)` and throws
 * `RuntimeException("No entry found for menu command [...]")` on a miss. Parse-
 * clean, runtime-fatal — the device load gate never catches it.
 */
function checkMenuCommands(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const menu of findAll((el) => el.name === "menu", model.doc.children)) {
		const menuId = getAttributeValue(menu, "id") ?? "(unnamed)";
		for (const cmd of getChildren(menu)) {
			if (!isTag(cmd) || cmd.name !== "command") continue;
			const id = getAttributeValue(cmd, "id");
			if (id === undefined) continue;
			if (!model.commandIds.has(id)) {
				errors.push(
					validationError(
						"SUITE_MENU_COMMAND_UNRESOLVED",
						"app",
						`Menu "${menuId}" references command "${id}", but no entry defines it. CommCare throws "No entry found for menu command" the moment the user opens this menu. This is a bug in the suite generator.`,
						{ ...loc, moduleName: menuId },
					),
				);
			}
		}
	}

	return errors;
}

// ── Category 2 — detail-select / detail-confirm resolution (C2-2/3) ─

/**
 * Every `<datum detail-select>` (C2-3) and `<datum detail-confirm>` (C2-2) must
 * resolve to a `<detail id>`. A miss is parse-clean: `Suite::getDetail` returns
 * null, and the NPE fires later at title render
 * (`FormDataUtil::getMenuTitleString`) or cache scan
 * (`CommCarePlatform::isEntityCachingEnabled`).
 */
function checkDetailReferences(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const datum of findAll(
		(el) => el.name === "datum",
		model.doc.children,
	)) {
		const datumId = getAttributeValue(datum, "id") ?? "(unnamed)";

		const select = getAttributeValue(datum, "detail-select");
		if (select !== undefined && !model.detailIds.has(select)) {
			errors.push(
				validationError(
					"SUITE_DETAIL_SELECT_UNRESOLVED",
					"app",
					`Datum "${datumId}" names detail-select "${select}", but no <detail> with that id exists. CommCare's getDetail returns nothing and the case-list screen crashes when this datum is reached. This is a bug in the suite generator.`,
					loc,
				),
			);
		}

		const confirm = getAttributeValue(datum, "detail-confirm");
		if (confirm !== undefined && !model.detailIds.has(confirm)) {
			errors.push(
				validationError(
					"SUITE_DETAIL_CONFIRM_UNRESOLVED",
					"app",
					`Datum "${datumId}" names detail-confirm "${confirm}", but no <detail> with that id exists. CommCare's getDetail returns nothing and the case-detail screen crashes when this datum is reached. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

// ── Category 2 — instance resolution (C2-4 / C2-5) ─────────────────

/**
 * Per-entry instance resolution (C2-4) + per-entry instance-id uniqueness
 * (C2-5).
 *
 * C2-4: every `instance('foo')` reference appearing in an XPath inside an
 * `<entry>` / `<remote-request>` must have a matching `<instance id="foo">` on
 * that same element (or be one of the runtime-provided ids). A miss is parse-
 * clean; `EvaluationContext::resolveReference` throws
 * `XPathMissingInstanceException` at evaluation. The check sweeps every XPath
 * surface the element body holds — datum value/nodeset, query data ref/nodeset,
 * prompt defaults, post relevant, stack-op values + ifs, and any direct
 * `<xpath function>`.
 *
 * **Reachability note.** Nova's emitted instance vocabulary today is closed to
 * the five ids in `RUNTIME_INSTANCE_IDS`, all runtime-resolved — so C2-4 can
 * NEVER fire on current emitter output (the fuzzer cannot construct a missing
 * declaration). The check is a forward-looking REGRESSION GUARD: the moment an
 * emitter starts emitting `instance('foo')` for a non-runtime `foo` without a
 * matching declaration on the loading scope, this fires. The unit tests cover
 * it with hand-built suites; the fuzzer proves the rest of the oracle, not this.
 *
 * C2-5: a duplicate `<instance id>` on one element silently last-writer-wins
 * (Core's `ParseInstance` Hashtable).
 *
 * Note on details: Nova emits `<detail>` blocks at suite top level, not nested
 * in entries. CCHQ resolves a detail's instance refs against the SPECIFIC entry
 * that loads it (via that entry's `<datum detail-select>` / `detail-confirm>`),
 * not the union of every entry. A detail reachable from two entries must have
 * its refs resolve in BOTH, so the detail branch checks each detail's refs
 * against the INTERSECTION of its referrers' declared instances (∪ the runtime
 * set) — a ref present in only one referrer's scope would `XPathMissingInstance`
 * when the detail is loaded from the other. A detail with zero referrers has no
 * scope to resolve against and is skipped (the empty intersection would
 * degenerate to the runtime set and false-flag any legitimate non-runtime ref
 * on an orphaned detail). The emit-time accumulators
 * (`session.ts::deriveEntryDefinition`, `searchSession.ts::emitSearchSession`)
 * are what make every referrer carry the detail's instances; this is their
 * cross-surface backstop.
 *
 * Referrers are gathered from `detail-select` / `detail-confirm` only — the two
 * detail-loading datum attributes Nova emits. Core's `SessionDatumParser` also
 * recognizes `detail-inline` / `detail-persistent`; Nova emits neither, so a
 * referrer can never hide behind those. If an emitter ever adds an inline or
 * persistent detail, that loading entry must be folded into the referrer map
 * here, or its scope would be missed and the intersection left too wide.
 */
function checkInstanceResolution(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// C2-5: per-element duplicate instance-id detection, plus the in-scope set
	// for each entry.
	for (const scope of model.entryScopes) {
		const seen = new Set<string>();
		for (const inst of getChildren(scope.element)) {
			if (!isTag(inst) || inst.name !== "instance") continue;
			const id = getAttributeValue(inst, "id");
			if (id === undefined) continue;
			if (seen.has(id)) {
				errors.push(
					validationError(
						"SUITE_DUPLICATE_INSTANCE",
						"app",
						`The suite declares <instance id="${id}"> twice on one entry. CommCare keeps only the last declaration. This is a bug in the suite generator.`,
						loc,
					),
				);
			} else {
				seen.add(id);
			}
		}

		// C2-4: every instance ref inside this element must resolve.
		const inScope = new Set<string>([
			...RUNTIME_INSTANCE_IDS,
			...scope.declaredInstances,
		]);
		for (const expr of collectEntryScopeXPaths(scope.element)) {
			for (const ref of collectInstanceRefs(expr)) {
				if (!inScope.has(ref)) {
					errors.push(
						validationError(
							"SUITE_MISSING_INSTANCE",
							"app",
							`An entry references instance('${ref}') but declares no matching <instance id="${ref}"> (and it isn't a runtime instance). CommCare throws XPathMissingInstanceException the moment this expression is evaluated. This is a bug in the suite generator.`,
							loc,
						),
					);
				}
			}
		}
	}

	// Detail-borne `<xpath function>` instance refs. A detail is top-level but is
	// LOADED by the entries that name it via `detail-select` / `detail-confirm`.
	// Core resolves the detail's refs against the loading entry's instance scope,
	// so a ref must resolve in EVERY referrer's scope — the intersection of all
	// referrers' declared instances (∪ runtime). A detail with no referrer has no
	// scope to resolve against and is skipped (checking it against the empty
	// intersection's runtime-only set would false-flag a legitimate non-runtime
	// ref on an orphaned detail).
	for (const detail of findAll(
		(el) => el.name === "detail",
		model.doc.children,
	)) {
		const detailId = getAttributeValue(detail, "id");
		if (detailId === undefined) continue;
		const referrers = model.detailReferrers.get(detailId);
		if (referrers === undefined || referrers.length === 0) continue;

		const resolvable = intersectDeclaredInstances(referrers);
		for (const fn of collectXPathFunctions(detail)) {
			for (const ref of collectInstanceRefs(fn)) {
				if (!resolvable.has(ref)) {
					errors.push(
						validationError(
							"SUITE_MISSING_INSTANCE",
							"app",
							`Detail "${detailId}" references instance('${ref}'), but an entry that loads it declares no matching <instance id="${ref}"> (and it isn't a runtime instance). CommCare throws XPathMissingInstanceException when the detail is rendered from that entry. This is a bug in the suite generator.`,
							loc,
						),
					);
				}
			}
		}
	}

	return errors;
}

/**
 * The instance ids resolvable in EVERY referrer's scope: the intersection of
 * each referrer's declared instances, unioned with the always-resolvable
 * runtime set. A ref not in this set would fail to resolve from at least one
 * entry that loads the detail. Callers guarantee `referrers` is non-empty.
 */
function intersectDeclaredInstances(
	referrers: readonly EntryScope[],
): Set<string> {
	// Seed the intersection with the first referrer's declared set, then narrow
	// against each subsequent referrer. The runtime set is unioned in at the end
	// because it's resolvable in every scope regardless of declaration.
	let intersection = new Set<string>(referrers[0].declaredInstances);
	for (let i = 1; i < referrers.length; i++) {
		const declared = referrers[i].declaredInstances;
		intersection = new Set([...intersection].filter((id) => declared.has(id)));
	}
	for (const id of RUNTIME_INSTANCE_IDS) intersection.add(id);
	return intersection;
}

/**
 * Collect every XPath expression that appears directly inside an entry-like
 * element's body — the surfaces whose `instance(...)` refs resolve against the
 * element's own `<instance>` declarations. Excludes the element's own
 * `<instance src>` attribute (a `jr://` URL, not an XPath).
 */
function collectEntryScopeXPaths(entry: Element): string[] {
	const out: string[] = [];

	// Datum value + nodeset (session datums + stack datums).
	for (const datum of findAll((e) => e.name === "datum", entry.children)) {
		const value = getAttributeValue(datum, "value");
		if (value) out.push(value);
		const nodeset = getAttributeValue(datum, "nodeset");
		if (nodeset) out.push(nodeset);
	}
	// Query data ref + nodeset.
	for (const data of findAll((e) => e.name === "data", entry.children)) {
		const ref = getAttributeValue(data, "ref");
		if (ref) out.push(ref);
		const nodeset = getAttributeValue(data, "nodeset");
		if (nodeset) out.push(nodeset);
	}
	// Prompt defaults.
	for (const prompt of findAll((e) => e.name === "prompt", entry.children)) {
		const def = getAttributeValue(prompt, "default");
		if (def) out.push(def);
	}
	// Post relevant.
	for (const post of findAll((e) => e.name === "post", entry.children)) {
		const relevant = getAttributeValue(post, "relevant");
		if (relevant) out.push(relevant);
	}
	// Stack-op values + ifs + rewind values.
	for (const tag of ["create", "push", "clear", "command", "rewind"]) {
		for (const el of findAll((e) => e.name === tag, entry.children)) {
			const value = getAttributeValue(el, "value");
			if (value) out.push(value);
			const ifClause = getAttributeValue(el, "if");
			if (ifClause) out.push(ifClause);
		}
	}
	// Any `<xpath function>` directly in the entry (e.g. remote-request session
	// expressions).
	for (const fn of collectXPathFunctions(entry)) out.push(fn);

	return out;
}

// ── Category 2 — locale resolution (C2-6) ──────────────────────────

/**
 * Every `<locale id="...">` reference must resolve to an `app_strings.txt`
 * entry (C2-6), or be one of the runtime-provided built-in locale ids. A miss
 * is render-time fatal: `Localization.get` throws `NoLocalizedTextException`
 * when the string isn't registered.
 */
function checkLocaleResolution(
	model: SuiteModel,
	appStringKeys: ReadonlySet<string>,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const seen = new Set<string>();

	for (const id of collectLocaleRefs(model.suite)) {
		if (seen.has(id)) continue;
		seen.add(id);
		if (RUNTIME_LOCALE_IDS.has(id)) continue;
		if (!appStringKeys.has(id)) {
			errors.push(
				validationError(
					"SUITE_MISSING_LOCALE",
					"app",
					`The suite references locale id "${id}" but no app_strings entry defines it. CommCare throws NoLocalizedTextException when it tries to render this string. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

// ── Media wire-path resolution (manifest contract) ─────────────────

/**
 * The `jr://file/` prefix every CommCare media reference carries. Locale
 * values + image-map XPath function literals both wrap their wire paths in
 * this prefix; the check strips it to compare against the manifest's
 * `commcare/<hash><ext>` keys.
 */
const JR_FILE_PREFIX = "jr://file/";

/**
 * Patterns extracting jr:// path literals out of an image-map column's
 * `<xpath function="...">` content. Nova's image-map emitter inlines the
 * paths as quoted XPath string literals inside a nested `if(...)` chain
 * (see `suite/case-list/columns.ts::imageMapDisplayXpath`) — the matcher
 * walks every quoted occurrence (single OR double-quoted) and pulls the
 * `jr://file/...` prefix-to-quote slice.
 *
 * The regex is deliberately liberal on what counts as a path char (anything
 * other than the closing quote) — the strict shape is what the emitter
 * produces (`commcare/<hash><ext>`); the check only needs to compare the
 * captured slice against the manifest.
 */
const IMAGE_MAP_JR_LITERAL_SINGLE = /'(jr:\/\/file\/[^']*)'/g;
const IMAGE_MAP_JR_LITERAL_DOUBLE = /"(jr:\/\/file\/[^"]*)"/g;

/**
 * The closed context the media-path-resolution sweep needs: the suite-wide
 * `app_strings.txt` key→value table (to resolve menu-borne locale media
 * references through to their jr:// wire paths) plus the manifest of
 * `commcare/<hash><ext>` wire paths the compiler bundled into the CCZ.
 *
 * Supplied together (or not at all): the menu-media path is locale-mediated
 * — without the app-strings values, the suite carries no jr:// to scan for —
 * and the manifest is the resolution target both surfaces share. The
 * compile-time caller (`compiler.ts`) builds both from the same emit pass;
 * the fuzz tests build both from the same generator.
 */
export interface SuiteMediaContext {
	readonly appStringValues: ReadonlyMap<string, string>;
	readonly manifest: ReadonlySet<string>;
}

/**
 * Resolve every menu-borne `<text form="image|audio|video">` locale value
 * AND every image-map `<template form="image">`-borne XPath function jr://
 * literal against the supplied manifest.
 *
 * Menu media flows through `app_strings.txt`: the suite emits
 * `<text form="image"><locale id="modules.m0.icon"/></text>`, and the icon's
 * jr:// path lives in `app_strings.txt` under that locale id (see
 * `lib/commcare/multimedia/navMenuMedia.ts::buildNavMenuNode`). The check
 * resolves the locale id through `appStringValues` to its value, peels the
 * `jr://file/` prefix, and looks up the wire path in `manifest`.
 *
 * Image-map media flows through inlined XPath literals: the suite emits
 * `<template form="image"><text><xpath function="if(selected(...,'X'),
 * 'jr://file/commcare/<hash>.png', ...)"...>` (see `suite/case-list/
 * columns.ts::imageMapDisplayXpath`). The check walks every quoted
 * `jr://file/...` occurrence in the function attribute and resolves each
 * against the manifest.
 *
 * Both surfaces produce the same `SUITE_DANGLING_MEDIA_REF` finding — a
 * reference without a bundled-bytes entry renders as a broken icon on
 * device, regardless of which carrier carries it.
 */
function checkMediaResolution(
	model: SuiteModel,
	mediaContext: SuiteMediaContext | undefined,
	loc: ValidationLocation,
): ValidationError[] {
	if (mediaContext === undefined) return [];
	const errors: ValidationError[] = [];
	const { appStringValues, manifest } = mediaContext;

	// Surface 1 — menu-borne `<text form="image|audio|video"><locale id="X"/>`.
	// The locale id resolves to a value in app_strings; when that value is a
	// jr://file/<path> reference, the wire path must be in the manifest.
	const seenLocaleIds = new Set<string>();
	for (const mediaText of findAll(
		(el) =>
			el.name === "text" &&
			(getAttributeValue(el, "form") === "image" ||
				getAttributeValue(el, "form") === "audio" ||
				getAttributeValue(el, "form") === "video"),
		model.suite.children,
	)) {
		const form = getAttributeValue(mediaText, "form");
		for (const localeEl of getChildren(mediaText)) {
			if (!isTag(localeEl) || localeEl.name !== "locale") continue;
			const localeId = getAttributeValue(localeEl, "id");
			if (localeId === undefined) continue;
			if (seenLocaleIds.has(localeId)) continue;
			seenLocaleIds.add(localeId);

			const stringValue = appStringValues.get(localeId);
			// An unregistered locale id is caught by `checkLocaleResolution`
			// (separate finding); the media check skips it so the error
			// surface stays one-finding-per-cause.
			if (stringValue === undefined) continue;
			if (!stringValue.startsWith(JR_FILE_PREFIX)) continue;

			const wirePath = stringValue.slice(JR_FILE_PREFIX.length);
			if (manifest.has(wirePath)) continue;

			errors.push(
				validationError(
					"SUITE_DANGLING_MEDIA_REF",
					"app",
					`A <text form="${form}"> menu carrier references locale "${localeId}" whose app_strings value "${stringValue}" points at a media file the compile-time manifest has no entry for ("${wirePath}"). The device resolves this jr:// reference against media_suite.xml's local resources, so a reference without a bundled file renders as a broken icon. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	// Surface 2 — image-map `<template form="image">` inlined jr:// literals
	// in `<xpath function="...">` content. The Nova emitter inlines the paths
	// as XPath string literals (single-language simplification); each quoted
	// `jr://file/...` slice is one referenced wire path.
	for (const template of findAll(
		(el) => el.name === "template" && getAttributeValue(el, "form") === "image",
		model.suite.children,
	)) {
		for (const fn of collectXPathFunctions(template)) {
			for (const wirePath of extractJrFileLiterals(fn)) {
				if (manifest.has(wirePath)) continue;
				errors.push(
					validationError(
						"SUITE_DANGLING_MEDIA_REF",
						"app",
						`An image-map <template form="image"> inlines a media reference "jr://file/${wirePath}" that the compile-time manifest has no entry for. The device resolves this jr:// reference against media_suite.xml's local resources, so a reference without a bundled file renders as a broken icon. This is a bug in the suite generator.`,
						loc,
					),
				);
			}
		}
	}

	return errors;
}

/**
 * Extract every `commcare/<...>` wire path embedded as a quoted XPath
 * `jr://file/...` literal inside one `<xpath function>` body. Both quote
 * styles are scanned because the emitter's quote choice is deterministic
 * but the oracle should tolerate either — a future quote-flip would
 * otherwise silently waive the check.
 */
function extractJrFileLiterals(xpathFunction: string): string[] {
	const paths: string[] = [];
	for (const re of [IMAGE_MAP_JR_LITERAL_SINGLE, IMAGE_MAP_JR_LITERAL_DOUBLE]) {
		// Reset the lastIndex on the shared regex object — these are module-
		// level singletons and stateful across calls under the `g` flag.
		re.lastIndex = 0;
		for (
			let match = re.exec(xpathFunction);
			match !== null;
			match = re.exec(xpathFunction)
		) {
			paths.push(match[1].slice(JR_FILE_PREFIX.length));
		}
	}
	return paths;
}

// ── Sort — silently tolerated (behaves-wrong, never throws) ────────

/**
 * `<sort>` attribute checks. `DetailFieldParser::parseSort` swallows a bad
 * `@order` / `@direction` / `@type` and `parseBlanksPreference` swallows a bad
 * `@blanks` — the sort silently falls back to a default and the runtime sorts
 * wrong without ever throwing. Nothing in the device flags these, so the oracle
 * must: each is a generator bug the fuzzer hunts.
 */
function checkSort(
	model: SuiteModel,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const sort of findAll((el) => el.name === "sort", model.doc.children)) {
		const order = getAttributeValue(sort, "order");
		// An empty / absent order is the "no explicit order" state Core tolerates
		// cleanly; only a present non-integer silently misbehaves.
		if (order !== undefined && order !== "" && !/^-?\d+$/.test(order)) {
			errors.push(
				validationError(
					"SUITE_SORT_BAD_ORDER",
					"app",
					`The suite has a <sort order="${order}"> whose order isn't an integer. CommCare silently ignores a non-integer order, so the sort runs in the wrong sequence with no error. This is a bug in the suite generator.`,
					loc,
				),
			);
		}

		const direction = getAttributeValue(sort, "direction");
		if (
			direction !== undefined &&
			direction !== "" &&
			!VALID_SORT_DIRECTIONS.has(direction)
		) {
			errors.push(
				validationError(
					"SUITE_SORT_BAD_DIRECTION",
					"app",
					`The suite has a <sort direction="${direction}">, but CommCare only honors "ascending" or "descending" and silently ignores anything else — the column sorts the wrong way with no error. This is a bug in the suite generator.`,
					loc,
				),
			);
		}

		const type = getAttributeValue(sort, "type");
		if (type !== undefined && type !== "" && !VALID_SORT_TYPES.has(type)) {
			errors.push(
				validationError(
					"SUITE_SORT_BAD_TYPE",
					"app",
					`The suite has a <sort type="${type}">, but CommCare only honors "int", "double", or "string" and silently ignores anything else — the column sorts under the wrong comparator with no error. This is a bug in the suite generator.`,
					loc,
				),
			);
		}

		const blanks = getAttributeValue(sort, "blanks");
		if (
			blanks !== undefined &&
			blanks !== "" &&
			!VALID_SORT_BLANKS.has(blanks)
		) {
			errors.push(
				validationError(
					"SUITE_SORT_BAD_BLANKS",
					"app",
					`The suite has a <sort blanks="${blanks}">, but CommCare only honors "first" or "last" and silently ignores anything else — blank values sort in the wrong place with no error. This is a bug in the suite generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Validate a generated `suite.xml` string against CommCare's suite-parse +
 * session-runtime contract. `appStringKeys` is the set of locale ids the
 * compiler registered into `app_strings.txt` (pass `new Set(Object.keys(
 * appStrings))` from the compiler, or parse the `key=value` lines of the
 * emitted `app_strings.txt` in the fuzzer). Returns structured errors (empty
 * array on a clean suite).
 *
 * `mediaContext`, when supplied, additionally resolves every menu-borne
 * `<text form="image|audio|video">` locale value AND every image-map
 * `<template form="image">` inlined jr:// literal against the bundled-media
 * manifest. Omit (or pass `undefined`) on the media-OFF path: the suite then
 * carries no media references to resolve.
 *
 * The oracle is app-scoped — suite findings carry no per-form location, only an
 * optional `moduleName` when an error is module-bounded (e.g. a menu→command
 * miss names the offending `m{N}` menu).
 */
export function validateSuite(
	suiteXml: string,
	appStringKeys: ReadonlySet<string>,
	mediaContext?: SuiteMediaContext,
): ValidationError[] {
	const loc: ValidationLocation = {};

	// Strict well-formedness gate — the only parse-failure path. htmlparser2
	// (used for the DOM walk) is an HTML-recovery parser that heals malformed
	// XML rather than throwing, so it can't be the gate; fast-xml-parser's
	// XMLValidator is a strict XML 1.0 validator matching how Core's
	// KXmlParser rejects a malformed suite.
	const xmlValidation = XMLValidator.validate(suiteXml);
	if (xmlValidation !== true) {
		return [
			validationError(
				"SUITE_PARSE_ERROR",
				"app",
				`The generator produced malformed suite.xml that CommCare will reject: ${xmlValidation.err.msg}. This is a bug in the suite generator.`,
				loc,
			),
		];
	}

	const doc = parseDocument(suiteXml, XML_OPTS);

	const suiteEl = findAll((el) => el.name === "suite", doc.children)[0];
	if (suiteEl === undefined) {
		return [
			validationError(
				"SUITE_NO_SUITE_ELEMENT",
				"app",
				`The generated suite.xml has no <suite> root element. This is a bug in the suite generator.`,
				loc,
			),
		];
	}

	// Build the shared structural model once.
	const detailIds = new Set<string>();
	for (const detail of findAll((el) => el.name === "detail", doc.children)) {
		// Only top-level details participate in the suite-global id table; a
		// nested sub-detail is scoped to its parent.
		const parent = detail.parent;
		if (parent !== null && isTag(parent) && parent.name === "detail") continue;
		const id = getAttributeValue(detail, "id");
		if (id) detailIds.add(id);
	}

	const commandIds = new Set<string>();
	const entryScopes: EntryScope[] = [];
	for (const entry of findAll(
		(el) => el.name === "entry" || el.name === "remote-request",
		doc.children,
	)) {
		entryScopes.push({
			element: entry,
			declaredInstances: collectDeclaredInstances(entry),
		});
	}
	// Command ids defined by entry-like elements (the menu→command resolution
	// targets). `<view>` is included for forward-compat — Core treats it as a
	// command-bearing entry kind.
	for (const cmd of findAll(
		(el) =>
			el.name === "command" &&
			el.parent !== null &&
			isTag(el.parent) &&
			(el.parent.name === "entry" ||
				el.parent.name === "remote-request" ||
				el.parent.name === "view"),
		doc.children,
	)) {
		const id = getAttributeValue(cmd, "id");
		if (id) commandIds.add(id);
	}

	// Detail → loading-entry map. A `<datum detail-select>` / `detail-confirm>`
	// names the detail an entry loads; the detail's instance refs resolve against
	// that entry's scope. Built by walking each entry scope's datums so the C2-4
	// detail check can intersect the scopes of every entry that loads a detail.
	const detailReferrers = new Map<string, EntryScope[]>();
	for (const scope of entryScopes) {
		for (const datum of findAll(
			(el) => el.name === "datum",
			scope.element.children,
		)) {
			for (const attr of ["detail-select", "detail-confirm"]) {
				const detailId = getAttributeValue(datum, attr);
				if (detailId === undefined) continue;
				const list = detailReferrers.get(detailId);
				// One entry may name the same detail on both detail-select and
				// detail-confirm; record the scope once per (detail, entry) pair so
				// the intersection isn't skewed by a self-duplicate.
				if (list === undefined) {
					detailReferrers.set(detailId, [scope]);
				} else if (!list.includes(scope)) {
					list.push(scope);
				}
			}
		}
	}

	const model: SuiteModel = {
		doc,
		suite: suiteEl,
		detailIds,
		commandIds,
		entryScopes,
		detailReferrers,
	};

	// Run every invariant against the shared model. Order is cosmetic — errors
	// accumulate into one flat array the caller renders.
	return [
		// Category 1 — fatal at parse.
		...checkSuiteVersion(model, loc),
		...checkDatums(model, loc),
		...checkDetails(model, loc),
		...checkEntries(model, loc),
		...checkPrompts(model, loc),
		...checkStacks(model, loc),
		...checkXPathSurfaces(model, loc),
		...checkQueryData(model, loc),
		// Category 2 — parse-clean, runtime-fatal.
		...checkIdUniqueness(model, loc),
		...checkMenuCommands(model, loc),
		...checkDetailReferences(model, loc),
		...checkInstanceResolution(model, loc),
		...checkLocaleResolution(model, appStringKeys, loc),
		// Sort — silently tolerated.
		...checkSort(model, loc),
		// Media wire-path resolution — fires only when the caller supplied a
		// media context (the app_strings values + the bundled-media manifest).
		...checkMediaResolution(model, mediaContext, loc),
	];
}
