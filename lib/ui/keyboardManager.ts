import { IS_MAC } from "@/lib/platform";

export interface Shortcut {
	key: string;
	meta?: boolean;
	shift?: boolean;
	/** Return `false` to DECLINE the key: the manager leaves the event
	 *  untouched and keeps scanning earlier registrations, so a
	 *  broadly-registered key (layout-level Escape) doesn't eat events
	 *  it has nothing to do with. Any other return means handled, including
	 *  an implicit `undefined`, so every conditional handler must explicitly
	 *  return `false` on paths where it took no action and native behavior
	 *  should continue. */
	// biome-ignore lint/suspicious/noConfusingVoidType: `void` is the point — existing handlers return nothing (= handled); only an explicit `false` declines.
	handler: (e: KeyboardEvent) => boolean | void;
	/** If true, fires even when focus is inside text inputs */
	global?: boolean;
}

interface Registration {
	id: string;
	shortcuts: Shortcut[];
}

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
	private registrations: Registration[] = [];
	private listening = false;

	private handleKeyDown = (e: KeyboardEvent) => {
		const inInput = isInputFocused();
		const metaDown = IS_MAC ? e.metaKey : e.ctrlKey;

		for (let i = this.registrations.length - 1; i >= 0; i--) {
			for (const shortcut of this.registrations[i].shortcuts) {
				if (shortcut.key !== e.key) continue;
				if (!!shortcut.meta !== metaDown) continue;
				if (!!shortcut.shift !== e.shiftKey) continue;
				if (inInput && !shortcut.global) continue;

				/* A `false` return declines the key — keep scanning so an
				 * earlier registration gets its shot. Registration order is
				 * recency-of-(re)registration, not component depth, so a
				 * match alone can't mean "mine": a layout-level handler that
				 * re-registers on unrelated state would otherwise eat keys
				 * meant for a longer-lived, more specific registration. */
				if (shortcut.handler(e) === false) continue;
				e.preventDefault();
				return;
			}
		}
	};

	register(id: string, shortcuts: Shortcut[]) {
		// Remove existing registration with same id
		this.registrations = this.registrations.filter((r) => r.id !== id);
		this.registrations.push({ id, shortcuts });
		if (!this.listening && typeof document !== "undefined") {
			document.addEventListener("keydown", this.handleKeyDown);
			this.listening = true;
		}
	}

	unregister(id: string) {
		this.registrations = this.registrations.filter((r) => r.id !== id);
		if (this.registrations.length === 0 && this.listening) {
			document.removeEventListener("keydown", this.handleKeyDown);
			this.listening = false;
		}
	}
}

export const keyboardManager = new KeyboardManager();
