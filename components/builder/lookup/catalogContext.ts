"use client";
import { createContext, useContext } from "react";
import type { EditorLookupTableDecl } from "@/components/builder/shared/lookupTablePresentation";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { LookupTableDefinition } from "@/lib/lookup/types";

export type BuilderLookupCatalog =
	| {
			readonly kind: "unmanaged";
			readonly lookupContext: LookupValidationContext;
	  }
	| {
			readonly kind: "loading";
			readonly lookupContext: LookupValidationContext;
	  }
	| {
			readonly kind: "error";
			readonly message: string;
			readonly retry: () => Promise<void>;
			readonly lookupContext: LookupValidationContext;
	  }
	| {
			readonly kind: "ready";
			readonly definitions: readonly LookupTableDefinition[];
			readonly tables: readonly EditorLookupTableDecl[];
			readonly byId: ReadonlyMap<
				EditorLookupTableDecl["id"],
				EditorLookupTableDecl
			>;
			readonly lookupContext: LookupValidationContext;
			readonly retry: () => Promise<void>;
	  };

export const BuilderLookupCatalogContext = createContext<BuilderLookupCatalog>({
	kind: "unmanaged",
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});

export function useBuilderLookupCatalog(): BuilderLookupCatalog {
	return useContext(BuilderLookupCatalogContext);
}
