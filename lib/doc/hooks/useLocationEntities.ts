"use client";

import { useBlueprintDocShallow } from "./useBlueprintDoc";

/** The identity maps used to recover a peer's selected location. */
export function useLocationEntities() {
	return useBlueprintDocShallow((state) => ({
		modules: state.modules,
		forms: state.forms,
		fields: state.fields,
	}));
}
