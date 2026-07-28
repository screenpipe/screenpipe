
# Screenpipe Design Guide

## Philosophy

**"Escher monochrome with phosphor intelligence"**

Screenpipe turns the trace of human work into memory, models, and agents. The
visual system should feel like a mathematical print becoming executable:
precise, recursive, slightly uncanny, and still controlled by the person whose
work created it.

Black and warm bone are the substrate. Phosphor is the learned signal. It
appears only where captured work becomes useful model context or an agent takes
an explicit action. Sharp corners, clean typography, and Escher-inspired
mathematical abstractions remain the core identity.

---

## Core Values

| Value | Description |
|-------|-------------|
| **Privacy First** | Local-first execution and data by default, cloud optional |
| **Human Agency** | Preserve ownership, control, and a visible path back to source material |
| **Open Source** | Inspect, modify, own, clean abstractions and readable codebase |
| **Simplicity** | Clean, minimal interface, powerful abstractions |
| **Radical optimism** | There is no such thing as impossible |
| **Progressive disclosure** | Easy, simple for non technical users but power users can still go deep |

---

## Typography

### Font Stack

| Purpose | Font | Fallbacks |
|---------|------|-----------|
| **Headings (sans)** | Space Grotesk | system-ui, sans-serif |
| **Body (serif)** | Crimson Text | Baskerville, Times New Roman, serif |
| **Code (mono)** | IBM Plex Mono | monospace |

### Usage Patterns

- **Headings**: Space Grotesk, lowercase preferred
- **Body text**: Crimson Text for readability
- **Code/technical**: IBM Plex Mono
- **Buttons**: UPPERCASE with tracking-wide
- **Labels**: lowercase, medium weight

---

## Narrative model

| Visual role | Meaning |
| --- | --- |
| Bone | Human experience and source material |
| Trace grey | Captured evidence and intermediate structure |
| Phosphor | Learned or executable intelligence |
| Ink | The local system, recursion, and durable infrastructure |

The public story is preserving, multiplying, and executing human intelligence.
Do not frame the product as erasing people. Screenpipe handles intimate context,
so agency, ownership, and a visible path back to source material are part of the
interface, not legal footnotes.

## Colors

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| Ink | `#050505` | Foreground, structure, dark background |
| Bone | `#F2EFE6` | Main light background and human/source state |
| Trace | `#78786F` | Secondary evidence and inactive structure |
| Phosphor | `#C7FF3E` | Active transformation and primary action |
| Phosphor strong | `#4A6B00` | Small phosphor text and borders on bone |

The default ratio is roughly 70 percent ink/bone, 20 percent trace neutrals,
and no more than 10 percent phosphor. Existing app surfaces can adopt this
incrementally. Do not perform a global color sweep without checking every state
in light and dark mode.

### Accessibility

- Use ink text on phosphor fills.
- Do not use bright phosphor for small text on bone. Use phosphor strong.
- Pair color with a label, icon, shape, or state change. Meaning must never rely
  on color alone.
- Keep error, warning, success, privacy, and billing states explicit in text.
  Phosphor is not a generic success color.

### Where phosphor belongs

- The boundary where capture becomes memory or model context
- The active step in an agent or automation pipeline
- A user-triggered primary action that starts that transformation
- A cursor, selection, or focus state inside an otherwise monochrome system
- A single focal point in a recursive or tessellated composition

### Where phosphor does not belong

- Every button, icon, link, or heading
- Large decorative backgrounds
- Generic badges or marketing emphasis
- Status decoration without a meaningful transformation
- Rainbow, aurora, or generic AI gradients

---

## Geometry

### Border Radius

```
--radius: 0
```

**All corners are sharp.** No rounded corners anywhere.

### Borders

- Width: 1px solid
- Style: Sharp, binary (on/off)
- No decorative gradients. A restrained transition may be used only when it
  communicates metamorphosis or state progression.

### Shadows

**Flat by default — use 1px borders for separation.** Subtle shadows are allowed to lift floating / elevated surfaces (chat input, overlays, popovers, dialogs) off the background. Keep them soft and low-opacity (e.g. `shadow-lg shadow-black/5`); never round corners to sell the lift — corners stay sharp.

---

## Components

### Buttons

```
- Font: UPPERCASE, tracking-wide
- Border: 1px solid
- Corners: Sharp (0px radius)
- Transition: 150ms
- Hover: Color inversion
- Phosphor fill: reserved for a primary action that starts capture-to-model or
  model-to-agent transformation
```

### Cards

```
- Border: 1px solid
- Shadow: None
- Corners: Sharp
- Padding: 24px (p-6)
```

### Inputs

```
- Style: Command-line aesthetic
- Font: Monospace (IBM Plex Mono)
- Border: 1px solid
- Height: 40px (h-10)
- Focus: Border color change
```

### Dialogs

```
- Border: 1px solid
- Shadow: Subtle lift allowed (elevated surface)
- Animation: 150ms fade
- Title: lowercase
```

---

## Motion & Animation

### Principles

- **Fast**: 150ms standard duration
- **Minimal**: Only essential state changes
- **Causal**: Motion should show what changed, what triggered it, and where it went

### Timing

| Animation | Duration |
|-----------|----------|
| Button hover | 150ms |
| Dialog open/close | 150ms |
| Accordion | 200ms |
| Page transitions | 150ms |

### Iteration

Do at least 10 iterations on your animations, at every turn criticise your own design and improve it until it matches the unique brand style

Take screenshots of modern apps with great design you find on internet and use it as inspiration for the UX but apply screenpipe brand style to it.

---

## Brand Voice

### Tone

- Lowercase, casual, direct
- Minimal technical details but power users can go deep
- No marketing fluff
- Show source, trigger, action, destination, and user control where relevant
- Avoid surveillance language and claims that remove human agency

---

## Design Checklist

When creating new UI components:

- [ ] Using Space Grotesk for headings
- [ ] Using Crimson Text for body (or IBM Plex Mono for technical)
- [ ] 1px solid border
- [ ] Flat by default; subtle shadows OK only to lift floating/elevated surfaces
- [ ] 0px border radius (sharp corners) — always, even on shadowed surfaces
- [ ] Composition remains mostly ink, bone, and trace grey
- [ ] Every phosphor use marks transformation, execution, or focus
- [ ] Bright phosphor uses ink foreground
- [ ] Small colored text on bone uses phosphor strong
- [ ] State is understandable without color
- [ ] 150ms transitions
- [ ] UPPERCASE for buttons, lowercase for titles
- [ ] Hover state: color inversion
- [ ] Focus ring: 1px solid with offset
- [ ] Always send screenshot of the new UI in PR bodies or design suggestions in ASCII, if you have access to AI image generation you can also leverage it 

---

## Key Files

| Purpose | Location |
|---------|----------|
| Design tokens | `apps/screenpipe-app-tauri/app/globals.css` |
| Tailwind config | `apps/screenpipe-app-tauri/tailwind.config.ts` |
| Color constants | `apps/screenpipe-app-tauri/lib/constants/colors.ts` |
| UI components | `apps/screenpipe-app-tauri/components/ui/*.tsx` |

---
