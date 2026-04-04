import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import {
	escapeXml,
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
} from "./commcare";
import type {
	DetailColumn,
	FormActions,
	HqApplication,
} from "./commcare/hqTypes";
import {
	deriveEntryDefinition,
	fromHqWorkflow,
	renderEntryXml,
} from "./commcare/session";
import { errorToString } from "./commcare/validate/errors";
import { validateXFormXml } from "./commcare/validate/xformValidator";

/**
 * Compiles HQ import JSON into a .ccz archive for deployment.
 * Generates suite.xml, profile.ccpr, app_strings.txt, and adds case blocks to XForms.
 *
 * Validates every XForm after case block injection to catch orphaned binds,
 * dangling refs, and other structural issues before packaging.
 */
export class CczCompiler {
	async compile(hqJson: HqApplication, appName: string): Promise<Buffer> {
		const modules = hqJson.modules || [];
		const attachments = hqJson._attachments || {};

		// Generate all CCZ files
		const files: Record<string, string> = {};

		files["profile.ccpr"] = this.generateProfile(appName);
		files["media_suite.xml"] = '<?xml version="1.0"?>\n<suite version="1"/>';

		const appStrings: Record<string, string> = { "app.name": appName };
		const suiteEntries: string[] = [];
		const suiteMenus: string[] = [];
		const suiteDetails: string[] = [];
		const suiteResources: string[] = [];

		for (let mIdx = 0; mIdx < modules.length; mIdx++) {
			const mod = modules[mIdx];
			const modName = mod.name?.en || `Module ${mIdx}`;
			const caseType = mod.case_type || "";
			const forms = mod.forms || [];

			appStrings[`modules.m${mIdx}`] = modName;

			// Case detail definitions (if module uses cases)
			if (caseType) {
				appStrings.case_list_title = appStrings.case_list_title || `${modName}`;

				suiteDetails.push(
					this.generateDetail(
						`m${mIdx}_case_short`,
						"short",
						mod.case_details?.short?.columns || [],
					),
				);
				suiteDetails.push(
					this.generateDetail(
						`m${mIdx}_case_long`,
						"long",
						mod.case_details?.long?.columns || [],
					),
				);

				// Add column headers to app_strings (short + long details)
				for (const detail of [
					mod.case_details?.short,
					mod.case_details?.long,
				]) {
					const columns = detail?.columns || [];
					for (const col of columns) {
						const headerKey = `m${mIdx}_${col.field}_header`;
						appStrings[headerKey] = col.header?.en || col.field;
					}
				}
			}

			const menuCommands: string[] = [];

			for (let fIdx = 0; fIdx < forms.length; fIdx++) {
				const form = forms[fIdx];
				const formName = form.name?.en || `Form ${fIdx}`;
				const xmlns = form.xmlns || "";
				const uniqueId = form.unique_id || "";
				const requires = form.requires || "none";
				const cmdId = `m${mIdx}-f${fIdx}`;
				const filePath = `modules-${mIdx}/forms-${fIdx}.xml`;

				appStrings[`forms.m${mIdx}f${fIdx}`] = formName;

				// Get the clean XForm from _attachments and add case blocks
				let xform = attachments[`${uniqueId}.xml`] || "";
				if (xform && caseType) {
					xform = this.addCaseBlocks(xform, form.actions, caseType);
				}

				// Validate the final XForm after case injection
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

				// Resource declaration
				suiteResources.push(
					`  <xform>\n    <resource id="${filePath}" version="1">\n      <location authority="local">./${filePath}</location>\n    </resource>\n  </xform>`,
				);

				// Entry — derived from session module (datums + post-submit stack)
				const postSubmit = fromHqWorkflow(form.post_form_workflow || "default");
				const formType =
					requires === "case"
						? ("followup" as const)
						: ("registration" as const);
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

		// Build locale resources and app_strings for each language
		const langs: string[] = hqJson.langs || ["en"];
		const localeResources = langs.map((lang) => {
			const langDir = lang === langs[0] ? "default" : lang;
			return `  <locale language="${lang === langs[0] ? "default" : lang}">\n    <resource id="app_strings_${lang}" version="1">\n      <location authority="local">./${langDir}/app_strings.txt</location>\n    </resource>\n  </locale>`;
		});

		const suiteXml = `<?xml version="1.0"?>\n<suite version="1">\n${suiteResources.join("\n")}\n${localeResources.join("\n")}\n${suiteDetails.join("\n")}\n${suiteEntries.join("\n")}\n${suiteMenus.join("\n")}\n</suite>`;

		// Validate suite.xml is well-formed
		try {
			const { parseDocument } = await import("htmlparser2");
			parseDocument(suiteXml, { xmlMode: true });
		} catch (e) {
			throw new Error(
				`Generated suite.xml is malformed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}

		files["suite.xml"] = suiteXml;

		// Build per-language app_strings.txt files
		for (const lang of langs) {
			const langDir = lang === langs[0] ? "default" : lang;
			const langStrings = Object.entries(appStrings)
				.map(([k, v]) => `${k}=${v}`)
				.join("\n");
			files[`${langDir}/app_strings.txt`] = langStrings;
		}

		// Package into CCZ and return as Buffer
		return this.packageCcz(files, appName);
	}

	private generateProfile(appName: string): string {
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

	private generateDetail(
		id: string,
		display: string,
		columns: DetailColumn[],
	): string {
		if (columns.length === 0 && display === "long") {
			return `  <detail id="${id}">\n    <title><text><locale id="case_list_title"/></text></title>\n  </detail>`;
		}

		const fields = columns.map((col) => {
			const field = col.field || "name";
			const _header = col.header?.en || field;
			return `    <field>\n      <header><text><locale id="${id}_${field}_header"/></text></header>\n      <template><text><xpath function="${field}"/></text></template>\n    </field>`;
		});

		return `  <detail id="${id}">\n    <title><text><locale id="case_list_title"/></text></title>\n${fields.join("\n")}\n  </detail>`;
	}

	/** Add case blocks back into an XForm based on form actions (for mobile runtime). */
	private addCaseBlocks(
		xform: string,
		actions: FormActions,
		caseType: string,
	): string {
		if (!actions) return xform;

		const openCase = actions.open_case;
		const updateCase = actions.update_case;
		const closeCase = actions.close_case;
		const subcases = actions.subcases || [];
		const isCreate = openCase?.condition?.type === "always";
		const isUpdate = updateCase?.condition?.type === "always";
		const isClose =
			closeCase?.condition?.type === "always" ||
			closeCase?.condition?.type === "if";
		const hasSubcases = subcases.length > 0;

		if (!isCreate && !isUpdate && !isClose && !hasSubcases) return xform;

		// Build case data element
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
			if (closeCase.condition.type === "if" && closeCase.condition.question) {
				const qPath = validateXFormPath(closeCase.condition.question);
				const answer = closeCase.condition.answer || "";
				binds.push(
					`      <bind nodeset="/data/case/close" relevant="${qPath} = '${answer}'"/>`,
				);
			}
		}

		if (isCreate || isUpdate || isClose) {
			const caseBlock = `          <case>${caseChildren}\n          </case>`;
			xform = xform.replace(/(<\/data>)/, `\n${caseBlock}\n        $1`);
		}

		// Subcases — each gets its own case element
		for (let sIdx = 0; sIdx < subcases.length; sIdx++) {
			const sc = subcases[sIdx];
			if (sc.condition?.type !== "always") continue;

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

			// Parent index
			scChildren += `\n            <index>\n              <parent case_type="${validateCaseType(caseType)}" relationship="${sc.relationship || "child"}"/>\n            </index>`;

			// Child case properties
			if (sc.case_properties && Object.keys(sc.case_properties).length > 0) {
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
			xform = xform.replace(/(<\/data>)/, `\n${scBlock}\n        $1`);
		}

		// Insert case binds after the last existing <bind>
		const bindStr = binds.join("\n");
		const lastBindIdx = xform.lastIndexOf("</bind>");
		if (lastBindIdx === -1) {
			// No existing binds, insert before <itext> or </model>
			xform = xform.replace(/(<itext>|<\/model>)/, `${bindStr}\n      $1`);
		} else {
			// Find the end of the last bind's line
			const afterLastBind = xform.indexOf("\n", lastBindIdx);
			if (afterLastBind !== -1) {
				xform =
					xform.substring(0, afterLastBind + 1) +
					bindStr +
					"\n" +
					xform.substring(afterLastBind + 1);
			}
		}

		// Add commcaresession instance if not present
		if (!xform.includes('id="commcaresession"')) {
			xform = xform.replace(
				/(<\/instance>)/,
				`$1\n      <instance id="commcaresession" src="jr://instance/session"/>`,
			);
		}

		return xform;
	}

	private packageCcz(files: Record<string, string>, _appName: string): Buffer {
		const zip = new AdmZip();
		for (const [filePath, content] of Object.entries(files)) {
			zip.addFile(filePath, Buffer.from(content, "utf-8"));
		}
		return zip.toBuffer();
	}
}
