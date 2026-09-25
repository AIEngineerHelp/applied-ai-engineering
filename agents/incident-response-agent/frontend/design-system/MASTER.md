# Incident Response Console — Design System (MASTER, v2)

v1 (navy nav, blue accent, Fira fonts, card-per-metric) was rejected by the user as "very AI
generated". v2 is a plain, white, tool-like UI in the spirit of Linear / Vercel / PagerDuty:
neutral grays, black primary buttons, very little color, dense and quiet. Page files in
`design-system/pages/` override this file.

## Principles
1. **White by default.** Light theme is the default for everyone (do NOT follow the OS
   setting). Dark mode is an explicit opt-in toggle (sun/moon button), remembered per browser.
2. **Color only means something.** The whole UI is neutral gray. Color appears only for
   severity and status, as a small dot/square next to text, never as filled backgrounds.
3. **No template tropes.** Every element must earn its place (see Anti-patterns).
4. **Content over chrome.** Fewer boxes; use whitespace and 1px dividers to group.

## Color tokens (semantic; components never use raw hex). All text pairs verified ≥ 4.5:1.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#0A0A0A` | App + page background |
| `--surface` | `#FFFFFF` | `#141414` | Panels, menus, dialogs |
| `--subtle` | `#FAFAFA` | `#111111` | Sidebar, table header |
| `--hover` | `#F5F5F5` | `#1C1C1C` | Row/menu hover, selected nav item |
| `--border` | `#EBEBEB` | `#262626` | Hairlines, dividers |
| `--border-strong` | `#D4D4D4` | `#404040` | Inputs |
| `--fg` | `#171717` | `#EDEDED` | Primary text |
| `--fg-muted` | `#525252` | `#A3A3A3` | Secondary text |
| `--fg-subtle` | `#737373` | `#8A8A8A` | Meta, placeholders, axis labels |
| `--primary` | `#171717` | `#EDEDED` | Primary button bg (black / white) |
| `--primary-fg` | `#FFFFFF` | `#0A0A0A` | Primary button text |
| `--link` | `#2563EB` | `#60A5FA` | Links, focus ring, selected tab underline |

Signal colors (dots/squares + text; text versions pass 4.5:1 on bg):

| Meaning | Light | Dark |
|---|---|---|
| SEV1 / failed | `#DC2626` | `#F87171` |
| SEV2 | `#C2410C` | `#FB923C` |
| SEV3 / awaiting approval | `#A16207` (dot `#CA8A04`) | `#FACC15` |
| SEV4 / neutral / skipped | `#737373` | `#8A8A8A` |
| Running / investigating / queued | `#2563EB` | `#60A5FA` |
| Reported / resolved / executed / ok | `#15803D` (dot `#16A34A`) | `#4ADE80` |

Charts: bars in `--fg-subtle`-ish gray (`#A3A3A3` light / `#525252` dark) by default; when split
by severity use the signal colors above at full strength, thin bars, gridlines `--border`, no
chart backgrounds, no rounded bar tops.

## Typography
- **Inter** (UI, via `next/font/google`, enable `font-feature-settings: "cv11", "ss01"` and
  `tabular-nums` for numbers) and **JetBrains Mono** ONLY for ids, hashes, JSON, code, log
  templates. KPI values and table numbers use Inter with tabular figures, NOT mono.
- Sizes: 12 meta · 13 tables/nav · 14 body · 16 inputs on mobile · 15/600 section titles ·
  20/600 page title · 24/600 KPI values. Headings letter-spacing `-0.01em`.
- Labels are sentence case, 12–13px, `--fg-muted`, weight 500. **No uppercase, no tracking.**

## Layout
- **Sidebar** (220px): `--subtle` background, right border, NOT dark. Product name as plain
  text (small square logo mark allowed, monochrome). Items: icon (16px, `--fg-subtle`) + label
  (13px). Active = `--hover` background + `--fg` text; no colored bars. Approvals shows a plain
  count. Collapses to icon rail < 1280px (tooltips + aria-label), drawer < 768px.
- **Top bar** (48px, bottom border, `--bg`): breadcrumb only (this IS the page title — do not
  repeat it as an H1 on top-level pages), search field (`/`), connection status as a tiny dot +
  "Live" in `--fg-subtle`, theme toggle (sun/moon icon button), "New incident" (primary, black),
  avatar menu.
- Page gutter 32px desktop / 16 mobile; max content width 1280px; section spacing 32px.

## Components
- **KPI strip:** ONE bordered row divided by vertical 1px dividers (not separate cards). Each
  cell: label (13px muted) then value (24px/600). Optional one-line context in `--fg-subtle`.
  Cells are links to the filtered list (hover `--hover`).
- **Panels:** section title (15px/600) + optional right-aligned text link; content below. A
  border is allowed around tables/charts, radius 8; NO subtitle/description line under titles.
- **Tables:** no zebra, 1px row dividers, header row `--subtle` 12px/500 muted sentence case,
  row height 40px, hover `--hover`. Right-align numbers. Ids in mono `--fg-subtle`.
- **Severity:** 8px square in signal color + "SEV1" text (13px/500). No background.
- **Status:** 6px dot in signal color + status text in `--fg`. No pill, no icon, no bg. Running
  states' dot may pulse gently (off under reduced motion).
- **Buttons:** primary = black (white in dark), secondary = `--bg` + `--border-strong` border,
  ghost = text only. Radius 6, height 32 (44 on touch). One primary per screen.
- **Empty states:** one line of muted text, optionally a text link. No illustrations/icon circles.
- **Focus:** 2px `--link` ring, 2px offset.
- **Icons:** lucide-react, 16px, stroke 1.5, `--fg-subtle`, only where they aid scanning.

## Motion
120–160ms ease-out on hover/press only. No entrance animations on page load. Reduced motion
respected.

## Anti-patterns (hard no)
Dark/navy sidebar · uppercase tracked labels · subtitle under every card title · one card per
metric · pill badges with icons + tinted backgrounds · gradients, glows, colored shadows ·
icon-in-a-circle empty states · explanatory sentences under page titles ("Every tile opens…")
· duplicate page titles · monospace digits for KPIs · emoji · more than one accent color ·
decorative icons in headings.
