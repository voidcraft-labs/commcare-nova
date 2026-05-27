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
import { escapeXml, type HqApplication } from "@/lib/commcare";
import { deriveEntryDefinition, renderEntryXml } from "@/lib/commcare/session";
import { emitLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import { emitShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { emitRemoteRequest } from "@/lib/commcare/suite/case-search/remoteRequest";
import { errorToString } from "@/lib/commcare/validator/errors";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";
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
			// malformed structure introduced by the splice. The oracle
			// is a generator-totality check, not a user gate: a failing
			// XForm here is a compiler bug (the case-block splice
			// produced malformed structure), never a fixable authoring
			// state. Authoring rejection lives in the doc-layer rules
			// (`validator/rules/`); install-time-resolution rejection
			// (`#case/<X>` on a registration form, the original failure
			// shape of this gap) lives in `caseHashtagOnCreateForm`
			// (`validator/rules/form.ts`). The binding-resolution oracle
			// (`validator/bindingResolutionOracle.ts`) stays a fuzz-time
			// totality proof — it asserts that every doc the authoring
			// validator accepts compiles to a CCZ whose XPath references
			// all resolve — and is not invoked here.
			if (xform) {
				const xformErrors = validateXForm(xform, formName, modName);
				if (xformErrors.length > 0) {
					throw new Error(
						`XForm validation failed for "${formName}" in "${modName}" after case block injection:\n` +
							xformErrors.map((e) => `  - ${errorToString(e)}`).join("\n"),
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
