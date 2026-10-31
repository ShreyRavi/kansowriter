---
name: Kansowriter
colors:
  paper:
    ground: "#F5F0E6"
    surface: "#FBF8F1"
    ink: "#272320"
    muted: "#6E655B"
    dim: "#756B5F"
    hairline: "#E3DACB"
    track: "#E9E2D4"
    selected: "#EFE9DC"
    accent: "#5E6E3A"
    accentHover: "#48562C"
    selection: "#5E6E3A38"
    shadow: "rgba(39, 35, 32, 0.35)"
  night:
    ground: "#1B1917"
    surface: "#23201D"
    ink: "#E8E1D5"
    muted: "#A39A8E"
    dim: "#8A8176"
    hairline: "#2E2A26"
    track: "#2E2A26"
    selected: "#2A2622"
    accent: "#B5BF86"
    accentHover: "#CBD4A2"
    selection: "#B5BF8647"
    shadow: "rgba(0, 0, 0, 0.55)"
type:
  writing: "'Newsreader', Georgia, 'Times New Roman', serif"
  sans: "'Instrument Sans', system-ui, sans-serif"
  mono: "'IBM Plex Mono', ui-monospace, monospace"
  ui: 13px
  row: 14px
  uiSmall: 12px
  key: 11px
  body: 21px
  bodyPhone: 19px
  title: 34px
  titlePhone: 28px
  landing: 30px
  wordmark: 17px
  openFile: 17px
  heading1: 1.62em
  heading2: 1.3em
  heading3: 1.15em
  lineSerif: "1.7"
  lineSans: "1.65"
  lineMono: "1.6"
rounded:
  key: 3px
  row: 4px
  panel: 6px
  sheet: 16px
space:
  pageTop: 160px
  pageBottom: 120px
  gutter: 24px
  paragraph: 28px
  paragraphPhone: 22px
  measure: 680px
  sidebar: 340px
  palette: 620px
  sendPanel: 620px
  endLink: 48px
  target: 44px
  tool: 32px
  dock: 48px
  checkBox: 0.78em
  trafficLights: 84px
motion:
  chromeFadeDelay: 3000ms
  chromeFade: 200ms
  goalSettle: 600ms
  feedback: 2000ms
  endLinkDelay: 1500ms
  endLinkFade: 400ms
  tooltipDelay: 500ms
  tooltipFade: 120ms
---

# Kansowriter design system

The visual source is the Calm Writer design canvas (renamed Kansowriter). `src/ui/tokens.css` and `src/ui/theme-colors.ts` are generated from the front matter above by `npm run tokens`; CI fails if either drifts (`npm run tokens:check`).

