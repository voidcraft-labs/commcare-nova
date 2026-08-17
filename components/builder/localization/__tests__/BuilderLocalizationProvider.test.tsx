// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	BuilderLocalizationProvider,
	useBuilderLanguage,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useField, useForm, useModule } from "@/lib/doc/hooks/useEntity";
import {
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	BlueprintDocProvider,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import {
	type BlueprintDoc,
	collectTranslationUnits,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";

const APP_ID = "localized-builder-provider";
const MODULE = testUuid("localized-provider-module");
const FORM = testUuid("localized-provider-form");
const FIELD = testUuid("localized-provider-field");
let store: BlueprintDocStore | undefined;

function fixture(): BlueprintDoc {
	const doc: BlueprintDoc = {
		appId: APP_ID,
		appName: "Care visits",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE]: { uuid: MODULE, id: "visits", name: "Visits" },
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "visit",
				name: "Visit",
				type: "survey",
			},
		},
		fields: {
			[FIELD]: {
				uuid: FIELD,
				id: "client_name",
				kind: "text",
				label: proseText("Client name"),
			},
		},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
		fieldParent: {},
	};
	const translations = Object.fromEntries(
		collectTranslationUnits(doc).map((unit) => {
			const value =
				unit.id === makeTranslationUnitId("app", "name")
					? "Visitas de atención"
					: unit.id === makeTranslationUnitId("module", MODULE, "name")
						? "Consultas"
						: unit.id === makeTranslationUnitId("form", FORM, "name")
							? "Consulta"
							: unit.id === makeTranslationUnitId("field", FIELD, "label")
								? proseText("Nombre del cliente")
								: unit.source;
			return [
				unit.id,
				{
					value,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human" as const,
					review: "reviewed" as const,
					translatedFrom: "eng",
				},
			];
		}),
	);
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		translations: { spa: translations },
	};
	return doc;
}

function Probe() {
	store = useBlueprintDocApi();
	const language = useBuilderLanguage();
	const appName = useAppName();
	const module = useModule(MODULE);
	const form = useForm(FORM);
	const field = useField(FIELD);
	const orderedModules = useOrderedModules();
	const orderedForms = useOrderedForms(MODULE);
	const { inline } = useBlueprintMutations();
	const label =
		field !== undefined && "label" in field && field.label !== undefined
			? field.label.parts
					.filter((part) => part.kind === "text")
					.map((part) => part.text)
					.join("")
			: "";
	return (
		<>
			<output data-testid="projection">
				{[
					language.language,
					appName,
					module?.name,
					form?.name,
					orderedModules[0]?.name,
					orderedForms[0]?.name,
					field?.id,
					label,
				].join("|")}
			</output>
			<button
				type="button"
				onClick={() => {
					inline.commitMany([
						{ kind: "setAppName", name: "Visitas comunitarias" },
					]);
					inline.updateModule(MODULE, { name: "Pacientes" });
					inline.updateForm(FORM, { name: "Seguimiento" });
					inline.updateField(FIELD, "text", {
						id: "client_full_name",
						label: proseText("Nombre completo"),
					});
				}}
			>
				Edit selected language
			</button>
		</>
	);
}

function renderProbe() {
	return render(
		<BlueprintDocProvider appId={APP_ID} initialDoc={fixture()}>
			<BuilderLocalizationProvider>
				<Probe />
			</BuilderLocalizationProvider>
		</BlueprintDocProvider>,
	);
}

describe("BuilderLocalizationProvider authoring lens", () => {
	beforeEach(() => {
		store = undefined;
		window.history.replaceState(null, "", `/build/${APP_ID}?lang=spa`);
	});

	afterEach(() => {
		window.history.replaceState(null, "", "/");
	});

	it("projects ordinary Builder entities and redirects their text edits to the target", () => {
		renderProbe();
		expect(screen.getByTestId("projection").textContent).toBe(
			"spa|Visitas de atención|Consultas|Consulta|Consultas|Consulta|client_name|Nombre del cliente",
		);

		act(() => screen.getByRole("button").click());

		expect(screen.getByTestId("projection").textContent).toBe(
			"spa|Visitas comunitarias|Pacientes|Seguimiento|Pacientes|Seguimiento|client_full_name|Nombre completo",
		);
		const current = store?.getState();
		if (current === undefined) throw new Error("Expected the document store.");
		expect(current.appName).toBe("Care visits");
		expect(current.modules[MODULE]?.name).toBe("Visits");
		expect(current.forms[FORM]?.name).toBe("Visit");
		expect(current.fields[FIELD]).toMatchObject({
			id: "client_full_name",
			label: proseText("Client name"),
		});
		expect(current.localization?.translations.spa).toMatchObject({
			[makeTranslationUnitId("app", "name")]: {
				value: "Visitas comunitarias",
				origin: "human",
				review: "reviewed",
			},
			[makeTranslationUnitId("module", MODULE, "name")]: {
				value: "Pacientes",
			},
			[makeTranslationUnitId("form", FORM, "name")]: {
				value: "Seguimiento",
			},
			[makeTranslationUnitId("field", FIELD, "label")]: {
				value: proseText("Nombre completo"),
			},
		});
	});

	it("falls back atomically when the selected language leaves the current snapshot", () => {
		renderProbe();
		const current = store;
		if (current === undefined) throw new Error("Expected the document store.");
		const remote = prepareMutationCandidate(
			current.getState(),
			admitMutationBatch([{ kind: "removeLanguage", code: "spa" }]),
		);

		act(() => {
			current.getState().beginRemoteApply();
			try {
				current.getState().commitDoc(remote.nextDoc, remote.mutations);
			} finally {
				current.getState().endRemoteApply();
			}
		});

		expect(screen.getByTestId("projection").textContent).toBe(
			"eng|Care visits|Visits|Visit|Visits|Visit|client_name|Client name",
		);
	});
});
