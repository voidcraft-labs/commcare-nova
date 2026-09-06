import { IS_MAC } from "@/lib/platform";

import { ShortcutRegistry, type ShortcutRule } from "./keyboardShortcuts";

export type Shortcut = ShortcutRule<KeyboardEvent>;

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isInputFocused(): boolean {
	const el = document.activeElement;
	if (!el) return false;
	if (INPUT_TAGS.has(el.tagName)) return true;
	if ((el as HTMLElement).contentEditable === "true") return true;
	if (el.closest(".cm-content")) return true;
	return false;
}

class KeyboardManager {
	private registry = new ShortcutRegistry<KeyboardEvent>();
	private listening = false;

	private handleKeyDown = (e: KeyboardEvent) => {
		if (
			this.registry.dispatch(e, {
				key: e.key,
				modifier: IS_MAC ? e.metaKey : e.ctrlKey,
				shift: e.shiftKey,
				editing: isInputFocused(),
			})
		)
			e.preventDefault();
	};

	register(id: string, shortcuts: Shortcut[]) {
		this.registry.register(id, shortcuts);
		if (!this.listening && typeof document !== "undefined") {
			document.addEventListener("keydown", this.handleKeyDown);
			this.listening = true;
		}
	}

	unregister(id: string) {
		this.registry.unregister(id);
		if (this.registry.empty && this.listening) {
			document.removeEventListener("keydown", this.handleKeyDown);
			this.listening = false;
		}
	}
}

export const keyboardManager = new KeyboardManager();
