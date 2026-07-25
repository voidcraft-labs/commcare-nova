import { describe, expect, it } from "vitest";
import type { HqFormLink } from "@/lib/commcare";
import {
	deriveCaseListEntryDefinition,
	deriveEntryDefinition,
	deriveFormLinkStack,
	derivePostSubmitStack,
	deriveSessionDatums,
	type EntryDefinitionInput,
	renderEntryXml,
	renderStackXml,
	type StackOperation,
	toHqWorkflow,
} from "@/lib/commcare/session";
import type {
	NavigationDatum,
	NavigationModule,
} from "@/lib/commcare/suite/navigation";
import {
	concat as concatExpr,
	eq,
	literal,
	matchAll,
	matchNone,
	prop,
	term,
} from "@/lib/domain/predicate/builders";

// ── Navigation fixtures ────────────────────────────────────────────
//
// A frame's steps come from the TARGET module's own forms, so every
// stack assertion below needs a module's frame vocabulary rather than
// just its index. These build the three shapes the emitter distinguishes:
// a case-first module (every form loads a case, so the selection is
// shared and precedes the form command), a forms-first module (the forms
// disagree, so nothing is shared), and a registration module (its datum
// is minted rather than picked).

const caseIdDatum = (caseType: string): NavigationDatum => ({
	id: "case_id",
	caseType,
	requiresSelection: true,
});

const newCaseDatum = (caseType: string, index = 0): NavigationDatum => ({
	id: `case_id_new_${caseType}_${index}`,
	caseType,
	requiresSelection: false,
	function: "uuid()",
});

/** A module whose forms all load the same case type. */
function caseFirstModule(
	index: number,
	caseType: string,
	formCount = 1,
): NavigationModule {
	return {
		commandId: `m${index}`,
		forms: Array.from({ length: formCount }, (_, formIndex) => ({
			commandId: `m${index}-f${formIndex}`,
			datums: [caseIdDatum(caseType)],
		})),
	};
}

/** A module holding one registration form, which mints its case id. */
function registrationModule(index: number, caseType: string): NavigationModule {
	return {
		commandId: `m${index}`,
		forms: [
			{
				commandId: `m${index}-f0`,
				datums: [newCaseDatum(caseType)],
			},
		],
	};
}

/** A module with no datums at all — every form is a survey. */
function surveyModule(index: number, formCount = 1): NavigationModule {
	return {
		commandId: `m${index}`,
		forms: Array.from({ length: formCount }, (_, formIndex) => ({
			commandId: `m${index}-f${formIndex}`,
			datums: [],
		})),
	};
}

const command = (value: string) => ({ type: "command" as const, value });
const sessionDatumRef = (id: string, sourceId = id) => ({
	type: "datum" as const,
	id,
	value: `instance('commcaresession')/session/data/${sourceId}`,
});

/**
 * `deriveEntryDefinition` with the navigation context filled in from the
 * module and form the entry is for. The tests below that assert on
 * instances or datums care about neither, so spelling out a whole app's
 * frame vocabulary at each call site would bury what they are pinning.
 */
function entryFor(
	input: Omit<EntryDefinitionInput, "navigation"> & {
		readonly navigation?: EntryDefinitionInput["navigation"];
	},
) {
	const owning: NavigationModule =
		input.caseType === undefined
			? surveyModule(input.moduleIndex, input.formIndex + 1)
			: caseFirstModule(input.moduleIndex, input.caseType, input.formIndex + 1);
	const modules: NavigationModule[] = Array.from(
		{ length: input.moduleIndex + 1 },
		(_, index) => (index === input.moduleIndex ? owning : surveyModule(index)),
	);
	return deriveEntryDefinition({ navigation: { modules }, ...input });
}

// ── deriveSessionDatums ────────────────────────────────────────────

