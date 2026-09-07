import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { testUuid } from "@/__tests__/helpers/uuid";
import { AttachmentField } from "@/components/preview/form/fields/attachment/AttachmentField";
import {
	__resetAttachmentCoordinatorForTests,
	setAttachmentEntryAuthority,
} from "@/components/preview/form/fields/attachment/attachmentClient";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { isCaptureField, proseText, type Uuid } from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { EngineController } from "@/lib/preview/engine/engineController";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

const MODULE = testUuid("native-attachment-module"),
	FORM = testUuid("native-attachment-form");
const PHOTO = testUuid("native-attachment-photo"),
	SIGNATURE = testUuid("native-attachment-signature");
const doc = admittedControllerDoc({
	appId: "native-attachments",
	appName: "Attachment controls",
	connectType: null,
	caseTypes: null,
	modules: { [MODULE]: { uuid: MODULE, id: "capture", name: "Capture" } },
	forms: { [FORM]: { uuid: FORM, id: "visit", name: "Visit", type: "survey" } },
	fields: {
		[PHOTO]: {
			uuid: PHOTO,
			id: "photo",
			kind: "image",
			label: proseText("Photo"),
		},
		[SIGNATURE]: {
			uuid: SIGNATURE,
			id: "consent",
			kind: "signature",
			label: proseText("Signed consent"),
		},
	},
	moduleOrder: [MODULE],
	formOrder: { [MODULE]: [FORM] },
	fieldOrder: { [FORM]: [PHOTO, SIGNATURE] },
});
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
const session = createBuilderSessionStore();
session.getState().setPreviewing(true);
const controller = new EngineController();
controller.setDocStore(docStore);
controller.activateForm(FORM);
const entryKey = controller.entryKey;
if (!entryKey) throw new Error("Missing active entry");
const authority = {
	appId: doc.appId,
	entryKey,
	formUuid: FORM,
	projectId: "project",
	actorUserId: "actor",
	ownerId: "actor",
	scopeEpoch: 1,
	accessPhase: "authorized" as const,
	canEdit: true,
};
setAttachmentEntryAuthority({
	entryKey,
	snapshot: authority,
	readCurrent: () => ({
		...authority,
		entryKey: controller.entryKey,
		formUuid: controller.formUuid,
	}),
});

function Control({ uuid }: { uuid: Uuid }) {
	const field = doc.fields[uuid];
	const state = useStore(controller.store, (states) => states[uuid]);
	if (!isCaptureField(field) || !state)
		throw new Error("Missing capture state");
	return (
		<section aria-label={field.id} style={{ marginBottom: 24 }}>
			<AttachmentField
				field={field}
				state={state}
				path={state.path}
				appId={doc.appId}
				entryKey={entryKey}
				attachmentSlotKey={uuid}
				onChangeAt={(path, value) => controller.setValueAt(path, value)}
				onBlurAt={(path) => controller.touchAt(path)}
			/>
		</section>
	);
}
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing root");
const root = createRoot(rootElement);
root.render(
	<BlueprintDocContext value={docStore}>
		<BuilderSessionContext value={session}>
			<Control uuid={PHOTO} />
			<Control uuid={SIGNATURE} />
		</BuilderSessionContext>
	</BlueprintDocContext>,
);
window.previewAttachmentsAudit = {
	answers: () => ({
		photo: controller.store.getState()[PHOTO]?.value,
		signature: controller.store.getState()[SIGNATURE]?.value,
	}),
	async dispose() {
		root.unmount();
		controller.dispose();
		await controller.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		previewAttachmentsAudit: {
			answers(): { photo?: string; signature?: string };
			dispose(): Promise<void>;
		};
	}
}