## Principles
- The page acts like paper. Chrome fades 3 s after the first keystroke and returns on mouse move, tap, Esc or keyboard focus.
- One accent, used only for the progress line, links, focus and the on-state of a header toggle (focus mode: accent icon on a `selected` pill).
- Focus mode dims other paragraphs to `dim`, the faintest the text can go and stay WCAG AA readable (paper #756B5F ≈ 4.5:1 on ground, night #8A8176 ≈ 4.6:1; ink is ≈ 14:1). Lighter values were tried and fail the axe contrast gate, so the dim stays at AA and the mode is made obvious by the button's on-state instead.
- No cards, no decorative shadows. Overlays (sidebar, palette, send panel) get one soft offset shadow.
- Minimum UI text 13px; palette rows and the search field 14px (`row`); key-hint chips 11px.
- Overlay shadows use the theme's `shadow` color, so night overlays still lift off the ground.

## Components
| Component | Spec |
|---|---|
| Header | 20px 24px padding, 13px UI, 44px icon buttons, 18px 1.5-stroke icons: ☰ drafts + title left, formatting toolbar centred (desktop), focus, theme, send (envelope), ⌘K right |
| Tooltip | every icon- or symbol-only button (header, toolbar, dock, sidebar, palette, send panel; `e2e/formatting.spec.ts` walks them): the button's name + shortcut ("Focus mode ⌘⇧P", "Bold ⌘B"), 12px sans on an ink chip, `row` radius, 6px below the button (edge-aligned at the header's sides and on `data-tip-align=end` buttons near the right edge); a toggle's tip says its state ("Focus mode: on ⌘⇧P"); shows on hover or keyboard focus after `tooltipDelay`, fades in over `tooltipFade`, hides at once; never on touch screens; the aria-label stays the accessible name (no native `title`) |
| Format toolbar | `role=toolbar`, one Tab stop (←/→ between buttons); groups: style menu \| bullet, numbered, checklist, quote \| B I U S, split by 1px × 18px hairlines; `tool` (32px) buttons, 44px on coarse pointers; B I U S are 17px Newsreader glyphs drawn in their own style; pressed (`aria-pressed`) = `selected` background + ink; disabled 45% opacity (read-only tab, damaged draft); Tooltip = name + shortcut; a click never moves focus or the selection; fades with the chrome |
| Style menu | button: current style 13px + 10px chevron, 100px min (dock: content width); menu: surface, hairline, `panel` radius, overlay shadow, 44px `menuitemradio` rows previewing Title / Heading / Subheading / Normal in Newsreader, key chip right (hidden on touch), an aria-hidden ✓ on the current one; picking sets the style (the current one changes nothing); Esc closes it wherever focus is |
| Format dock | phones (< 800px, coarse < 1024px, landscape phones): `dock` (48px) row of 44px targets, surface + hairline top, pinned to the visual viewport's bottom edge (above the on-screen keyboard; above a notice when no keyboard is open); shown only while the text has focus; scrolls sideways, never the page, its edges fading (32px mask) where there is more to scroll |
| Checklist box | `checkBox` square, 1.5px muted border, `row` radius; checked = ink fill with a ground tick, item text muted; drawn in place of `[ ]` / `[x]` off the caret line (the line's `- ` hidden too); `role=checkbox`; ⌘↵ toggles the caret's lines; display-only in the reader |
| Progress line | 2px, full width, pinned to the bottom edge; accent on track; settles to full over 600 ms at goal |
| Notice strip | 40px above the progress line, surface, hairline top, 13px ink text, one text action right; one at a time |
| Palette row | 44px min, 4px radius, label left, value + key chip right; in-row editing; inline destructive confirm |
| Sidebar row | title 17px Newsreader 500, when 12px, 2-line excerpt 13px, words 12px; selected row background |
| Search field | 40px, magnifier icon, clear ✕ when filled, hidden label |
| Reader | 680px column, hidden controls row (play/pause, scrubber, Skip to the end), date line top-left, 2px replay line, end-state link 48px below the text after 1.5 s (`endLinkFade`, none under reduced motion); empty state: "Open a letter file" 17px Newsreader (`openFile`) with a drop zone; reduced motion keeps the replay (static caret, no animated chrome) |
| Window (macOS app) | no title bar: the traffic lights sit in the header (Tauri `titleBarStyle: Overlay`, `trafficLightPosition` 20, 44 in `src-tauri/tauri.conf.json`), vertically centred on its 44px buttons, 20px from the left edge like the sidebar's text; the header reserves `trafficLights` (84px) on the left so ☰ starts a calm gap after them, and the sidebar's top row starts its "Drafts" label 12px past that (text has no button inset), its row centred on the lights. The lights stay visible while the chrome fades (native behaviour; the reserved zone never moves, so nothing shifts under them) and AppKit hides them in full screen, where the reserve drops back to the 24px gutter. The header is the title bar: drag it from any empty spot, double-click zooms; buttons stay buttons. The window is at least 640px wide, so the phone header never meets the lights |
| Linked file (macOS app) | a draft linked to a Markdown file shows the path (`~/…`) as the title's tooltip and a 12px muted file glyph before its title in the sidebar; nothing else changes. File problems use the notice strip, below every saving notice: "This file changed outside Kansowriter." Use the file’s version · Keep mine; "The linked file was moved or deleted. Your draft is safe here." Save to file… |
| Send panel | 620px bottom panel 24px above the edge (phone: sheet, `rounded.sheet` top corners, max 60vh), live preview above, Replay / Final text only, start slider, size note, privacy line, primary Copy link / Download letter file |

## Formatting
Heading scale in the text: Title `heading1` (1.62em, 500), Heading `heading2` (1.3em, 500), Subheading `heading3` (1.15em, 600); levels 4–6 body size, 600. Off the caret line a bullet item's `-` is drawn as a muted `•`.

Buttons and shortcuts write plain Markdown; syntax shows only on the caret line. Underline is `<u>…</u>`, the one piece of HTML styled (as a decoration; all other HTML stays text). Shortcuts (Mod = ⌘ / Ctrl): B bold, I italic, U underline, ⇧X strikethrough, ⇧7 numbered, ⇧8 bullet, ⇧9 checklist, ' quote, ↵ check, ⇧1 title, ⇧H heading, ⇧J subheading (Ctrl ⇧G off Apple), ⇧B normal. Title isn't ⇧T (typewriter, and the browser's reopen-tab); Ctrl ⇧J is the browser console. Heading shortcuts toggle (again → Normal); the menu sets. Quote is a container: lists and headings keep inside it. With an empty caret a second B/I/U/S press steps out of the span just typed. Enter continues a list item (Enter on an empty item ends the list), Backspace on an empty item removes its marker, and numbered lists renumber as lines come and go. Nothing formats inside code.

## Browser surfaces
Selection uses `selection`; caret 2px ink; focus-visible ring 2px accent, 2px offset; thin scrollbars in hairline; links underline offset 3px.