describe("deriveSessionDatums", () => {
	it("returns case_id datum for followup forms with case type", () => {
		const datums = deriveSessionDatums("followup", 0, "patient");
		expect(datums).toHaveLength(1);
		expect(datums[0].id).toBe("case_id");
		expect(datums[0].instanceId).toBe("casedb");
		expect(datums[0].nodeset).toContain("@case_type='patient'");
		expect(datums[0].nodeset).toContain("@status='open'");
		expect(datums[0].detailSelect).toBe("m0_case_short");
	});

	it("uses correct module index in detail reference", () => {
		const datums = deriveSessionDatums("followup", 3, "household");
		expect(datums[0].detailSelect).toBe("m3_case_short");
	});

	it("returns empty for registration forms", () => {
		expect(deriveSessionDatums("registration", 0, "patient")).toEqual([]);
	});

	it("returns empty for survey forms", () => {
		expect(deriveSessionDatums("survey", 0)).toEqual([]);
	});

	it("returns empty for followup without case type", () => {
		expect(deriveSessionDatums("followup", 0)).toEqual([]);
	});

	// ── caseListConfig.filter integration ──
	//
	// The optional fourth positional parameter compiles the
	// module's case-list filter through `emitNodesetFilter` and
	// appends the bracketed XPath fragment to the nodeset after
	// the canonical `[@case_type][@status]` predicates. Filter
	// precedence (case-type / status first, user filter last)
	// matches CCHQ's
	// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`.

	it("appends the filter fragment after the case-type / status predicates", () => {
		const filter = eq(prop("patient", "is_priority"), literal(true));
		const datums = deriveSessionDatums("followup", 0, "patient", filter);
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][is_priority = 'true']",
		);
	});

	it("omits the filter fragment when the filter is the match-all sentinel", () => {
		const datums = deriveSessionDatums("followup", 0, "patient", matchAll());
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open']",
		);
	});

	it("emits a [false()] fragment for the match-none sentinel", () => {
		// `match-none` faithfully restricts the case list to the
		// empty match set — opposite of match-all's no-op
		// collapse.
		const datums = deriveSessionDatums("followup", 0, "patient", matchNone());
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][false()]",
		);
	});

	it("applies owner exclusion after the always-on list filter", () => {
		const filter = eq(prop("patient", "is_priority"), literal(true));
		const excludedOwners = term(literal("owner-a owner-b"));
		const datums = deriveSessionDatums(
			"followup",
			0,
			"patient",
			filter,
			undefined,
			excludedOwners,
		);

		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][is_priority = 'true'][normalize-space('owner-a owner-b') = '' or not(selected(normalize-space('owner-a owner-b'), @owner_id))]",
		);
	});

	it("ignores the filter for non-case-loading form types", () => {
		// Registration / survey forms emit no case-loading datum
		// at all; the filter is meaningful only against the
		// case-loading datum's nodeset, so the empty array is
		// the correct result regardless of filter presence.
		const filter = eq(prop("patient", "is_priority"), literal(true));
		expect(deriveSessionDatums("registration", 0, "patient", filter)).toEqual(
			[],
		);
		expect(deriveSessionDatums("survey", 0, undefined, filter)).toEqual([]);
	});

	// ── multi-bucket subcase shape (post Step 6 bucketing change) ──
	//
	// The deriveCaseConfig bucketing change in Step 6 allows two repeats
	// in one form to each produce a subcase of the same case type — they
	// land as two distinct OpenSubCaseAction entries with different
	// repeat_context values. The session-datum derivation must skip BOTH
	// from emit (repeat-context subcases mint their case_id via a
	// calculate bind, not a session datum) while still counting them in
	// the index — matching CCHQ's Form.session_var_for_action numbering.
	it("skips emit for every repeat-context subcase but still counts the index", () => {
		const actions = {
			open_case: {
				condition: { type: "always" as const },
				name_update: {
					question_path: "/data/case_name",
					update_mode: "always",
				},
			},
			update_case: { condition: { type: "never" as const }, update: {} },
			case_preload: { condition: { type: "never" as const }, preload: {} },
			close_case: { condition: { type: "never" as const } },
			subcases: [
				{
					doc_type: "OpenSubCaseAction",
					case_type: "child",
					name_update: {
						question_path: "/data/family/case_name",
						update_mode: "always",
					},
					reference_id: "",
					case_properties: {},
					repeat_context: "/data/family",
					relationship: "child" as const,
					close_condition: { type: "never" as const },
					condition: { type: "always" as const },
				},
				{
					doc_type: "OpenSubCaseAction",
					case_type: "child",
					name_update: {
						question_path: "/data/pets/case_name",
						update_mode: "always",
					},
					reference_id: "",
					case_properties: {},
					repeat_context: "/data/pets",
					relationship: "child" as const,
					close_condition: { type: "never" as const },
					condition: { type: "always" as const },
				},
			],
		};
		const datums = deriveSessionDatums(
			"registration",
			0,
			"household",
			undefined,
			actions as never,
		);
		// Only the primary case datum emits — both subcases are
		// repeat-context and skip emit. Without the bucketing fix the
		// derivation would either drop one or duplicate the other (since
		// pre-Step-6 the two subcases collapsed into one).
		expect(datums).toHaveLength(1);
		expect(datums[0].id).toBe("case_id_new_household_0");
	});
});

