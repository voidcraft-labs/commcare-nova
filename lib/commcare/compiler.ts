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
import { parseDocument } from "htmlparser2";
import {
	type DetailColumn,
	escapeXml,
	type FormActions,
	type HqApplication,
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare";
import {
	deriveEntryDefinition,
	fromHqWorkflow,
	renderEntryXml,
} from "@/lib/commcare/session";
import { errorToString } from "@/lib/commcare/validator/errors";
import { validateXFormXml } from "@/lib/commcare/validator/xformValidator";
import type { BlueprintDoc } from "@/lib/domain";

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

	// Walk HQ modules and `doc.moduleOrder` in lockstep. `expandDoc`
	// produces HQ modules in the same order as `moduleOrder`, so
	// `doc.modules[doc.moduleOrder[mIdx]]` is the domain twin of
	// `hqModules[mIdx]`.
	for (let mIdx = 0; mIdx < hqModules.length; mIdx++) {
		const hqMod = hqModules[mIdx];
		const moduleUuid = doc.moduleOrder[mIdx];
		const formUuids = doc.formOrder[moduleUuid] ?? [];

		const modName = hqMod.name.en;
		const caseType = hqMod.case_type;
		const hqForms = hqMod.forms;

		appStrings[`modules.m${mIdx}`] = modName;

		// Case detail definitions — emitted only when the module has a case
		// type. Short + long details are always paired; headers for every
		// column (from either detail) land in `appStrings`.
		if (caseType) {
			appStrings.case_list_title = appStrings.case_list_title || `${modName}`;

			suiteDetails.push(
				generateDetail(
					`m${mIdx}_case_short`,
					"short",
					hqMod.case_details.short.columns,
				),
			);
			suiteDetails.push(
				generateDetail(
					`m${mIdx}_case_long`,
					"long",
					hqMod.case_details.long.columns,
				),
			);

			for (const detail of [
				hqMod.case_details.short,
				hqMod.case_details.long,
			]) {
				for (const col of detail.columns) {
					const headerKey = `m${mIdx}_${col.field}_header`;
					appStrings[headerKey] = col.header.en || col.field;
				}
			}
		}

		const menuCommands: string[] = [];

		for (let fIdx = 0; fIdx < hqForms.length; fIdx++) {
			const hqForm = hqForms[fIdx];
			const formUuid = formUuids[fIdx];
			// Form type lives only on the domain doc — the HQ wire shape
			// doesn't persist the (registration|followup|close|survey)
			// discriminator, so we read it here to drive session-entry
			// derivation.
			const formType = doc.forms[formUuid].type;

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

			// Re-validate after injection — catches orphaned binds or
			// malformed structure introduced by the splice.
			if (xform) {
				const xformErrors = validateXFormXml(xform, formName, modName);
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

			// Entry — `deriveEntryDefinition` builds the datum + post-submit
			// stack from the form's type, its post-form-workflow, and the
			// module's case type.
			const postSubmit = fromHqWorkflow(hqForm.post_form_workflow);
			const entryDef = deriveEntryDefinition(
				xmlns,
				mIdx,
				fIdx,
				formType,
				postSubmit,
				caseType || undefined,
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

	const suiteXml = `<?xml version="1.0"?>\n<suite version="1">\n${suiteResources.join("\n")}\n${localeResources.join("\n")}\n${suiteDetails.join("\n")}\n${suiteEntries.join("\n")}\n${suiteMenus.join("\n")}\n</suite>`;

	// Parse-check the suite XML — HQ's build pipeline also parses it,
	// and failing here gives a clearer error than an opaque mobile
	// deployment failure. `parseDocument` throws on malformed XML.
	try {
		parseDocument(suiteXml, { xmlMode: true });
	} catch (e) {
		throw new Error(
			`Generated suite.xml is malformed: ${e instanceof Error ? e.message : String(e)}`,
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
 * Render a single `<detail>` block for suite.xml. The short detail
 * with zero columns still needs a `<title>`; the long detail with
 * zero columns collapses to a title-only stub.
 */
function generateDetail(
	id: string,
	display: string,
	columns: DetailColumn[],
): string {
	if (columns.length === 0 && display === "long") {
		return `  <detail id="${id}">\n    <title><text><locale id="case_list_title"/></text></title>\n  </detail>`;
	}

	const fields = columns.map((col) => {
		const field = col.field || "name";
		return `    <field>\n      <header><text><locale id="${id}_${field}_header"/></text></header>\n      <template><text><xpath function="${field}"/></text></template>\n    </field>`;
	});

	return `  <detail id="${id}">\n    <title><text><locale id="case_list_title"/></text></title>\n${fields.join("\n")}\n  </detail>`;
}

/**
 * Splice case-management XML into an XForm based on the form's
 * `FormActions`. Inserts:
 *   - A `<case>` element (with `<create>`, `<update>`, `<close>` as
 *     applicable) just before `</data>`.
 *   - One `<subcase_{n}>` element per child-case subcase.
 *   - `<bind>` rules wiring each case field to its question path.
 *   - A `commcaresession` instance declaration (owner_id binds read
 *     from it) if one isn't already present.
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
	const isCreate = openCase.condition.type === "always";
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

	if (isCreate) {
		caseChildren +=
			"\n            <create>\n              <case_type/>\n              <case_name/>\n              <owner_id/>\n            </create>";
		binds.push(
			`      <bind nodeset="/data/case/create/case_type" calculate="'${validateCaseType(caseType)}'"/>`,
		);
		const namePath = openCase.name_update?.question_path || "/data/name";
		binds.push(
			`      <bind nodeset="/data/case/create/case_name" calculate="${validateXFormPath(namePath)}"/>`,
		);
		binds.push(
			`      <bind nodeset="/data/case/create/owner_id" calculate="instance('commcaresession')/session/context/userid"/>`,
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
			const qPath = validateXFormPath(closeCase.condition.question);
			const answer = closeCase.condition.answer || "";
			const op = closeCase.condition.operator ?? "=";
			const relevantExpr =
				op === "selected"
					? `selected(${qPath}, '${answer}')`
					: `${qPath} = '${answer}'`;
			binds.push(
				`      <bind nodeset="/data/case/close" relevant="${relevantExpr}"/>`,
			);
		}
	}

	if (isCreate || isUpdate || isClose) {
		const caseBlock = `          <case>${caseChildren}\n          </case>`;
		// Emitter guarantees a single top-level `<data>` per form — this
		// `replace` targets that unique occurrence's closing tag.
		xform = xform.replace(/(<\/data>)/, `\n${caseBlock}\n        $1`);
	}

	// Subcases — each child-case creation gets a dedicated element
	// named `subcase_{n}` (or nested under its repeat context).
	for (let sIdx = 0; sIdx < subcases.length; sIdx++) {
		const sc = subcases[sIdx];
		if (sc.condition.type !== "always") continue;

		const elName = `subcase_${sIdx}`;
		const repeatCtx = sc.repeat_context || "";
		const basePath = repeatCtx ? `${repeatCtx}/${elName}` : `/data/${elName}`;

		let scChildren = "";
		scChildren +=
			"\n            <create>\n              <case_type/>\n              <case_name/>\n              <owner_id/>\n            </create>";
		binds.push(
			`      <bind nodeset="${basePath}/create/case_type" calculate="'${validateCaseType(sc.case_type)}'"/>`,
		);
		const namePath = sc.name_update?.question_path || `${basePath}/name`;
		binds.push(
			`      <bind nodeset="${basePath}/create/case_name" calculate="${validateXFormPath(namePath)}"/>`,
		);
		binds.push(
			`      <bind nodeset="${basePath}/create/owner_id" calculate="instance('commcaresession')/session/context/userid"/>`,
		);

		// Index edge back to the parent case — relationship is "child" or
		// "extension" depending on the subcase configuration.
		scChildren += `\n            <index>\n              <parent case_type="${validateCaseType(caseType)}" relationship="${sc.relationship || "child"}"/>\n            </index>`;

		if (Object.keys(sc.case_properties).length > 0) {
			const props = Object.entries(sc.case_properties);
			const propElements = props
				.map(([p]) => `              <${validatePropertyName(p)}/>`)
				.join("\n");
			scChildren += `\n            <update>\n${propElements}\n            </update>`;
			for (const [prop, mapping] of props) {
				const validProp = validatePropertyName(prop);
				const qPath = mapping.question_path || `/data/${prop}`;
				binds.push(
					`      <bind nodeset="${basePath}/update/${validProp}" calculate="${validateXFormPath(qPath)}"/>`,
				);
			}
		}

		const scBlock = `          <${elName}>${scChildren}\n          </${elName}>`;
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

	// owner_id binds reference `instance('commcaresession')` — declare
	// that instance if the emitter didn't already. Emitter always
	// produces at least one `<instance>`, so `</instance>` exists and
	// this `replace` targets its first occurrence.
	if (!xform.includes('id="commcaresession"')) {
		xform = xform.replace(
			/(<\/instance>)/,
			`$1\n      <instance id="commcaresession" src="jr://instance/session"/>`,
		);
	}

	return xform;
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
