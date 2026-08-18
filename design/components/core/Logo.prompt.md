The CommCare Nova logo: the **first light sphere** logomark (a dusk world whose limb catches first light) + lowercase "commcare nova" in Outfit bold, two-tone, no gradient: "commcare" in `--nova-text`, "nova" in `--nova-violet-bright`. The product name is always lowercase.

```jsx
<Logo size="lg" />
<Logo size="chrome" />               {/* app header: 44px mark (the control band), 32px type */}
<Logo size="hero" markOnly />        {/* sphere alone; the wrapper must carry the accessible name */}
<Logo size="lg" animate={false} />   {/* stills the standby wave (print, dense UI) */}
<Logo variant="flat" size="sm" />    {/* force the flat crescent mark (light background, print) */}
```

Sizes: `sm`, `md` (default), `lg`, `hero` (landing), `chrome` (app header: the mark is 44px, exactly as tall as the buttons beside it, and the type stays at reading size). Marks under 32px flatten AUTOMATICALLY into the flat sibling (violet body, bold dawn crescent — the sphere's detail needs room; the favicon is exported from this form); `variant="flat"` forces it at any size. At rest the dawn widens and narrows along the limb like a sunrise lamp coming up: nothing moves, spins, or blinks. Hover lights the RIM, and only when the lockup sits inside an `<a>` or `<button>` — a logo on a page is not a control. `animate={false}` stills the wave.