// ── derivePostSubmitStack ──────────────────────────────────────────

describe("derivePostSubmitStack", () => {
	describe("app_home", () => {
		it("emits no operation at all", () => {
			// `workflow.py::_get_static_stack_frame` has no `WORKFLOW_DEFAULT`
			// arm, so an HQ build emits no `<stack>` and the runtime's own
			// end-of-form return applies. An empty `<create/>` reaches the same
			// screen by a different mechanism, and emitting one here would make
			// the two delivery paths differ for one document.
			for (const mod of [
				caseFirstModule(0, "patient"),
				registrationModule(0, "patient"),
				surveyModule(0),
			]) {
				expect(derivePostSubmitStack("app_home", mod, 0)).toEqual([]);
			}
		});
	});

	describe("root", () => {
		it("emits the empty frame, which is the one meaningful childless one", () => {
			// `_get_static_stack_frame`'s ROOT arm passes `allow_empty_frame=True`,
			// so `StackFrameMeta.to_frame` keeps a frame with no children.
			for (const mod of [caseFirstModule(0, "patient"), surveyModule(0)]) {
				const ops = derivePostSubmitStack("root", mod, 0);
				expect(ops).toEqual([{ op: "create", children: [] }]);
			}
		});
	});

	describe("module", () => {
		it("emits the module command and deliberately none of its shared datums", () => {
			// `_frame_children_for_module(module, include_user_selections=False)`.
			// Carrying `case_id` here would replay straight past the case list
			// the destination exists to show.
			const ops = derivePostSubmitStack(
				"module",
				caseFirstModule(2, "patient"),
				0,
			);
			expect(ops).toEqual([{ op: "create", children: [command("'m2'")] }]);
		});
	});

	describe("parent_module", () => {
		it("resolves to the module's own frame while nesting is unmodelled", () => {
			const mod = caseFirstModule(1, "patient");
			expect(derivePostSubmitStack("parent_module", mod, 0)).toEqual(
				derivePostSubmitStack("module", mod, 0),
			);
		});
	});

	describe("previous", () => {
		it("drops the form command and keeps the case the worker picked", () => {
			const ops = derivePostSubmitStack(
				"previous",
				caseFirstModule(0, "patient"),
				0,
			);
			expect(ops).toEqual([
				{
					op: "create",
					children: [command("'m0'"), sessionDatumRef("case_id")],
				},
			]);
		});

		it("keeps popping past trailing datums nobody picks", () => {
			// A forms-first module: a registration form beside a follow-up, so
			// the two disagree about their first datum and nothing is shared.
			// The registration form's frame therefore ends `m0, m0-f0, <minted
			// id>` and "the previous screen" is the module's own form list —
			// which needs BOTH pops, the unconditional one and the loop.
			const mod: NavigationModule = {
				commandId: "m0",
				forms: [
					{ commandId: "m0-f0", datums: [newCaseDatum("patient")] },
					{ commandId: "m0-f1", datums: [caseIdDatum("patient")] },
				],
			};
			expect(derivePostSubmitStack("previous", mod, 0)).toEqual([
				{ op: "create", children: [command("'m0'")] },
			]);
		});

		it("leaves a survey form on the module screen", () => {
			expect(derivePostSubmitStack("previous", surveyModule(0), 0)).toEqual([
				{ op: "create", children: [command("'m0'")] },
			]);
		});
	});
});

