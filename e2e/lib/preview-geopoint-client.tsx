import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { testUuid } from "@/__tests__/helpers/uuid";
import { GeopointPicker } from "@/components/preview/form/fields/geopoint/GeopointPicker";
import { PortaledContentDirectionProvider } from "@/components/shadcn/portaled-content-direction";
import {
	ReconcilerContext,
	type ReconcilerContextValue,
} from "@/lib/collab/context";
import { createProjectScopeResetRegistry } from "@/lib/collab/projectScopeReset";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { EngineController } from "@/lib/preview/engine/engineController";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import { toastStore } from "@/lib/ui/toastStore";
import { settleGooglePeer } from "./preview-geopoint-google-peer";

const MODULE = testUuid("native-geopoint-module"),
	FORM = testUuid("native-geopoint-form"),
	FIELD = testUuid("native-geopoint-field");
const doc = admittedControllerDoc({
	appId: "native-geopoint",
	appName: "Location",
	connectType: null,
	caseTypes: null,
	modules: { [MODULE]: { uuid: MODULE, id: "capture", name: "Capture" } },
	forms: { [FORM]: { uuid: FORM, id: "visit", name: "Visit", type: "survey" } },
	fields: {
		[FIELD]: {
			uuid: FIELD,
			id: "location",
			kind: "geopoint",
			label: proseText("Location"),
		},
	},
	moduleOrder: [MODULE],
	formOrder: { [MODULE]: [FORM] },
	fieldOrder: { [FORM]: [FIELD] },
});
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
const controller = new EngineController();
controller.setDocStore(docStore);
controller.activateForm(FORM);
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project-source",
	role: "editor",
	canEdit: true,
});
session.getState().setPreviewing(true);
const registry = createProjectScopeResetRegistry();
const unexpected = (): never => {
	throw new Error("Geopoint does not use this reconciler operation");
};
const context: ReconcilerContextValue = {
	get reconciler() {
		return unexpected();
	},
	activate: unexpected,
	subscribePresence: unexpected,
	subscribeAppOrganization: unexpected,
	subscribePreviewProjectSpace: unexpected,
	subscribeLookupManifest: unexpected,
	projectScopeId: "native-geopoint",
	subscribeProjectScopeReset: registry.subscribe,
	isProjectScopeCurrent: registry.isCurrent,
};
toastStore.activateProjectScope({
	scopeId: context.projectScopeId,
	epoch: session.getState().scopeEpoch,
});
function Control() {
	const state = useStore(controller.store, (states) => states[FIELD]);
	if (!state) throw new Error("Missing location state");
	return (
		<GeopointPicker
			value={state.value}
			onChange={(value) => controller.setValueAt(state.path, value)}
			onBlur={() => controller.touchAt(state.path)}
			showError={false}
		/>
	);
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
const root = createRoot(element);
root.render(
	<BuilderSessionContext value={session}>
		<ReconcilerContext value={context}>
			<PortaledContentDirectionProvider direction="rtl">
				<Control />
			</PortaledContentDirectionProvider>
		</ReconcilerContext>
	</BuilderSessionContext>,
);
let mounted = true;
window.previewGeopointAudit = {
	answer: () => controller.store.getState()[FIELD]?.value,
	toasts: () => toastStore.toasts.map((toast) => toast.title),
	refresh() {
		const epoch = session.getState().beginAccessRefresh();
		registry.reset(epoch);
		toastStore.activateProjectScope({ scopeId: context.projectScopeId, epoch });
	},
	authorize() {
		session.getState().applyAccessSnapshot({
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
	},
	settle: settleGooglePeer,
	unmount() {
		if (mounted) {
			root.unmount();
			mounted = false;
		}
	},
	async dispose() {
		this.unmount();
		await settleGooglePeer();
		controller.dispose();
		await controller.awaitSettled();
		toastStore.deactivateProjectScope(context.projectScopeId);
	},
};
declare global {
	interface Window {
		previewGeopointAudit: {
			answer(): string | undefined;
			toasts(): string[];
			refresh(): void;
			authorize(): void;
			settle(): Promise<void>;
			unmount(): void;
			dispose(): Promise<void>;
		};
		nativeGeolocationDelivery: { held(): number; release(): void };
	}
}
