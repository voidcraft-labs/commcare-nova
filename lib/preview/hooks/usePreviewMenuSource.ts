"use client";

import { useMemo } from "react";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type LanguageTag,
} from "@/lib/domain";
import {
	type NavigationMedia,
	navigationFilesInLanguage,
} from "@/lib/domain/navigationMedia";
import { recordFromEntries } from "@/lib/domain/records";
import { pickBlueprintDoc } from "../engine/caseDataBindingClient";
import type { PreviewMenuSource } from "../menuProjection";

const EMPTY_CASE_TYPES: PreviewMenuSource["caseTypes"] = [];

/** The actual immutable document and its menu slices, used together for slot-aware navigation. */
export function usePreviewMenuSource(
	language?: LanguageTag,
): PreviewMenuSource & {
	readonly doc: BlueprintDoc;
} {
	// Results and Details send this document to a Server Action. Store methods,
	// history flags and store-only indexes are not document fields; shallow selection also
	// keeps their updates from restarting an unchanged case-data request.
	const doc = useBlueprintDocShallow(pickBlueprintDoc);
	return useMemo(() => {
		const app = effectiveAppLocalization(doc.localization);
		function projected<T extends NavigationMedia>(carrier: T): T {
			if (!language || !carrier.mediaByLanguage) return carrier;
			return {
				...carrier,
				...navigationFilesInLanguage(carrier, language, app),
			};
		}
		const modules = !language
			? doc.modules
			: recordFromEntries(
					Object.entries(doc.modules).map(([id, mod]) => {
						const register = mod.caseListRegistrationForm;
						const tile = projected(mod),
							item = mod.caseListMenuItem && projected(mod.caseListMenuItem);
						const action =
							register?.kind === "always" ? projected(register) : register;
						return [
							id,
							item === mod.caseListMenuItem && action === register
								? tile
								: {
										...tile,
										...(item && { caseListMenuItem: item }),
										...(action && { caseListRegistrationForm: action }),
									},
						];
					}),
				);
		const forms = !language
			? doc.forms
			: recordFromEntries(
					Object.entries(doc.forms).map(([id, form]) => [id, projected(form)]),
				);
		return {
			doc,
			modules,
			forms,
			moduleOrder: doc.moduleOrder,
			caseTypes: doc.caseTypes ?? EMPTY_CASE_TYPES,
			formOrder: doc.formOrder,
		};
	}, [doc, language]);
}