// ── deriveFormLinkStack ────────────────────────────────────────────

describe("deriveFormLinkStack", () => {
	// Guards arrive already exclusive from `projectFormLinksForWire`; this
	// emitter's job is the frame each one carries. The strings below stand
	// in for that projection's output — what they say does not matter here,
	// only that they land on the right `<create>`.
	const surveySource = surveyModule(0);

	it("carries the target's whole frame, not just its commands", () => {
		// A frame is replayed step by step and stops at the first datum it
		// still needs, so a command-only frame would drop the worker on the
		// target's case list to re-pick the case he was already working.
		const links: HqFormLink[] = [
			{
				condition: "count(instance('casedb')/casedb/case) > 0",
				target: { type: "form", moduleIndex: 1, formIndex: 0 },
			},
		];
		const ops = deriveFormLinkStack(
			links,
			undefined,
			[surveySource, caseFirstModule(1, "patient")],
			surveySource,
			0,
			[caseIdDatum("patient")],
		);
		expect(ops).toEqual([
			{
				op: "create",
				ifClause: "count(instance('casedb')/casedb/case) > 0",
				children: [
					command("'m1'"),
					sessionDatumRef("case_id"),
					command("'m1-f0'"),
				],
			},
		]);
	});

	it("carries a registration form's new case into the follow-up it links to", () => {
		// The flagship register-then-route shape: the source's
		// `case_id_new_<type>_0` matches the target's `case_id` on CASE TYPE,
		// not on name (`workflow.py::_find_best_match`'s different-ID arm), so
		// the target datum keeps its own id and reads the source's variable.
		const source = registrationModule(0, "patient");
		const ops = deriveFormLinkStack(
			[{ target: { type: "form", moduleIndex: 1, formIndex: 0 } }],
			undefined,
			[source, caseFirstModule(1, "patient")],
			source,
			0,
			[newCaseDatum("patient")],
		);
		expect(ops[0].children).toEqual([
			command("'m1'"),
			sessionDatumRef("case_id", "case_id_new_patient_0"),
			command("'m1-f0'"),
		]);
	});

	it("leaves an unmatched selection reading its own empty variable", () => {
		// `_find_best_match` returns nothing when no source datum shares the
		// case type, and HQ then yields the target datum unchanged. The worker
		// lands on the destination's selection screen, which is the honest
		// outcome — the alternative is inventing a case id.
		const source = registrationModule(0, "patient");
		const ops = deriveFormLinkStack(
			[{ target: { type: "form", moduleIndex: 1, formIndex: 0 } }],
			undefined,
			[source, caseFirstModule(1, "household")],
			source,
			0,
			[newCaseDatum("patient")],
		);
		expect(ops[0].children).toEqual([
			command("'m1'"),
			sessionDatumRef("case_id"),
			command("'m1-f0'"),
		]);
	});

	it("emits only the module command for a module target", () => {
		const ops = deriveFormLinkStack(
			[{ target: { type: "module", moduleIndex: 1 } }],
			undefined,
			[surveySource, caseFirstModule(1, "patient")],
			surveySource,
			0,
			[],
		);
		// `_frame_children_for_module(…, include_user_selections=False)` — the
		// link lands on the case list rather than replaying past it.
		expect(ops).toEqual([{ op: "create", children: [command("'m1'")] }]);
	});

	it("substitutes an author-supplied datum for the automatic match", () => {
		const source = caseFirstModule(0, "household");
		const ops = deriveFormLinkStack(
			[
				{
					target: { type: "form", moduleIndex: 1, formIndex: 0 },
					datums: [{ name: "case_id", xpath: "/data/patient_id" }],
				},
			],
			undefined,
			[source, caseFirstModule(1, "patient")],
			source,
			0,
			[caseIdDatum("household")],
		);
		expect(ops[0].children).toEqual([
			command("'m1'"),
			{ type: "datum", id: "case_id", value: "/data/patient_id" },
			command("'m1-f0'"),
		]);
	});

	it("drops a link whose supplied datums leave a selection uncovered", () => {
		// `_get_datums_matched_to_manual_values` RAISES here, failing HQ's
		// whole suite build rather than the one link. `FORM_LINK_DATUM_INCOMPLETE`
		// refuses the document, so this emitter stays total for the validation
		// loop's own compile instead of representing the unrepresentable.
		const source = caseFirstModule(0, "household");
		const ops = deriveFormLinkStack(
			[
				{
					target: { type: "form", moduleIndex: 1, formIndex: 0 },
					datums: [{ name: "other_id", xpath: "/data/x" }],
				},
			],
			undefined,
			[source, caseFirstModule(1, "patient")],
			source,
			0,
			[caseIdDatum("household")],
		);
		expect(ops).toEqual([]);
	});

	it("appends the fallback frame under the guard it was handed", () => {
		const ops = deriveFormLinkStack(
			[
				{
					condition: "a = 1",
					target: { type: "module", moduleIndex: 1 },
				},
			],
			{ guard: "not(a = 1)", destination: "module" },
			[caseFirstModule(0, "patient"), caseFirstModule(1, "patient")],
			caseFirstModule(0, "patient"),
			0,
			[caseIdDatum("patient")],
		);
		expect(ops).toHaveLength(2);
		expect(ops[1]).toEqual({
			op: "create",
			ifClause: "not(a = 1)",
			children: [command("'m0'")],
		});
	});

	it("emits no fallback when the projection suppressed it", () => {
		// A terminal unconditional link is the exhaustive `else`, so there is
		// nothing left to fall back to and the frame is suppressed rather than
		// emitted under a guard that can never hold.
		const ops = deriveFormLinkStack(
			[
				{ condition: "a = 1", target: { type: "module", moduleIndex: 1 } },
				{ target: { type: "module", moduleIndex: 1 } },
			],
			undefined,
			[surveySource, caseFirstModule(1, "patient")],
			surveySource,
			0,
			[],
		);
		expect(ops).toHaveLength(2);
		expect(ops[1].ifClause).toBeUndefined();
	});

	it("emits no `if` at all for an unguarded frame", () => {
		// `if=""` is not a substitute for an absent attribute:
		// `StackOpParser` hands any non-null value to `StackOperation`, whose
		// constructor parses it, and `XPathParseTool.parseXPath("")` throws —
		// failing the whole suite parse rather than the one frame.
		const ops = deriveFormLinkStack(
			[{ condition: "", target: { type: "module", moduleIndex: 1 } }],
			undefined,
			[surveySource, caseFirstModule(1, "patient")],
			surveySource,
			0,
			[],
		);
		expect(ops[0]).not.toHaveProperty("ifClause");
	});

	it("drops a link whose target module is not in the app", () => {
		const ops = deriveFormLinkStack(
			[{ target: { type: "module", moduleIndex: 7 } }],
			undefined,
			[surveySource],
			surveySource,
			0,
			[],
		);
		expect(ops).toEqual([]);
	});
});

