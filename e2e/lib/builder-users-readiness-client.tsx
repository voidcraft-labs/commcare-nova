import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { UsersSection } from "@/components/builder/app-setup/UsersSection";
import {
	BuilderLookupCatalogProvider,
	useBuilderLookupCatalog,
} from "@/components/builder/lookup/BuilderLookupCatalogProvider";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	blueprintDocSchema,
	organizationLevelSchema,
	proseText,
} from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";

const property = testUuid("users-readiness-property"),
	role = testUuid("users-readiness-role"),
	persona = testUuid("users-readiness-persona");
const canEdit = new URLSearchParams(location.search).get("viewer") !== "1";
const source = {
	...buildDoc({
		appId: "native-users",
		appName: "Users readiness",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [{ id: "notes", kind: "text", label: proseText("Notes") }],
					},
				],
			},
		],
	}),
	organizationLevels: {
		[testUuid("users-clinic-level")]: organizationLevelSchema.parse({
			uuid: testUuid("users-clinic-level"),
			code: "clinic",
			name: "Clinic",
			caseFlow: {
				workers: "assigned",
				ownsCases: true,
				descendantCases: { kind: "none" },
			},
			addressBook: { reach: "own-branch" },
		}),
	},
	organizationLevelOrder: [testUuid("users-clinic-level")],
	userProperties: {
		[property]: { uuid: property, slug: "district", label: "District" },
	},
	userPropertyOrder: [property],
	userTypes: {
		[role]: { uuid: role, name: "Nurse", values: { [property]: "North" } },
	},
	userTypeOrder: [role],
	personas: {
		[persona]: {
			uuid: persona,
			name: "Asha",
			userTypeUuid: role,
			locations: {
				primaryUuid: testUuid("users-place-north"),
				additionalUuids: [testUuid("users-place-south")],
			},
		},
	},
	personaOrder: [persona],
};
const doc = blueprintDocSchema.parse(toPersistableDoc(source));
const admission = evaluateCommit({
	nextDoc: source,
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!admission.ok) throw new Error(JSON.stringify(admission.findings));
function Surface() {
	const api = useBlueprintDocApi();
	const catalog = useBuilderLookupCatalog();
	useLayoutEffect(() => {
		const binding = {
			snapshot: () => toPersistableDoc(api.getState()),
			refresh: async () => {
				if (catalog.kind === "ready" || catalog.kind === "error")
					await catalog.retry();
			},
		};
		window.usersReadiness = binding;
		return () => {
			if (window.usersReadiness === binding) window.usersReadiness = undefined;
		};
	}, [api, catalog]);
	return (
		<main style={{ padding: 32, maxWidth: 800 }}>
			<UsersSection />
			<ToastContainer />
		</main>
	);
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
const root = createRoot(element);
root.render(
	<BuilderSessionProvider
		init={{
			appId: "native-users",
			projectId: "native-users-project",
			role: canEdit ? "editor" : "viewer",
			canEdit,
		}}
	>
		<BlueprintDocProvider initialDoc={doc} canEdit={canEdit}>
			<BuilderLookupCatalogProvider>
				<Surface />
			</BuilderLookupCatalogProvider>
		</BlueprintDocProvider>
	</BuilderSessionProvider>,
);
window.disposeUsersReadiness = () => root.unmount();
declare global {
	interface Window {
		usersReadiness?: {
			snapshot: () => typeof doc;
			refresh: () => Promise<void>;
		};
		disposeUsersReadiness: () => void;
	}
}
