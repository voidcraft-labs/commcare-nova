/**
 * Rule: when `caseSearchConfig` is present, the module must also
 * carry a `caseType`.
 *
 * The CCHQ wire layer's `<remote-request>` carries a mandatory
 * `<data key="case_type" ref="'<type>'"/>` slot — without a case
 * type, the orchestrator at
 * `lib/commcare/suite/case-search/remoteRequest.ts::emitRemoteRequest`
 * throws at wire-emission time. The HQ JSON projection at
 * `lib/commcare/hqJson/caseList.ts::projectDefaultProperties` also
 * short-circuits the simple-arm cross-walk derivation when
 * `caseType` is undefined, silently dropping every cross-walk simple
 * input from the uploaded app.
 *
 * Surfacing the structural error at validation time gives the author
 * a clean signal — open the module editor and set a case type, or
 * remove the `caseSearchConfig` — rather than an upload-time error
 * or a silent wire-emission drop. This rule short-circuits cleanly
 * when `caseSearchConfig` is absent (no `<remote-request>` is
 * emitted, no case-type slot is required).
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function caseSearchConfigRequiresCaseType(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseSearchConfig) return [];
	if (mod.caseType !== undefined && mod.caseType !== "") return [];
	return [
		validationError(
			"CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE",
			"module",
			`Module "${mod.name}" carries a \`caseSearchConfig\` but has no \`caseType\` — the search can't run without one. Set a case type to the kind of case this search should return, or remove \`caseSearchConfig\`.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}
