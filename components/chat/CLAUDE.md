# Chat Components

## ChatSidebar

Message list + input. Single instance that morphs between centered and sidebar layouts.

- **`centered` prop**: Hero mode below Logo, no header/border. Logo passed via `heroLogo` slot, animates to header via `layoutId="nova-logo"`.
- **`!centered`**: 320px (`w-80`) left sidebar with header + close button.
- **Layout morph**: Inner panel uses Motion `layout="position"` for GPU-accelerated position animation, enabled only during the 500ms centered↔sidebar transition (via `morphing` state). Disabled otherwise to prevent unwanted animations when toolbar/headers resize the content area. Size/border/shadow transition via CSS `transition` on the panel div. One instance stays mounted across the transition.
- **Enter/exit**: Sidebar slides in/out (`x: -320`). Centered fades. Handled by outer `motion.div` with `AnimatePresence` in BuilderLayout.

**Layout**: scrollable messages → SignalGrid (permanent, `shrink-0`) → ChatInput (`shrink-0`). The SignalGrid panel sits between messages and input, never scrolls.

**Scroll management** — Smart auto-scroll via `scrollRef` callback:
- **Near-bottom tracking**: Only auto-scrolls on new content (MutationObserver + ResizeObserver) when user was within 50px of bottom. Scrolling up "detaches" from auto-follow.
- **User hold detection**: `mousedown` on scroll container suppresses all auto-scroll; `mouseup` re-enables.
- **Cross-instance persistence**: Module-level `chatScrollPinned` + `chatScrollTop` survive center→sidebar transitions and panel close/reopen.
- **Animation-aware pinning**: 600ms rAF loop on mount keeps pinning to bottom during initial layout animation. Separate morph-aware rAF loop (tied to `morphing` state) anchors scroll during center↔sidebar transitions — captures pin-to-bottom intent and absolute scrollTop at morph start, overrides every frame to defeat the ResizeObserver/onScroll race condition where the browser's scrollTop clamping falsely clears `isNearBottomRef`.
- **Question card auto-scroll**: Detects new `input-available` askQuestions parts and `scrollIntoView({ block: 'nearest' })` unless user is holding scrollbar.

## ChatMessage

Iterates `message.parts`:
- `text` parts → text bubbles (assistant: `renderMarkdown()`, user: plain `whitespace-pre-wrap`)
- `tool-askQuestions` parts → `QuestionCard`
- All other tool/data parts → ignored (handled by `onData` in BuilderLayout)

## QuestionCard

Animated stepper with local state. Shows questions one at a time with option buttons. Answered questions display as checkmark + answer. Calls `addToolOutput` when all answered. Outer div carries `data-question-card` attribute (`'waiting'` | `'done'` | `'loading'`) for scroll targeting by ChatSidebar.

**`pendingAnswerRef`** — when user types while a question is waiting, ChatSidebar routes through this ref instead of sending a chat message. Typed answers prefixed with `"User Responded: "` so the SA knows it's free-form text.

## SignalPanel

Reusable sci-fi panel chrome — bezels, notches, indicator LED, display well, etched label. Used by both SignalGrid (chat) and the signal test page. Props: `active`, `label`, `suffix?`, `error?`, `children`. Exports `signalLabel(mode)` for default mode→label mapping. When `error` is true, the indicator LED and etched label turn rose via CSS (`globals.css` `.nova-panel[data-error]` rules).

**Label animation** — `AnimatePresence mode="wait"` crossfades the base label on mode change (0.75s fade). Optional `suffix` prop (e.g. elapsed timer) fades in once on appearance but updates in place without retriggering the crossfade.

**Panel chrome** — top bezel (corner notches, groove lines, status LED), recessed display well, bottom bezel with etched label. Grooves/notches are static (never change with state). Label shows "SYS:IDLE" when inactive, phase-specific text when active. Indicator LED pulses slowly (3s cycle) when active, decays over 1.5s on deactivation. Entire panel is `user-select: none`. CSS in `globals.css` under `.nova-panel*`.

## SignalGrid

Permanent neural activity panel. Always mounted between the scroll container and the chat input (`shrink-0`), never scrolls, never hides. Cells are physical LEDs that exist even when unlit.