// ── deriveEntryDefinition ──────────────────────────────────────────

describe("deriveEntryDefinition", () => {
	it("builds complete entry for followup form with previous navigation", () => {
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
		});
		expect(entry.commandId).toBe("m0-f1");
		expect(entry.localeId).toBe("forms.m0f1");
		expect(entry.instances).toHaveLength(1);
		expect(entry.session?.datums).toHaveLength(1);
		expect(entry.stack?.operations).toHaveLength(1);
	});

	it("never declares search-input:results on the ordinary entry, matching the substituted nodeset", () => {
		// The ordinary case-loading entry evaluates before any Search
		// runs, so the nodeset emission substitutes Search-input refs to
		// their unanswered reading and the accumulator collects from the
		// SAME substituted tree — a declared-but-unloaded
		// `search-input:results` instance would itself throw
		// `XPathMissingInstanceException` in Core the moment the nodeset
		// referenced it.
		const filter = eq(
			prop("patient", "city"),
			term({ kind: "input", name: "city_q" }),
		);
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListFilter: filter,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("casedb");
		expect(ids).not.toContain("search-input:results");
		const nodeset = entry.session?.datums[0]?.nodeset ?? "";
		expect(nodeset).not.toContain("search-input:results");
	});

	it("accumulates the commcaresession instance when the case-list filter references a session term", () => {
		const filter = eq(
			prop("patient", "region"),
			term({ kind: "session-user", field: "region" }),
		);
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListFilter: filter,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("commcaresession");
		const session = entry.instances.find((i) => i.id === "commcaresession");
		expect(session?.src).toBe("jr://instance/session");
	});

	it("accumulates commcaresession when the search-button display condition references a session term", () => {
		// The search-button display condition lowers to the
		// `<action relevant>` attribute on the case-list short detail.
		// That attribute evaluates in the enclosing `<entry>` context,
		// so every instance the predicate references needs an
		// `<instance>` declaration on the entry — same accumulation
		// rule the case-list filter applies.
		const displayCondition = eq(
			term({ kind: "session-user", field: "region" }),
			prop("patient", "region"),
		);
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			searchButtonDisplayCondition: displayCondition,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("commcaresession");
	});

	it("accumulates both selected-case instances for form-command relevance", () => {
		const displayCondition = eq(prop("patient", "status"), literal("open"));
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			formDisplayCondition: displayCondition,
		});
		expect(entry.instances.map((instance) => instance.id)).toEqual(
			expect.arrayContaining(["casedb", "commcaresession"]),
		);
	});

	it("accumulates instances referenced by the owner-exclusion expression", () => {
		const excludedOwners = term({
			kind: "session-user",
			field: "excluded_owner_ids",
		});
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			excludedOwnerIds: excludedOwners,
		});

		expect(entry.instances).toContainEqual({
			id: "commcaresession",
			src: "jr://instance/session",
		});
		expect(entry.session?.datums[0].nodeset).toContain(
			"[normalize-space(instance('commcaresession')/session/user/data/excluded_owner_ids) = '' or not(selected(normalize-space(instance('commcaresession')/session/user/data/excluded_owner_ids), @owner_id))]",
		);
	});

	it("omits detail-confirm when a case-list viewer has no Details fields", () => {
		const entry = deriveCaseListEntryDefinition(
			0,
			"patient",
			undefined,
			undefined,
			undefined,
			false,
		);
		const datum = entry.session?.datums[0];

		expect(datum?.detailSelect).toBe("m0_case_short");
		expect(datum?.detailConfirm).toBeUndefined();
	});

	it("accumulates search-input:results when the search-button display condition references a search input", () => {
		const displayCondition = eq(
			term({ kind: "input", name: "city_q" }),
			literal("active"),
		);
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			searchButtonDisplayCondition: displayCondition,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("search-input:results");
	});

	it("accumulates instances reachable from calc-column expressions", () => {
		// Calc-column expressions land on `m{N}_case_short` /
		// `m{N}_case_long`. CCHQ resolves a detail's XPath against
		// the enclosing entry's declarations; without this
		// accumulation, the local `.ccz` would emit an
		// `instance('commcaresession')` reference inside the detail
		// without a matching declaration on the entry, and the
		// runtime would raise `XPathException` at case-list render
		// time.
		const calcExpressions = [
			concatExpr(
				term({ kind: "session-user", field: "region" }),
				term(literal(": ")),
				term({ kind: "prop", caseType: "patient", property: "case_name" }),
			),
		];
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListColumnExpressions: calcExpressions,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("commcaresession");
		expect(ids).toContain("casedb");
	});

	it("dedups instances across calc-column expressions and the case-list filter", () => {
		// Both surfaces reference `commcaresession`; the accumulator
		// must not double-emit the declaration.
		const filter = eq(
			prop("patient", "region"),
			term({ kind: "session-user", field: "region" }),
		);
		const calcExpressions = [
			concatExpr(term({ kind: "session-user", field: "language" })),
		];
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListFilter: filter,
			caseListColumnExpressions: calcExpressions,
		});
		const sessionInstances = entry.instances.filter(
			(i) => i.id === "commcaresession",
		);
		expect(sessionInstances).toHaveLength(1);
	});

	it("dedups instances across the case-list filter and the display condition", () => {
		// Both predicates reference the same `commcaresession`
		// instance; the accumulator should not double-emit.
		const filter = eq(
			prop("patient", "region"),
			term({ kind: "session-user", field: "region" }),
		);
		const displayCondition = eq(
			term({ kind: "session-user", field: "language" }),
			literal("en"),
		);
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListFilter: filter,
			searchButtonDisplayCondition: displayCondition,
		});
		const sessionInstances = entry.instances.filter(
			(i) => i.id === "commcaresession",
		);
		expect(sessionInstances).toHaveLength(1);
	});

	it("omits stack for the app-home destination", () => {
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 0,
			formType: "registration",
			postSubmit: "app_home",
		});
		expect(entry.stack).toBeUndefined();
	});

	it("prioritizes formLinks over simple post_submit", () => {
		// With links present the stack comes from the links; `postSubmit`
		// survives only as the fallback frame's destination.
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/xyz",
			moduleIndex: 0,
			formIndex: 0,
			formType: "survey",
			postSubmit: "app_home",
			navigation: {
				modules: [surveyModule(0), caseFirstModule(1, "patient")],
			},
			formLinks: [
				{
					condition: "go = 'yes'",
					target: { type: "form", moduleIndex: 1, formIndex: 0 },
				},
			],
		});
		const ops = entry.stack?.operations;
		expect(ops).toBeDefined();
		expect(ops?.[0].ifClause).toBe("go = 'yes'");
	});

	it("declares the instances a link guard reads, on the entry that evaluates it", () => {
		// The stack `if` evaluates in THIS entry's instance scope. A guard
		// naming an undeclared instance throws in Core's
		// `XPathPathExpr.evalRaw` the moment the form is submitted — and a
		// registration entry declares no `casedb` otherwise, which is exactly
		// where a guard reading the case the form just created lands.
		const guard = eq(prop("patient", "status"), literal("open"));
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/xyz",
			moduleIndex: 0,
			formIndex: 0,
			formType: "registration",
			postSubmit: "app_home",
			caseType: "patient",
			navigation: {
				modules: [
					registrationModule(0, "patient"),
					caseFirstModule(1, "patient"),
				],
			},
			formLinks: [
				{
					condition: "…",
					target: { type: "module", moduleIndex: 1 },
				},
			],
			linkGuardPredicates: [guard],
		});
		expect(entry.instances.map((instance) => instance.id)).toEqual(
			expect.arrayContaining(["casedb", "commcaresession"]),
		);
	});
});

