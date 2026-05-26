// lib/commcare/compiler.ts
//
// HqApplication + BlueprintDoc → .ccz Buffer.
//
// The compile pipeline takes the expanded HQ JSON (produced by
// `expandDoc`) and the source `BlueprintDoc`, and produces a .ccz ZIP
// archive ready for CommCare Mobile. The archive contains:
//
//   - profile.ccpr                : app profile (name + suite descriptors)
//   - suite.xml                   : menus, commands, case details, entries, locales
//   - media_suite.xml             : empty media suite (multimedia is unused)
//   - {lang}/app_strings.txt      : per-language localized string tables
//   - modules-{m}/forms-{f}.xml   : one XForm per form, with case blocks injected
//
// The domain doc is walked in lockstep with `hqJson.modules` so per-form
// metadata that the HQ wire shape doesn't carry (form type) can be
// resolved without index arithmetic. The parallel order is guaranteed
// by construction from `expandDoc`.
//
// Every XForm is re-validated after case-block injection; structural
// problems (orphaned binds, dangling refs) surface as a thrown Error
// before packaging.

import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import {
	escapeXml,
	type FormActionCondition,
	type FormActions,
	type HqApplication,
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare";
import { deriveEntryDefinition, renderEntryXml } from "@/lib/commcare/session";
import { emitLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import { emitShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { emitRemoteRequest } from "@/lib/commcare/suite/case-search/remoteRequest";
import { validateBindingResolution } from "@/lib/commcare/validator/bindingResolutionOracle";
import { errorToString } from "@/lib/commcare/validator/errors";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { type BlueprintDoc, defaultPostSubmit } from "@/lib/domain";

/**
 * Compile an HQ application JSON (already expanded from a domain doc)
 * into a .ccz archive `Buffer`.
 *
 * `doc` is the source `BlueprintDoc` — its `moduleOrder` / `formOrder`
 * walk mirrors `hqJson.modules` / `hqJson.modules[m].forms` exactly,
 * which lets us resolve the form-type metadata (absent from the HQ
 * wire shape) while producing the session entry for each form.
 */
export function compileCcz(
	hqJson: HqApplication,
	appName: string,
	doc: BlueprintDoc,
): Buffer {
	const hqModules = hqJson.modules;
	const attachments = hqJson._attachments;

	// Output file map — each entry becomes a zip entry at the end.
	const files: Record<string, string> = {};

	files["profile.ccpr"] = generateProfile(appName);
	files["media_suite.xml"] = '<?xml version="1.0"?>\n<suite version="1"/>';

	// `appStrings` is populated as we walk modules/forms; flushed once
	// per language at the end.
	const appStrings: Record<string, string> = { "app.name": appName };
	const suiteEntries: string[] = [];
	const suiteMenus: string[] = [];
	const suiteDetails: string[] = [];
	const suiteResources: string[] = [];
	// `<remote-request>` elements accumulate alongside the other
	// top-level suite-XML element families. CCHQ's wire layout has
	// no canonical position for `<remote-request>` relative to
	// `<detail>` / `<entry>` / `<menu>`, so the compiler splices
	// these elements after the case-detail block and before the
	// `<entry>` block — placing them adjacent to the detail blocks
	// they reference (`m{N}_search_short` / `m{N}_search_long`)
	// keeps the rendered suite.xml structurally local.
	const suiteRemoteRequests: string[] = [];

	// Walk HQ modules and `doc.moduleOrder` in lockstep. `expandDoc`
	// produces HQ modules in the same order as `moduleOrder`, so
	// `doc.modules[doc.moduleOrder[mIdx]]` is the domain twin of
	// `hqModules[mIdx]`.
	for (let mIdx = 0; mIdx < hqModules.length; mIdx++) {
		const hqMod = hqModules[mIdx];
		const moduleUuid = doc.moduleOrder[mIdx];
		const formUuids = doc.formOrder[moduleUuid] ?? [];

		const mod = doc.modules[moduleUuid];
		const modName = hqMod.name.en;
		const caseType = hqMod.case_type;
		const hqForms = hqMod.forms;

		appStrings[`modules.m${mIdx}`] = modName;

		// Case detail definitions — emitted only when the module has a case
		// type. Short + long details are always paired.
		//
		// Both surfaces emit through typed emitters at
		// `@/lib/commcare/suite/case-list/{shortDetail,longDetail}.ts`,
		// which walk `module.caseListConfig.columns` directly (the typed
		// `Column` discriminated union with per-column sort directives,
		// calculated arms, and visibility flags) and return both the
		// suite-XML fragment and the locale-id → header-string map the
		// runtime renders against. The HQ-JSON projection on
		// `hqMod.case_details` is no longer consulted here; the typed
		// emitters own the wire shape end-to-end.
		//
		// `doc` threads through to the short-detail emitter so the
		// per-column sort comparator type can resolve from the case
		// property's declared `data_type` (or the calculated column's
		// expression's resolved result type). The long-detail emitter
		// accepts `doc` for API symmetry but doesn't read it.
		//
		// When `mod.caseSearchConfig` is present, the same
		// `caseListConfig` projects onto a second pair of wire ids —
		// `m{N}_search_short` + `m{N}_search_long`. Nova's principle:
		// "from the user's perspective there is only one case list,
		// regardless of how they get there." The wire emitter
		// duplicates the rendered content under the search-target
		// wire ids; the canonical fixture
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`
		// pins the structural identity. Modules without
		// `caseSearchConfig` skip the search-target emission;
		// emission is purely additive.
		//
		// Both detail blocks resolve their `<title>` through CCHQ's
		// built-in `cchq.case` locale (registered with
		// `default="Case"` at
		// `commcare-hq/corehq/apps/app_manager/id_strings.py::_case_detail_title_locale`).
		// Neither emitter registers a per-module title in app_strings;
		// the runtime falls back to "Case" until an author overrides
		// `cchq.case` at the app-strings layer (Nova has no such
		// authoring surface today).
		if (caseType) {
			// `<remote-request>` orchestrator. Computes the
			// `WireShape` for this module via `compileForPlatform`
			// (default platform context: web) and emits the full
			// `<remote-request>` element. The orchestrator returns
			// the `WireShape` so the surrounding short-detail
			// emission can render the `<action auto_launch>` element
			// with the matching expression — the action attribute
			// lives on `m{N}_case_short`, not on `<query>`, per
			// CCHQ's
			// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_action_kwargs`.
			//
			// Modules without `caseSearchConfig` skip this emission
			// entirely; their case-list short detail renders without
			// an `<action>` child. The two paths compose without
			// branch-doubling at the detail emitter — `searchAction`
			// is `undefined` when no case-search config is present.
			const remoteRequestEmission = mod.caseSearchConfig
				? emitRemoteRequest({
						module: mod,
						moduleIndex: mIdx,
					})
				: undefined;
			if (remoteRequestEmission !== undefined) {
				suiteRemoteRequests.push(remoteRequestEmission.xml);
				Object.assign(appStrings, remoteRequestEmission.strings);
			}

			const shortEmission = emitShortDetail({
				module: mod,
				moduleIndex: mIdx,
				doc,
				...(remoteRequestEmission !== undefined && {
					searchAction: {
						autoLaunch: remoteRequestEmission.wire.autoLaunch,
						...(mod.caseSearchConfig?.searchButtonDisplayCondition !==
							undefined && {
							displayCondition:
								mod.caseSearchConfig.searchButtonDisplayCondition,
						}),
					},
				}),
			});
			suiteDetails.push(shortEmission.xml);
			Object.assign(appStrings, shortEmission.strings);

			const longEmission = emitLongDetail({
				module: mod,
				moduleIndex: mIdx,
				doc,
			});
			suiteDetails.push(longEmission.xml);
			Object.assign(appStrings, longEmission.strings);

			// Search-target dual emission. Same `caseListConfig` walked
			// against the `"search"` target — produces `m{N}_search_short`
			// + `m{N}_search_long` blocks. Calc-column cross-case
			// references rewrite their instance root from `casedb` to
			// `results` per the canonical fixture
			// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`.
			// The search-target short detail does NOT carry an
			// `<action>` element — the search results screen IS the
			// action's destination.
			if (mod.caseSearchConfig) {
				const searchShort = emitShortDetail({
					module: mod,
					moduleIndex: mIdx,
					doc,
					target: "search",
				});
				suiteDetails.push(searchShort.xml);
				Object.assign(appStrings, searchShort.strings);

				const searchLong = emitLongDetail({
					module: mod,
					moduleIndex: mIdx,
					doc,
					target: "search",
				});
				suiteDetails.push(searchLong.xml);
				Object.assign(appStrings, searchLong.strings);
			}
		}

		const menuCommands: string[] = [];

		for (let fIdx = 0; fIdx < hqForms.length; fIdx++) {
			const hqForm = hqForms[fIdx];
			const formUuid = formUuids[fIdx];
			// Form type + post-submit destination live only on the domain
			// doc. The HQ wire shape stores a coerced `post_form_workflow`
			// string whose mapping is lossy (e.g. "app_home" and an absent
			// field both round-trip through "default"), so the compiler
			// reads both fields straight from the doc to avoid losing
			// fidelity. Defaulting follows the form-type rule the expander
			// applies when emitting the wire payload.
			const form = doc.forms[formUuid];
			const formType = form.type;
			const postSubmit = form.postSubmit ?? defaultPostSubmit(formType);

			const formName = hqForm.name.en;
			const xmlns = hqForm.xmlns;
			const uniqueId = hqForm.unique_id;
			const cmdId = `m${mIdx}-f${fIdx}`;
			const filePath = `modules-${mIdx}/forms-${fIdx}.xml`;

			appStrings[`forms.m${mIdx}f${fIdx}`] = formName;

			// Case-block injection: the emitter produces a clean XForm; the
			// compiler splices in <case>/<subcase> elements based on the
			// form's derived actions so the mobile runtime can read/write
			// the case database.
			let xform = attachments[`${uniqueId}.xml`];
			if (xform && caseType) {
				xform = addCaseBlocks(xform, hqForm.actions, caseType);
			}

			// Entry — `deriveEntryDefinition` builds the datum + post-submit
			// stack from the form's type, its post-submit destination, the
			// module's case type, any form-level link overrides, the
			// module's authored case-list filter, and the search-button
			// display condition.
			//
			// The expander already resolved form-link uuids into indexed
			// HQ shape, so the compiler forwards `hqForm.form_links`
			// verbatim — no second resolution pass needed here.
			//
			// Three authoring surfaces contribute to the entry's
			// `<instance>` accumulator:
			//   - `caseListConfig.filter` flows through verbatim; the wire
			//     layer at `session.ts::deriveSessionDatums` routes it
			//     through `emitNodesetFilter` to compose the bracketed
			//     fragment that appends to the case-loading datum's
			//     nodeset.
			//   - `caseSearchConfig.searchButtonDisplayCondition` lowers
			//     to the `<action relevant>` attribute on the case-list
			//     detail's search-action element, which evaluates in this
			//     entry's context.
			//   - Calc-column expressions land on the module's
			//     `m{N}_case_short` / `m{N}_case_long` detail blocks the
			//     entry's `<datum detail-select / detail-confirm>`
			//     references. CCHQ resolves the detail's XPath against
			//     the enclosing entry's declarations, so every instance a
			//     calc expression reaches needs a matching `<instance>`
			//     here.
			//
			// Built BEFORE the validation gates so the binding-resolution
			// oracle has the entry's session datums to cross-check the
			// XForm's `instance('commcaresession')/session/data/<X>`
			// references against.
			const caseListColumnExpressions =
				mod.caseListConfig?.columns
					.filter((c) => c.kind === "calculated")
					.map((c) => c.expression) ?? [];
			const entryDef = deriveEntryDefinition(
				xmlns,
				mIdx,
				fIdx,
				formType,
				postSubmit,
				caseType || undefined,
				hqForm.form_links.length > 0 ? hqForm.form_links : undefined,
				mod.caseListConfig?.filter,
				mod.caseSearchConfig?.searchButtonDisplayCondition,
				caseListColumnExpressions.length > 0
					? caseListColumnExpressions
					: undefined,
				hqForm.actions,
			);

			// Re-validate after injection — catches orphaned binds or
			// malformed structure introduced by the splice.
			if (xform) {
				const xformErrors = validateXForm(xform, formName, modName);
				if (xformErrors.length > 0) {
					throw new Error(
						`XForm validation failed for "${formName}" in "${modName}" after case block injection:\n` +
							xformErrors.map((e) => `  - ${errorToString(e)}`).join("\n"),
					);
				}

				// Install-time XPath resolution gate. The XForm parse-time
				// oracle above proves expressions PARSE; this oracle proves
				// install-time-fatal references RESOLVE — every
				// `instance('commcaresession')/session/data/<X>` ref matches
				// a declared session datum, every
				// `instance('commcaresession')/session/context/<X>` matches
				// the closed CommCare-populated set, and every
				// `instance('<id>')` matches a declared instance on the
				// form's <model>. Form-path refs inside expression bodies
				// (`<output value>`, bind `calculate`, etc.) are NOT checked
				// — JavaRosa resolves missing paths to empty node-sets, not
				// crashes; dangling bind NODESETS, the install-time-fatal
				// case, are caught upstream by `XFORM_DANGLING_BIND`.
				const sessionDatumIds = new Set(
					entryDef.session?.datums.map((d) => d.id) ?? [],
				);
				const resolutionErrors = validateBindingResolution(
					xform,
					formName,
					modName,
					sessionDatumIds,
				);
				if (resolutionErrors.length > 0) {
					throw new Error(
						`Binding resolution failed for "${formName}" in "${modName}":\n` +
							resolutionErrors.map((e) => `  - ${errorToString(e)}`).join("\n"),
					);
				}
			}

			files[filePath] = xform;

			// XForm resource declaration in suite.xml.
			suiteResources.push(
				`  <xform>\n    <resource id="${filePath}" version="1">\n      <location authority="local">./${filePath}</location>\n    </resource>\n  </xform>`,
			);

			suiteEntries.push(renderEntryXml(entryDef));
			menuCommands.push(`    <command id="${cmdId}"/>`);
		}

		suiteMenus.push(
			`  <menu id="m${mIdx}">\n    <text><locale id="modules.m${mIdx}"/></text>\n${menuCommands.join("\n")}\n  </menu>`,
		);
	}

	// HQ convention — the first entry of `hqJson.langs` is the default
	// locale (its resources live in the `default/` directory). Every
	// other language gets its own directory named after the lang code.
	const langs = hqJson.langs;
	const langDirs: Array<[lang: string, dir: string]> = langs.map((lang, i) => [
		lang,
		i === 0 ? "default" : lang,
	]);

	const localeResources = langDirs.map(
		([lang, dir]) =>
			`  <locale language="${dir}">\n    <resource id="app_strings_${lang}" version="1">\n      <location authority="local">./${dir}/app_strings.txt</location>\n    </resource>\n  </locale>`,
	);

	// `<remote-request>` elements live alongside `<entry>` elements
	// in CCHQ's wire layout — both are top-level entry points the
	// runtime dispatches through. The compiler positions
	// `<remote-request>` before `<entry>` blocks so the rendered
	// suite reads "details for these cases, then the
	// remote-request that fetches them, then the form entries that
	// edit them."
	const remoteRequestsBlock =
		suiteRemoteRequests.length > 0 ? `${suiteRemoteRequests.join("\n")}\n` : "";
	const suiteXml = `<?xml version="1.0"?>\n<suite version="1">\n${suiteResources.join("\n")}\n${localeResources.join("\n")}\n${suiteDetails.join("\n")}\n${remoteRequestsBlock}${suiteEntries.join("\n")}\n${suiteMenus.join("\n")}\n</suite>`;

	// Suite-XML oracle gate. The oracle mirrors CommCare's suite-parse +
	// session-runtime contract — both the fatal-at-parse checks (malformed
	// XML, missing required attributes) AND the parse-clean / runtime-fatal
	// cross-reference checks (a menu command naming no entry, a datum
	// detail-select naming no detail, an `instance('foo')` reference with no
	// declaration). The device's load gate never catches that second class —
	// `Suite::getDetail` / `getEntry` are bare hashtable lookups returning null
	// on a miss — so they detonate later at session runtime. Asserting them here
	// turns a runtime crash on-device into a clear build-time error. The oracle
	// is a generator-totality oracle, not a user gate: a failing suite is a bug
	// in this compiler, never a fixable authoring state, so a non-empty result
	// throws. `appStrings` is fully populated by the module loop above, so its
	// key set is the complete locale registry the oracle resolves `<locale id>`
	// references against. (The oracle's own strict `XMLValidator.validate`
	// subsumes the well-formedness parse-check this replaced.)
	const suiteErrors = validateSuite(suiteXml, new Set(Object.keys(appStrings)));
	if (suiteErrors.length > 0) {
		throw new Error(
			`Generated suite.xml failed the suite oracle:\n${suiteErrors
				.map((e) => `  - ${errorToString(e)}`)
				.join("\n")}`,
		);
	}

	files["suite.xml"] = suiteXml;

	// Per-language app_strings.txt — every language gets the same string
	// table (content isn't translated per-locale; only the default locale
	// is authored).
	const langStrings = Object.entries(appStrings)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	for (const [, dir] of langDirs) {
		files[`${dir}/app_strings.txt`] = langStrings;
	}

	return packageCcz(files);
}

/**
 * Generate the top-level profile.ccpr XML. The `uniqueid` is a fresh
 * UUID every compile — HQ treats each .ccz as a new app version, so
 * stable identity across compiles isn't required (and would defeat
 * HQ's version deduplication).
 */
function generateProfile(appName: string): string {
	return `<?xml version="1.0"?>
<profile xmlns="http://cihi.commcarehq.org/jad"
         version="1"
         uniqueid="${randomUUID()}"
         name="${escapeXml(appName)}"
         update="http://localhost/update">
  <property key="CommCare App Name" value="${escapeXml(appName)}"/>
  <property key="cc-content-version" value="1"/>
  <property key="cc-app-version" value="1"/>
  <features>
    <users active="true"/>
  </features>
  <suite>
    <resource id="suite" version="1" descriptor="Suite Definition">
      <location authority="local">./suite.xml</location>
    </resource>
  </suite>
  <suite>
    <resource id="media-suite" version="1" descriptor="Media Suite Definition">
      <location authority="local">./media_suite.xml</location>
    </resource>
  </suite>
</profile>`;
}

/**
 * CommCare case-transaction XML namespace. Every `<case>` element on the
 * wire lives in this namespace — the submission processor finds case
 * blocks by namespace-qualified match, so a `<case>` outside this xmlns
 * is treated as an inert data node, not a case transaction. The xmlns
 * declaration on `<case>` propagates to its descendants by default-
 * namespace inheritance, so `<create>`, `<update>`, `<close>`, `<index>`,
 * and the per-property children all resolve into the case-transaction
 * namespace without restatement.
 */
const CASE_TRANSACTION_XMLNS = "http://commcarehq.org/case/transaction/v2";

/**
 * Splice case-management XML into an XForm based on the form's
 * `FormActions`. Inserts:
 *   - A `<case>` element (with `<create>`, `<update>`, `<close>` as
 *     applicable) just before `</data>`.
 *   - One `<subcase_{n}>` element per child-case subcase.
 *   - `<bind>` rules wiring each case field to its XForm data path.
 *   - A `commcaresession` instance declaration (owner_id binds read
 *     from it) if one isn't already present.
 *
 * String-template splicing rather than DOM construction is a tradeoff
 * against `lib/commcare/xform/builder.ts`'s structural guarantee. The
 * field-value paths threaded into these templates all flow through the
 * `validateCaseType` / `validatePropertyName` / `validateXFormPath`
 * gates above, which reject any character that could break the template
 * (no `<`, `>`, `&`, `"`, or whitespace in identifiers), and the post-
 * splice `validateXForm` gate parses the result back as XML and
 * structurally checks every bind nodeset. The shape this function emits
 * is small enough (case-transaction scaffolding) that constructing a
 * DOM here would inflate the line count without changing the
 * correctness story; the validation gates close the gap.
 */
function addCaseBlocks(
	xform: string,
	actions: FormActions,
	caseType: string,
): string {
	const openCase = actions.open_case;
	const updateCase = actions.update_case;
	const closeCase = actions.close_case;
	const subcases = actions.subcases;
	const openMode = openCase.condition.type;
	// `isCreate` covers both the always-create (registration) and the
	// conditional-create patterns. CCHQ treats both as active opens — the
	// `if`-typed condition lowers to a `<bind relevant>` on the <case>
	// element so JavaRosa only stamps the case-create on the wire when
	// the condition evaluates true.
	const isCreate = openMode === "always" || openMode === "if";
	const isUpdate = updateCase.condition.type === "always";
	// Single read of the close condition's discriminator — reused below
	// when deciding whether to emit a `relevant` bind.
	const closeMode = closeCase.condition.type;
	const isClose = closeMode === "always" || closeMode === "if";
	const hasSubcases = subcases.length > 0;

	if (!isCreate && !isUpdate && !isClose && !hasSubcases) return xform;

	// Primary case element children + accumulating binds.
	let caseChildren = "";
	const binds: string[] = [];
	const setvalues: string[] = [];

	// Index rule mirrors `commcare-hq/.../app_manager/models.py::Form
	// .session_var_for_action`: subcase indices start at 1 when an
	// `open_case` is active (so the primary is always `_0`), else 0.
	const subcaseIndexOffset = isCreate ? 1 : 0;
	const validatedCaseType = validateCaseType(caseType);

	if (isCreate) {
		// `<create>` children mirror CCHQ's fixture order (case_name,
		// owner_id, case_type) — semantically the case-transaction
		// processor reads by element name, but matching the canonical
		// shape keeps diffs against the Vellum fixtures clean.
		caseChildren +=
			"\n            <create>\n              <case_name/>\n              <owner_id/>\n              <case_type/>\n            </create>";
		binds.push(
			`      <bind nodeset="/data/case/create/case_type" calculate="'${validatedCaseType}'"/>`,
		);
		const namePath = openCase.name_update?.question_path || "/data/name";
		binds.push(
			`      <bind nodeset="/data/case/create/case_name" calculate="${validateXFormPath(namePath)}"/>`,
		);
		// owner_id reads from the always-on meta block (which is itself
		// seeded from session/context at form load). Matching CCHQ's
		// canonical shape — `instance('commcaresession')/session/context/userid`
		// resolves equivalently but the fixture-shape calculate is what
		// CCHQ Vellum emits and what the Vellum round-trip preserves.
		binds.push(
			`      <bind nodeset="/data/case/create/owner_id" calculate="/data/meta/userID"/>`,
		);
		// Wire the form's `/data/case/@case_id` to the session datum
		// `deriveSessionDatums` emits for this same `open_case` action.
		// xforms-ready fires once at form load — the form-side and the
		// session-side both pull their value from the same uuid().
		setvalues.push(
			`      <setvalue ref="/data/case/@case_id" event="xforms-ready" value="instance('commcaresession')/session/data/case_id_new_${validatedCaseType}_0"/>`,
		);
		// Conditional-open forms get a `<bind relevant>` on the case
		// element. Same operator dispatch as the close condition below.
		if (openMode === "if" && openCase.condition.question) {
			binds.push(
				`      <bind nodeset="/data/case" relevant="${conditionToRelevantXPath(openCase.condition)}"/>`,
			);
		}
	} else if (isUpdate || isClose) {
		// Case-update / case-close: no `<create>` block, but the case_id
		// still wires to the case-loading session datum so the case-update
		// block on the wire knows which case it's editing.
		binds.push(
			`      <bind nodeset="/data/case/@case_id" calculate="instance('commcaresession')/session/data/case_id"/>`,
		);
	}

	if (isUpdate && updateCase.update) {
		const props = Object.keys(updateCase.update);
		if (props.length > 0) {
			const propElements = props
				.map((p) => `              <${validatePropertyName(p)}/>`)
				.join("\n");
			caseChildren += `\n            <update>\n${propElements}\n            </update>`;
			for (const [prop, mapping] of Object.entries(updateCase.update)) {
				const validProp = validatePropertyName(prop);
				const qPath = mapping.question_path || `/data/${prop}`;
				binds.push(
					`      <bind nodeset="/data/case/update/${validProp}" calculate="${validateXFormPath(qPath)}"/>`,
				);
			}
		}
	}

	if (isClose) {
		caseChildren += "\n            <close/>";
		// Conditional close requires a `relevant` expression on the
		// <close/> bind; "selected" operators produce `selected(path, answer)`
		// while the default equality operator produces `path = 'answer'`.
		if (closeMode === "if" && closeCase.condition.question) {
			binds.push(
				`      <bind nodeset="/data/case/close" relevant="${conditionToRelevantXPath(closeCase.condition)}"/>`,
			);
		}
	}

	if (isCreate || isUpdate || isClose) {
		// `<case>` carries three attributes JavaRosa needs at submission
		// time: `case_id` (which case this form's outputs target),
		// `date_modified` (the close-out timestamp), and `user_id` (who
		// did the work). The binds above (case_id) and below (date_modified,
		// user_id) populate them from the session and the form's meta block.
		// The `xmlns` attribute places the element in CommCare's case-
		// transaction namespace — the submission processor finds case
		// blocks by namespace-qualified match, so a `<case>` outside the
		// cx2 namespace is treated as an inert data node, not a case
		// transaction. Mirrors `commcare-hq/.../app_manager/xform.py::
		// XFormCaseBlock.elem`'s `{cx2}case` namespaced construction.
		const caseBlock = `          <case case_id="" date_modified="" user_id="" xmlns="${CASE_TRANSACTION_XMLNS}">${caseChildren}\n          </case>`;
		// Emitter guarantees a single top-level `<data>` per form — this
		// `replace` targets that unique occurrence's closing tag.
		xform = xform.replace(/(<\/data>)/, `\n${caseBlock}\n        $1`);

		// `<case>` attribute binds read out of the always-on /data/meta
		// block (populated by setvalues from session/context at form load
		// + on every revalidate for timeEnd). The meta block ships with
		// every Nova-emitted form, so these references resolve.
		binds.push(
			`      <bind nodeset="/data/case/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>`,
		);
		binds.push(
			`      <bind nodeset="/data/case/@user_id" calculate="/data/meta/userID"/>`,
		);
	}

	// Subcases — each child-case creation gets a dedicated element
	// named `subcase_{n}` (or nested under its repeat context).
	for (let sIdx = 0; sIdx < subcases.length; sIdx++) {
		const sc = subcases[sIdx];
		if (sc.condition.type !== "always" && sc.condition.type !== "if") {
			continue;
		}

		const elName = `subcase_${sIdx}`;
		const repeatCtx = sc.repeat_context || "";
		const basePath = repeatCtx ? `${repeatCtx}/${elName}` : `/data/${elName}`;
		const validatedSubcaseType = validateCaseType(sc.case_type);
		const subcaseDatumId = `case_id_new_${validatedSubcaseType}_${sIdx + subcaseIndexOffset}`;

		let scChildren = "";
		// Subcase `<create>` mirrors the primary case's child order
		// (case_name, owner_id, case_type) for fixture parity.
		scChildren +=
			"\n            <create>\n              <case_name/>\n              <owner_id/>\n              <case_type/>\n            </create>";
		binds.push(
			`      <bind nodeset="${basePath}/case/create/case_type" calculate="'${validatedSubcaseType}'"/>`,
		);
		const namePath = sc.name_update?.question_path || `${basePath}/name`;
		binds.push(
			`      <bind nodeset="${basePath}/case/create/case_name" calculate="${validateXFormPath(namePath)}"/>`,
		);
		binds.push(
			`      <bind nodeset="${basePath}/case/create/owner_id" calculate="/data/meta/userID"/>`,
		);

		// Wire the subcase's `@case_id`. When the subcase lives in a
		// repeat, setvalues won't fire per-iteration AND the session
		// datum isn't emitted for repeat-context subcases (CCHQ skips
		// them in `EntriesHelper.get_new_case_id_datums_meta`); each
		// iteration mints its own id via a bare `uuid()` calculate.
		// Mirrors CCHQ's `delay_case_id=True` branch in
		// `XFormCaseBlock.add_create_block`, which routes `case_id='uuid()'`
		// through `add_setvalue_or_bind` to emit a calculate bind.
		if (repeatCtx) {
			binds.push(
				`      <bind nodeset="${basePath}/case/@case_id" calculate="uuid()"/>`,
			);
		} else {
			setvalues.push(
				`      <setvalue ref="${basePath}/case/@case_id" event="xforms-ready" value="instance('commcaresession')/session/data/${subcaseDatumId}"/>`,
			);
		}

		// Index edge back to the parent case. CCHQ's canonical emission
		// (`xform.py::add_index_ref`, fixture `subcase-parent-ref.xml`)
		// omits the `relationship` attribute when the relationship is the
		// default `child`; it only emits the attribute for `extension` and
		// `question`. The bind below reads the parent's case_id off the
		// form's own `<case>` element rather than the session datum
		// directly, so the same shape works whether the parent was opened
		// by this form (registration-with-subcase) or loaded by it
		// (followup-with-subcase) — `/data/case/@case_id` is itself bound
		// to the right session var earlier in this function.
		const subcaseRel = sc.relationship || "child";
		const relAttr =
			subcaseRel === "child" ? "" : ` relationship="${subcaseRel}"`;
		scChildren += `\n            <index>\n              <parent case_type="${validatedCaseType}"${relAttr}/>\n            </index>`;
		binds.push(
			`      <bind nodeset="${basePath}/case/index/parent" calculate="/data/case/@case_id"/>`,
		);

		// Subcase case-attribute binds — same shape as the primary case.
		binds.push(
			`      <bind nodeset="${basePath}/case/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>`,
		);
		binds.push(
			`      <bind nodeset="${basePath}/case/@user_id" calculate="/data/meta/userID"/>`,
		);

		// Conditional subcase create — `<bind relevant>` on the subcase
		// case element.
		if (sc.condition.type === "if" && sc.condition.question) {
			binds.push(
				`      <bind nodeset="${basePath}/case" relevant="${conditionToRelevantXPath(sc.condition)}"/>`,
			);
		}

		if (Object.keys(sc.case_properties).length > 0) {
			const props = Object.entries(sc.case_properties);
			const propElements = props
				.map(([p]) => `              <${validatePropertyName(p)}/>`)
				.join("\n");
			scChildren += `\n            <update>\n${propElements}\n            </update>`;
			for (const [prop, mapping] of props) {
				const validProp = validatePropertyName(prop);
				const qPath = mapping.question_path || `/data/${prop}`;
				// Subcase update binds nest the property under `<case>` — the
				// path is `<subcase_n>/case/update/<prop>`, NOT
				// `<subcase_n>/update/<prop>`. The case element is what wraps
				// the entire case-transaction shape (create / index / update
				// / close); the bind nodeset must match the actual element
				// path or `XFORM_DANGLING_BIND` fires post-injection.
				binds.push(
					`      <bind nodeset="${basePath}/case/update/${validProp}" calculate="${validateXFormPath(qPath)}"/>`,
				);
			}
		}

		// The subcase's `<case>` carries the same three attributes as the
		// primary case (case_id, date_modified, user_id) plus the case-
		// transaction xmlns. Wrapping element (`<subcase_n>`) holds the
		// case element; the case element holds the create/index/update
		// children.
		const wrappedCase = `<case case_id="" date_modified="" user_id="" xmlns="${CASE_TRANSACTION_XMLNS}">${scChildren}\n          </case>`;
		const scBlock = `          <${elName}>\n          ${wrappedCase}\n          </${elName}>`;
		// Same single-top-level-`<data>` invariant as the primary case splice.
		xform = xform.replace(/(<\/data>)/, `\n${scBlock}\n        $1`);
	}

	// Insert the new binds after the last existing <bind> (the emitter
	// always produces at least one bind per form). If there are no
	// binds yet — e.g. a no-field registration — splice just before
	// <itext> or </model>. Emitter guarantees a single top-level
	// `<model>` so the fallback `replace` targets that specific `</model>`.
	const bindStr = binds.join("\n");
	const lastBindIdx = xform.lastIndexOf("</bind>");
	if (lastBindIdx === -1) {
		xform = xform.replace(/(<itext>|<\/model>)/, `${bindStr}\n      $1`);
	} else {
		const afterLastBind = xform.indexOf("\n", lastBindIdx);
		if (afterLastBind !== -1) {
			xform =
				xform.substring(0, afterLastBind + 1) +
				bindStr +
				"\n" +
				xform.substring(afterLastBind + 1);
		}
	}

	// Splice the case-id setvalues into the model just before `<itext>` or
	// `</model>`. The meta block's setvalues are emitted by `buildXForm`
	// upstream of `addCaseBlocks`, so they land before this splice in
	// document order. Both groups fire on their declared events; XForms
	// runs same-event setvalues in document order, and neither group's
	// values depend on the other so the order is correctness-neutral.
	if (setvalues.length > 0) {
		const setvalueStr = setvalues.join("\n");
		xform = xform.replace(/(<itext>|<\/model>)/, `${setvalueStr}\n      $1`);
	}

	// commcaresession is unconditionally declared by `buildXForm`'s
	// always-on meta block (`builder.ts::buildXForm` calls
	// `instances.require("commcaresession")` before any case-block
	// injection happens), so this function assumes the declaration is
	// already present. The owner_id / case_id binds reference the session
	// without further bookkeeping here.

	return xform;
}

/**
 * Build a JavaRosa `relevant` XPath fragment from a `FormActionCondition`.
 * Used for conditional case opens (`<bind nodeset="/data/case" relevant>`),
 * conditional case closes (`<bind nodeset="/data/case/close" relevant>`),
 * and conditional subcase opens.
 *
 * Two shapes per the question's operator:
 *   - `selected`  → `selected(<qPath>, '<answer>')`  — for multi-select
 *     items where the answer is a token within the value list.
 *   - everything else → `<qPath> = '<answer>'`     — equality compare.
 */
function conditionToRelevantXPath(condition: FormActionCondition): string {
	const qPath = validateXFormPath(condition.question ?? "");
	const answer = condition.answer ?? "";
	const op = condition.operator ?? "=";
	return op === "selected"
		? `selected(${qPath}, '${answer}')`
		: `${qPath} = '${answer}'`;
}

/**
 * Pack the collected file map into a ZIP archive and return the
 * in-memory buffer.
 */
function packageCcz(files: Record<string, string>): Buffer {
	const zip = new AdmZip();
	for (const [filePath, content] of Object.entries(files)) {
		zip.addFile(filePath, Buffer.from(content, "utf-8"));
	}
	return zip.toBuffer();
}
