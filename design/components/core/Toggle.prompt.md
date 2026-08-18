Switch control, one size: a 44px hit area (the one control height) around a lighter 32px visible track, so the solid pill doesn't outweigh bordered fields. "On" wears the primary button's action fill (`--nova-action`) with a dusk thumb; off is a deep track + muted thumb. Hover lifts toward light (never dims).

```jsx
const [on, setOn] = React.useState(false);
<Toggle enabled={on} onToggle={() => setOn(v => !v)} />
```

Controlled component; you own the `enabled` state and flip it in `onToggle`. `disabled` dims to opacity 0.6 (`--disabled-opacity`, keeps ≥3:1 contrast).
