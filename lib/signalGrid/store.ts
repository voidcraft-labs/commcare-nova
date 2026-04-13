/**
 * signalGrid store -- module-level nanostore for the signal grid's non-reactive state.
 *
 * Pattern mirrors `lib/services/toastStore.ts`: plain class, module singleton,
 * callable from anywhere (route handlers, agent stream consumers, React). The
 * store holds energy counters; the `SignalGridController` drains accumulated
 * energy into frame-scoped animation state from its own rAF loop.
 *
 * Why not Zustand: the state is non-reactive by design -- consumers only read it
 * from inside an rAF callback, never from React render. Zustand's subscription
 * machinery is pure overhead for this use case.
 */

class SignalGridStore {
	/** Accumulated burst energy from data parts (module-done, form-done, etc.). */
	private streamEnergy = 0;
	/** Accumulated token/reasoning energy from chat message deltas. */
	private thinkEnergy = 0;

	/** Add burst energy -- called by `applyDataPart` when significant events arrive. */
	injectEnergy(amount: number): void {
		this.streamEnergy += amount;
	}

	/** Add think energy -- called by `SignalGrid` on message content deltas. */
	injectThinkEnergy(amount: number): void {
		this.thinkEnergy += amount;
	}

	/** Read and reset burst energy. Called once per animation frame by the controller. */
	drainEnergy(): number {
		const e = this.streamEnergy;
		this.streamEnergy = 0;
		return e;
	}

	/** Read and reset think energy. Called once per animation frame by the controller. */
	drainThinkEnergy(): number {
		const e = this.thinkEnergy;
		this.thinkEnergy = 0;
		return e;
	}

	/** Test-only -- reset both counters to zero. */
	_reset(): void {
		this.streamEnergy = 0;
		this.thinkEnergy = 0;
	}
}

/** Module-level singleton -- import and call directly from any context. */
export const signalGrid = new SignalGridStore();
