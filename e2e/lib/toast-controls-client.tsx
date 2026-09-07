import { createRoot } from "react-dom/client";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { showProjectToast, toastStore } from "@/lib/ui/toastStore";

const source = { scopeId: "native-toast-owner", epoch: 0 };
let synchronousHidden = false,
	actions = 0;
toastStore.activateProjectScope(source);
const target = document.getElementById("root");
if (!target) throw new Error("Missing toast peer root");
const root = createRoot(target);
root.render(
	<>
		<button
			type="button"
			onClick={() =>
				showProjectToast(
					source,
					"warning",
					"Source Project warning",
					"Source-only detail",
					{
						persistent: true,
						action: {
							label: "Apply source action",
							onPress: () => {
								actions++;
							},
						},
					},
				)
			}
		>
			Show scoped notice
		</button>
		<button
			type="button"
			onClick={() => {
				const retained = document.querySelector<HTMLElement>(
					"[data-nova-project-toast-scope]",
				);
				toastStore.activateProjectScope({ ...source, epoch: 1 });
				synchronousHidden =
					retained?.hidden === true && retained.style.display === "none";
			}}
		>
			Retire Project
		</button>
		<ToastContainer />
	</>,
);
window.toastControlsAudit = {
	synchronouslyHidden: () => synchronousHidden,
	actions: () => actions,
	dispose: () => {
		root.unmount();
		toastStore.clear();
		toastStore.deactivateProjectScope(source.scopeId);
	},
};
declare global {
	interface Window {
		toastControlsAudit: {
			synchronouslyHidden: () => boolean;
			actions: () => number;
			dispose: () => void;
		};
	}
}
