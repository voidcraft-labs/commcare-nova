// lib/preview/engine/caseDataBinding.ts
//
// Server Actions for the running-app view's case-data binding.
// Each action resolves the request's session, constructs a
// tenant-scoped `CaseStore` via `withOwnerContext(session.user.id)`,
// and delegates to a pure helper in `./caseDataBindingHelpers.ts`.
// Tests bypass the actions and inject a `CaseStore` directly.
// Centralizing session resolution here means a change to the auth
// strategy lands in one file.

"use server";

import { getSession } from "@/lib/auth-utils";
import { withOwnerContext } from "@/lib/case-store";
import type { BlueprintDoc } from "@/lib/domain";
import {
	mapPopulateSampleCasesError,
	readCaseData,
	readCases,
	seedSampleCases,
} from "./caseDataBindingHelpers";
import type {
	LoadCaseDataResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
} from "./caseDataBindingTypes";

// Errors thrown by the case-store layer are caught and mapped to
// the `{ kind: "error" }` arm so an unhandled throw never tears
// down Next's RSC tree.

export async function loadCasesAction(
	appId: string,
	caseType: string,
): Promise<LoadCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await readCases(store, { appId, caseType });
	} catch (err) {
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load cases.",
		};
	}
}

export async function loadCaseDataAction(
	appId: string,
	caseType: string,
	caseId: string,
): Promise<LoadCaseDataResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await readCaseData(store, { appId, caseType, caseId });
	} catch (err) {
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load case.",
		};
	}
}

export async function populateSampleCasesAction(
	appId: string,
	caseType: string,
	blueprint: BlueprintDoc,
): Promise<PopulateSampleCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await seedSampleCases(store, { appId, caseType, blueprint });
	} catch (err) {
		return mapPopulateSampleCasesError(err);
	}
}