// ── renderStackXml ─────────────────────────────────────────────────

describe("renderStackXml", () => {
	it("renders empty string for no operations", () => {
		expect(renderStackXml([])).toBe("");
	});

	it("renders empty create", () => {
		const xml = renderStackXml([{ op: "create", children: [] }]);
		expect(xml).toContain("<create/>");
	});

	it("renders clear operation", () => {
		const xml = renderStackXml([{ op: "clear", children: [] }]);
		expect(xml).toContain("<clear/>");
		expect(xml).not.toContain("</clear>");
	});

	it("renders conditional clear", () => {
		const xml = renderStackXml([
			{ op: "clear", ifClause: "true()", children: [] },
		]);
		expect(xml).toContain('<clear if="true()"/>');
	});

	it("renders push operation", () => {
		const op: StackOperation = {
			op: "push",
			children: [{ type: "datum", id: "case_id", value: "abc" }],
		};
		const xml = renderStackXml([op]);
		expect(xml).toContain("<push>");
		expect(xml).toContain("</push>");
		expect(xml).toContain('id="case_id"');
	});

	it("renders create with children", () => {
		const op: StackOperation = {
			op: "create",
			ifClause: "age > 18",
			children: [{ type: "command", value: "'m1-f0'" }],
		};
		const xml = renderStackXml([op]);
		// `>` in the `if` attribute round-trips through the XML
		// entity `&gt;` — same XML-spec-equivalent encoding the
		// XForm emitter produces. A conforming parser decodes both
		// forms identically; CCHQ and JavaRosa see `age > 18`.
		expect(xml).toContain('<create if="age &gt; 18">');
		expect(xml).toContain("</create>");
		// XPath single-quote string literals round-trip as `&apos;`
		// inside double-quoted attribute values. Same encoding the
		// XForm path uses on every `<setvalue value="instance(...)`.
		expect(xml).toContain('<command value="&apos;m1-f0&apos;"/>');
	});

	it("renders multiple operations", () => {
		const ops: StackOperation[] = [
			{
				op: "create",
				ifClause: "x = 1",
				children: [{ type: "command", value: "'m0-f0'" }],
			},
			{ op: "create", children: [{ type: "command", value: "'m0'" }] },
		];
		const xml = renderStackXml(ops);
		expect(xml).toContain('if="x = 1"');
		expect(xml).toContain('<command value="&apos;m0-f0&apos;"/>');
		expect(xml).toContain('<command value="&apos;m0&apos;"/>');
	});
});

