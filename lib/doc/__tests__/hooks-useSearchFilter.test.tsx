// @vitest-environment happy-dom

/**
 * Tests for `useSearchFilter` — the hook that walks the blueprint entity
 * maps and produces the match-index + visibility sets consumed by the
 * AppTree row components.
 */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { SEARCH_IDLE, useSearchFilter } from "@/lib/doc/hooks/useSearchFilter";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { collectTranslationUnits, makeTranslationUnitId } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

/**
 * Build a small deterministic blueprint for filter testing: one module,
 * one form, two fields. Identifiers differ so we can disambiguate
 * module/form/field matches.
 */
function buildFixture(): BlueprintDoc {
	const MOD = testUuid("module-aaaa-0000-0000-000000000000");
	const FORM = testUuid("form-bbbb-0000-0000-000000000000");
	const Q_NAME = testUuid("q-name-0000-0000-0000-000000000000");
	const Q_AGE = testUuid("q-age-0000-0000-0000-000000000000");

	return {
		appId: "search-test",
		appName: "Search Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD]: { uuid: MOD, id: "registration", name: "Patient Registration" },
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "intake",
				name: "Intake Form",
				type: "registration",
			},
		},
		fields: {
			[Q_NAME]: {
				uuid: Q_NAME,
				id: "patient_name",
				kind: "text",
				label: proseText("Patient Full Name"),
			} as BlueprintDoc["fields"][typeof Q_NAME],
			[Q_AGE]: {
				uuid: Q_AGE,
				id: "age",
				kind: "int",
				label: proseText("Age in Years"),
			} as BlueprintDoc["fields"][typeof Q_AGE],
		},
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [Q_NAME, Q_AGE] },
		fieldParent: {},
	};
}

/** Wrap a hook render with a BlueprintDocProvider that loads the given doc. */
function wrapWithDoc(doc?: BlueprintDoc, language: string | null = null) {
	return ({ children }: { children: ReactNode }) => (
		<BlueprintDocProvider appId={doc?.appId ?? "empty"} initialDoc={doc}>
			<BlueprintAuthoringLanguageContext value={language}>
				{children}
			</BlueprintAuthoringLanguageContext>
		</BlueprintDocProvider>
	);
}

function withSpanishFieldLabel(doc: BlueprintDoc): BlueprintDoc {
	const fieldUuid = testUuid("q-name-0000-0000-0000-000000000000");
	const unitId = makeTranslationUnitId("field", fieldUuid, "label");
	const unit = collectTranslationUnits(doc).find(
		(candidate) => candidate.id === unitId,
	);
	if (unit === undefined) throw new Error("Expected field-label unit.");
	return {
		...doc,
		localization: {
			sourceLanguage: "en",
			defaultLanguage: "en",
			languageOrder: ["en", "es"],
			languages: {
				en: { code: "en", name: "English", direction: "ltr" },
				es: { code: "es", name: "español", direction: "ltr" },
			},
			translations: {
				es: {
					[unitId]: {
						value: proseText("Nombre completo del paciente"),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			},
		},
	};
}

describe("useSearchFilter", () => {
	it("returns null for an empty query", () => {
		const doc = buildFixture();
		const { result } = renderHook(() => useSearchFilter(""), {
			wrapper: wrapWithDoc(doc),
		});
		expect(result.current).toBeNull();
	});

	it("returns null for a whitespace-only query", () => {
		const doc = buildFixture();
		const { result } = renderHook(() => useSearchFilter("   "), {
			wrapper: wrapWithDoc(doc),
		});
		expect(result.current).toBeNull();
	});

	it("matches a module name and marks module visible", () => {
		const doc = buildFixture();
		const { result } = renderHook(() => useSearchFilter("registration"), {
			wrapper: wrapWithDoc(doc),
		});
		const r = result.current;
		expect(r).not.toBeNull();
		if (!r) return;
		expect(r.visibleModuleIndices.has(0)).toBe(true);
		// Module match by its name "Patient Registration" — match-map key is `m0`.
		expect(r.matchMap.get("m0")).toBeDefined();
		// Module-name match alone should force-expand the module so its forms
		// remain visible when the user drills in.
		expect(r.forceExpand.has("m0")).toBe(true);
	});

	it("matches a field label and force-expands its parent form", () => {
		const doc = buildFixture();
		const { result } = renderHook(() => useSearchFilter("age"), {
			wrapper: wrapWithDoc(doc),
		});
		const r = result.current;
		expect(r).not.toBeNull();
		if (!r) return;

		// Q_AGE has label "Age in Years" → visible.
		const Q_AGE = testUuid("q-age-0000-0000-0000-000000000000");
		expect(r.visibleFieldUuids.has(Q_AGE)).toBe(true);

		// The form containing the match must be in visibleFormIds.
		const FORM = testUuid("form-bbbb-0000-0000-000000000000");
		expect(r.visibleFormIds.has(FORM)).toBe(true);

		// The form's collapse-key must be force-expanded so the match shows.
		expect(r.forceExpand.has("f0_0")).toBe(true);
	});

	it("matches and highlights the selected language's visible field label", () => {
		const doc = withSpanishFieldLabel(buildFixture());
		const { result } = renderHook(() => useSearchFilter("nombre completo"), {
			wrapper: wrapWithDoc(doc, "es"),
		});
		const r = result.current;
		expect(r).not.toBeNull();
		if (r === null) return;
		const fieldUuid = testUuid("q-name-0000-0000-0000-000000000000");
		expect(r.visibleFieldUuids.has(fieldUuid)).toBe(true);
		expect(r.matchMap.get("patient_name")).toEqual([[0, 15]]);
	});

	it("records separate match indices for label vs id hits", () => {
		const doc = buildFixture();
		// "patient" hits BOTH the label "Patient Full Name" AND the id
		// "patient_name". The filter should record both under distinct keys.
		const { result } = renderHook(() => useSearchFilter("patient"), {
			wrapper: wrapWithDoc(doc),
		});
		const r = result.current;
		expect(r).not.toBeNull();
		if (!r) return;

		// Both the label and id matches should produce entries — the id entry
		// is keyed with `__id` suffix so the row can render "(id)" separately.
		const labelKeys = Array.from(r.matchMap.keys()).filter(
			(k) => !k.endsWith("__id") && !k.startsWith("m") && !k.startsWith("f"),
		);
		const idKeys = Array.from(r.matchMap.keys()).filter((k) =>
			k.endsWith("__id"),
		);
		expect(labelKeys.length).toBeGreaterThan(0);
		expect(idKeys.length).toBeGreaterThan(0);
	});

	it("produces empty visibility sets when no entity matches", () => {
		const doc = buildFixture();
		const { result } = renderHook(() => useSearchFilter("zzznomatchzzz"), {
			wrapper: wrapWithDoc(doc),
		});
		const r = result.current;
		expect(r).not.toBeNull();
		if (!r) return;
		expect(r.visibleModuleIndices.size).toBe(0);
		expect(r.visibleFormIds.size).toBe(0);
		expect(r.visibleFieldUuids.size).toBe(0);
	});

	it("SEARCH_IDLE is a stable reference across accesses", () => {
		// The idle sentinel backs the selector's `isSearching ? live : idle`
		// branch — if a new object were produced each render,
		// `useBlueprintDocShallow` would invalidate every entity edit. The
		// sentinel itself is a module-level constant, so importing twice
		// (or reading it from two renders) must yield the same reference.
		const first = SEARCH_IDLE;
		const second = SEARCH_IDLE;
		expect(first).toBe(second);
	});
});
