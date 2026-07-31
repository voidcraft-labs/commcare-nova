"use client";

import { createContext, useContext } from "react";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "./lookupReferences";

export type LookupCommitState =
	| {
			readonly kind: "unmanaged";
			readonly lookupContext: LookupValidationContext;
	  }
	| {
			readonly kind: "loading" | "error";
			readonly lookupContext: LookupValidationContext;
	  }
	| {
			readonly kind: "ready";
			readonly lookupContext: LookupValidationContext;
	  };

export const LookupCommitContext = createContext<LookupCommitState>({
	kind: "unmanaged",
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});

export function useLookupCommitState(): LookupCommitState {
	return useContext(LookupCommitContext);
}
