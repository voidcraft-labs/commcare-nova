/**
 * Entity lookup hooks — one hook per entity kind.
 *
 * Each returns the entity for a given uuid, or `undefined` if absent.
 * Accepts `Uuid | undefined` so call sites that derive the uuid from
 * a discriminated union (e.g. `useLocation()`) don't need unsound casts.
 * The returned reference is stable across mutations that don't touch
 * this specific entity (Immer structural sharing).
 */

"use client";

import { useContext } from "react";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import {
	type Field,
	type Form,
	type Module,
	projectLocalizedField,
	projectLocalizedForm,
	projectLocalizedModule,
	type Uuid,
} from "@/lib/domain";
import { useBlueprintDocEq } from "./useBlueprintDoc";

function sameEntity<T>(left: T | undefined, right: T | undefined): boolean {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function useModule(uuid: Uuid | undefined): Module | undefined {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return useBlueprintDocEq(
		(doc) =>
			uuid === undefined
				? undefined
				: language === null
					? doc.modules[uuid]
					: projectLocalizedModule(doc, language, uuid),
		sameEntity,
	);
}

export function useForm(uuid: Uuid | undefined): Form | undefined {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return useBlueprintDocEq(
		(doc) =>
			uuid === undefined
				? undefined
				: language === null
					? doc.forms[uuid]
					: projectLocalizedForm(doc, language, uuid),
		sameEntity,
	);
}

export function useField(uuid: Uuid | undefined): Field | undefined {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return useBlueprintDocEq(
		(doc) =>
			uuid === undefined
				? undefined
				: language === null
					? doc.fields[uuid]
					: projectLocalizedField(doc, language, uuid),
		sameEntity,
	);
}