// ── renderEntryXml ─────────────────────────────────────────────────

describe("renderEntryXml", () => {
	it("renders basic registration entry without stack", () => {
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 0,
			formType: "registration",
			postSubmit: "app_home",
		});
		const xml = renderEntryXml(entry);
		expect(xml).toContain("<entry>");
		expect(xml).toContain("<form>http://openrosa.org/formdesigner/abc</form>");
		expect(xml).not.toContain("<stack>");
		expect(xml).toContain("</entry>");
	});

	it("renders followup entry with session and stack", () => {
		const entry = entryFor({
			formXmlns: "http://openrosa.org/formdesigner/xyz",
			moduleIndex: 1,
			formIndex: 2,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
		});
		const xml = renderEntryXml(entry);
		expect(xml).toContain("<session>");
		expect(xml).toContain('id="case_id"');
		expect(xml).toContain("<stack>");
		// XPath single-quote literals round-trip as `&apos;` inside
		// double-quoted attribute values.
		expect(xml).toContain('<command value="&apos;m1&apos;"/>');
	});
});

// ── HQ workflow mapping ────────────────────────────────────────────

describe("toHqWorkflow", () => {
	it("maps all destinations correctly", () => {
		expect(toHqWorkflow("app_home")).toBe("default");
		expect(toHqWorkflow("root")).toBe("root");
		expect(toHqWorkflow("module")).toBe("module");
		expect(toHqWorkflow("parent_module")).toBe("parent_module");
		expect(toHqWorkflow("previous")).toBe("previous_screen");
	});
});
