/** Programmatic shortcut routing. The browser adapter owns focus and event cancellation. */
export interface ShortcutRule<Event> {
	key: string;
	meta?: boolean;
	shift?: boolean;
	global?: boolean;
	// biome-ignore lint/suspicious/noConfusingVoidType: existing callbacks consume unless they explicitly decline.
	handler: (event: Event) => boolean | void;
}

export interface ShortcutContext {
	key: string;
	modifier: boolean;
	shift: boolean;
	editing: boolean;
}

export class ShortcutRegistry<Event> {
	private registrations: Array<{
		id: string;
		shortcuts: ShortcutRule<Event>[];
	}> = [];

	get empty(): boolean {
		return this.registrations.length === 0;
	}

	register(id: string, shortcuts: ShortcutRule<Event>[]) {
		this.unregister(id);
		this.registrations.push({ id, shortcuts });
	}

	unregister(id: string) {
		this.registrations = this.registrations.filter((entry) => entry.id !== id);
	}

	/** Latest registration gets first refusal. Only an accepted handler consumes the key. */
	dispatch(event: Event, context: ShortcutContext): boolean {
		for (let i = this.registrations.length - 1; i >= 0; i--) {
			for (const shortcut of this.registrations[i].shortcuts) {
				if (
					shortcut.key !== context.key ||
					!!shortcut.meta !== context.modifier ||
					!!shortcut.shift !== context.shift ||
					(context.editing && !shortcut.global)
				)
					continue;
				if (shortcut.handler(event) !== false) return true;
			}
		}
		return false;
	}
}