**Modes** — derived in ChatSidebar from builder + useChat state:
- `idle` — slow wide twinkle clusters (5x5 spread, ~0.75/sec). Grid is alive but resting.
- `sending` — upward wave (bottom→top, left→right). Duration-normalized via `SEND_WAVE_DURATION` so one cycle takes the same time regardless of grid width. Forced for one wave cycle via `forceSending` in ChatSidebar. Three triggers: (1) user's initial message, (2) completed question block (`handleToolOutput` wraps `addToolOutput` — fires `triggerSendWave` when `tool === 'askQuestions'`), (3) post-build edit messages. Individual question answers within an ask block route through `pendingAnswerRef` and do NOT trigger the send wave.
- `reasoning` — random neural firing correlated with token generation. Tracks `reasoning` + `text` + `tool-*` input part deltas on the last assistant message → `builder.injectThinkEnergy(delta * 2)`. Ambient firing speed scales with energy level.
- `building` — pink scanner beam sweep + delivery bursts + thinking activity. The sweep uses bubblegum pink (negative hue → `PINK` constant) to contrast the cyan thinking cells. Burst energy (from data parts: module/form completions) drives flashes. Think energy (from token generation: text, reasoning, tool args) drives reasoning-style neural firing layered on top of the sweep. Rule: anything not shown to the user = thinking; only UI-visible changes trigger flashes.
- `editing` — defrag-style animation for user-initiated post-build edits (`postBuildEdit && agentActive`). Only activates when the user sends a new message after generation completes — the post-build summary stays in reasoning mode. A 2-column bubblegum pink bar performs tracked pick-move-drop operations within a focus zone: **Seek** (dim bar jitters through random columns, mostly adjacent moves, hunting for a target), **Select** (double-flash with forced-dark gap — "double-click"), **Crawl** (bar moves at full brightness from source to destination), **Place** (dark gap then single flash — "drop"). Full-grid reasoning-style neural firing layered underneath (identical to building mode's think layer). Focus zone (`EditFocus`) is computed from the agent's current tool call targets: question-level (narrow zone around the question's flat index), form-level (zone spans the form), or full-width fallback. Zone lerps smoothly toward the target. `EditScope` tracked on builder, computed from streaming tool arg `moduleIndex`/`formIndex`/`questionPath`. `flatIndexById()` in `questionTree.ts` walks the question tree structurally (no string parsing) to find flat indices.
- `error-recovering` — reasoning-style firing with ~35% of cells using warm amber-rose hues. Signals "something's wrong but the SA is still working." Ambient cells also get ~25% warm mix.
- `error-fatal` — continuous transition from erratic warm flicker (decays over ~3s) into a settled uniform dim rose-pink pulse (~5s sine breath, 30–50% opacity, hue 2.0 = pure rose). No discrete phases — flicker intensity fades out while the resting-pulse pull grows stronger. Container glow shifts to rose. Panel LED and label turn rose via `data-error` attribute.

**Elapsed timer** — after 30s in the current step, ChatSidebar appends a suffix like "(30s)", "(1m 12s)" via the `suffix` prop on SignalPanel. Fades in once, then ticks in place. Resets independently per step: on `gridMode` change OR `statusMessage` (build phase) change, so each build phase starts its own timer from 0.

**Status labels** — `PHASE_LABELS` in `builder.ts` is the single source of truth for build-phase status text shown in the panel. No ellipses — the neurons and timer convey activity.

**Architecture** — two-layer: `SignalGridController` (imperative class in `lib/signalGridController.ts`) owns cell state and the rAF animation loop, writes directly to DOM via `style.cssText`. `SignalGrid` (React component) creates/destroys the controller via a stable ref callback, forwards mode changes via `useEffect`, and tracks message content deltas.

**Energy pipeline** — two channels, both non-versioned (no React re-renders):
- **Burst energy** (`builder.injectEnergy` / `drainEnergy`) — from `applyDataPart()` (200 for module/form completions, 100 for updates, 50 for phase transitions) and the intro sequence. Drives building-mode flashes; combined into neural firing in reasoning mode.
- **Think energy** (`builder.injectThinkEnergy` / `drainThinkEnergy`) — from message content deltas: `text` + `reasoning` + `tool-*` input parts (2x multiplier). Drives reasoning-style neural firing in all modes. Tool input tracking (`JSON.stringify(part.input)`) captures energy during tool arg streaming, which is the bulk of build time.
Controller reads both via `consumeEnergy()` + `consumeThinkEnergy()` each animation frame.

**Color space** — `cellColor(brightness, hue)` maps hue to color: 0 = violet, 1 = cyan, <0 = pink (violet→bubblegum), >1 = warm error tones (1–1.5 = violet→amber, 1.5–2.0 = amber→rose). Brightness >0.55 blends toward white. Thinking cells use hue 0-1 (violet-cyan). The building sweep uses negative hue (-0.8 leading, -0.35 trail) for pink. Error modes use hue >1 for warm tones — `error-recovering` sprinkles ~35% warm-hued cells into reasoning-style activity, `error-fatal` flickers then settles into a uniform dim rose-pink pulse (hue 2.0 = pure rose, no amber).

**Intro sequence** — on page load, ChatSidebar's `WelcomeIntro` component temporarily sets mode to `reasoning` and injects energy bursts timed with the staggered welcome text fade-in.

**Density scaling** — all per-frame activation counts scale with `cellCount / 93` (reference: sidebar at 280px) so narrow and wide grids have the same visual density.
