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

/**
 * The page's shortcuts hear a key last. The manager listens on the window, so
 * a key reaches it only after it has bubbled past every element and the
 * document, and it leaves alone a key something on the way already took.
 *
 * An open floating element takes its keys first that way. A Base UI menu,
 * select, popover, dialog, drawer or tooltip closes on Escape through its
 * dismiss hook (`@base-ui/react` `floating-ui-react/hooks/useDismiss`,
 * `closeOnEscapeKeyDown`),
 * which calls `preventDefault` on the key and, unless the popup lets it
 * bubble, `stopPropagation`: from the popup's own key handler where focus is
 * inside it, and from a document listener the open popup adds where focus is
 * elsewhere. Either way the key never reaches the window, or reaches it
 * already taken, so the Escape that closes a menu does not also leave Preview
 * or clear a selection.
 */
class KeyboardManager {
	private registry = new ShortcutRegistry<KeyboardEvent>();
	private listening = false;

	private handleKeyDown = (e: KeyboardEvent) => {
		if (e.defaultPrevented) return;
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
		if (!this.listening && typeof window !== "undefined") {
			window.addEventListener("keydown", this.handleKeyDown);
			this.listening = true;
		}
	}

	unregister(id: string) {
		this.registry.unregister(id);
		if (this.registry.empty && this.listening) {
			window.removeEventListener("keydown", this.handleKeyDown);
			this.listening = false;
		}
	}
}

export const keyboardManager = new KeyboardManager();
