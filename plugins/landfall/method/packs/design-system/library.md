# Design system library

**Purpose:** one design system from tokens to exported code: order of work, tokens, components, the library file, versions, documentation and the code export. **Reads:** designer; implementer for the export and UI code; reviewer. **When:** a project with a UI: building or changing the design system, its tokens or components, or exporting them to code.

**Section map**
- §Order of work — mockups, library, export, design principles with evidence, build scripts.
- §Tokens — collections, aliases, descriptions, renames, dark mode, contrast, text styles.
- §Components — library pages, build order, Text and Surface, variants, icons, slots, descriptions, audit.
- §Library file — two files, the file guard, key export, mockup conversion, mockup audit.
- §Versions and documentation — semver, release artifacts, generated cover and docs, the code repository's page.
- §Export to code — the export task, conflicts, the theme generator, the tokens-only constraint, typed accessibility, names, changes.
- §Tool traps — design-tool automation traps.

## Pack: design-system

### Order of work
**DSG-1.** Work in this order: hi-fi HTML mockups (one token set, one type scale, design principles `DP1…DPn`) → library built by scripts from the mockups' CSS → mockups rebuilt from library instances → export to code → the tokens-only test → behavior gates.
**DSG-2.** A design principle `DP<n>` has evidence from discovery (a need code or a register URL); component descriptions and do/don't lists cite it by number.
**DSG-3.** Build scripts are idempotent and return invariants (counts per collection, 0 variables without scope or code syntax, 0 semantic variables without Dark); a broken invariant aborts the run.

### Tokens
**DSG-4.** Tokens form three collections: Primitives (raw values, hidden), Semantic color (Light and Dark modes, aliases only, scoped to fill, text or stroke) and Size (spacing, radii, dimensions, each scoped).
**DSG-5.** MUST NOT put a raw value into the semantic collection or use a primitive directly in a component.
**DSG-6.** Every primitive, variable and style has a description: a primitive its value and the reason for each change, a variable its scope, use and code syntax, a text style its metrics, use and second state carrier.
**DSG-7.** A color without a token takes an existing role; never create a new token for it.
**DSG-8.** Rename a variable in place (its ID stays) and let a script check that no old name remains.
**DSG-9.** Dark mode is the second mode of the semantic collection, set on the screen frame; MUST NOT create Light and Dark variants of components.
**DSG-10.** Dark values are new primitives computed by a script: the same hue, lightness moved until contrast passes with a margin (default 4.6–4.8).
**DSG-11.** Keep a list of contrast pairs: text ≥ 4.5, UI elements and graphics ≥ 3.0 (WCAG 1.4.11), each passing in every mode.
**DSG-12.** Darken a primitive that fails contrast minimally and record the reason in its description.
**DSG-13.** A state MUST NOT be conveyed by color alone; record its second carrier (for example font weight) in the style description (WCAG 1.4.1).
**DSG-14.** Text styles use one font family and names from the role scale (display, headline, title, body, label, caption, overline).
**DSG-15.** Merging or removing a style is a MAJOR change: rebind its nodes to the target style first, then remove the source, and the target's description lists what it absorbed.

### Components
**DSG-16.** Library pages: Cover · How to use · Changelog · Foundations · Atoms · Molecules · Organisms · Templates.
**DSG-17.** Build in dependency order (icons → text → surface → … → screen), then fit slots, add variants in place and repair property references.
**DSG-18.** Text is an instance of `Text` (a variant per style), background and border an instance of `Surface`; outside components only layout containers remain.
**DSG-19.** Promote a pattern assembled ad hoc in mockups to a component at the design-system review.
**DSG-20.** Add a variant in place (a new axis, keys unchanged); a rebuild with a new key is a MAJOR change.
**DSG-21.** Swap an icon with an instance-swap property, not a variant; a glyph is one layer colored from a token.
**DSG-22.** A slot frame hugs its content; a component placed in a slot has a hugging outer frame and a fixed interior.
**DSG-23.** Express continuous values (progress) as variants, because instance layers cannot be scaled.
**DSG-24.** Every component has a description: size tokens, usage and the design principles it follows.
**DSG-25.** Take system UI (keyboard, alert, share sheet) from the platform's UI kit, not from the design system.
**DSG-26.** The component page audit finds 0 unbound fills and strokes, 0 texts without a style, 0 raw spacings and radii, 0 default layer names and 0 components without a description.
**DSG-27.** Change a component's look, color included, in the design system (variant in place, then a rebuild of the mockups); MUST NOT override it in a mockup.

### Library file
**DSG-28.** The library (tokens, styles, components) and the mockups (instances of the published library, imported by key) are two files; MUST NOT copy components locally into mockups.
**DSG-29.** Every design-tool automation task MUST start with a file guard: `if (fileKey !== TARGET) throw 'WRONG_FILE'`.
**DSG-30.** Export the library keys (name → key) to a data file; the mockup builder imports only through it.
**DSG-31.** Converting mockups maps each color to the nearest token allowed for its scope and mode and each text to the nearest style; a miss goes to a report, never a raw value.
**DSG-32.** The audit after building mockups finds, outside the design system, 0 texts, 0 frames with their own look and 0 vectors, and also 0 clickable elements without a target, 0 screens placed on screens and 0 arrows on screens.

### Versions and documentation
**DSG-33.** Version the design system by semver: MAJOR = a removed or merged token or style, or a new component key · MINOR = a new component, variant or token · PATCH = a visual or documentation fix.
**DSG-34.** Release artifacts: `VERSION`, `CHANGELOG.md`, the tag `ds-vX.Y.Z`, version and commit on the cover and in the publish note; the release commit touches only these and the component scripts.
**DSG-35.** A script generates the cover and the changelog from git: it warns when the tag is not HEAD, appends `-dirty` for uncommitted changes and shows "?" without data.
**DSG-36.** Before the first release, decide who publishes; updating the status file is an item of the release checklist.
**DSG-37.** A script generates the library documentation: foundations with samples in both modes and the contrast table, components with description, properties and a dark preview.
**DSG-38.** "How to use" covers collections, naming, code syntax, dark mode and do/don't with principle numbers (don't: primitives used directly, Light/Dark variants, detached instances).
**DSG-39.** The code repository has a design-system page (pipeline design tool → `tokens.json` → theme → UI kit → screens, the component-to-library table, principles with their tests, the change procedure) linked from the packages' READMEs.

### Export to code
**DSG-40.** The export is one read-only automation task with a file guard that writes `packages/tokens/tokens.json`, `design/icons/*.svg` (`currentColor`), `design/components.json` (keys, properties, usages) and `design/screens/<id>.png|.json`.
**DSG-41.** When the export disagrees with another source, the design tool wins; a mockup conflict is settled by the design system, and the mockups go on the fix list.
**DSG-42.** A generator writes the theme file (GENERATED): it resolves aliases, a mismatch with the mode values aborts the build, geometry outside variables lives in the generator, and a determinism test guards it.
**DSG-43.** Global Constraint: "All colors, spacing, radii and typography come from the tokens package; hard-coded values do not pass review."
**DSG-44.** A tokens-only test guards that constraint with rejected patterns per stack, checks itself and asserts its scope (COD-11).
**DSG-45.** A smoke test fails when a newly exported component has no test.
**DSG-46.** Pass a color by token name (`color="onSurfaceMuted"`) and read it through `useColors()`; only one file imports the raw theme.
**DSG-47.** Types enforce accessibility: a clickable element has a role, a target ≥ `size/touch` and a `testID`, and `disabled` requires a `disabledReason` for screen readers.
**DSG-48.** A component's code name equals its library name (`Record row` → `RecordRow`) and a variant is a property (`variant="primary"`).
**DSG-49.** Change the design system only in a shared task (the orchestrator dispatches it, the designer does it, a code owner approves in a team), never alongside a screen; a missing component or token stops the implementer with NEEDS_CONTEXT.
**DSG-52.** A design-system change runs: library change in place → design-system release → export (DSG-40) → token build with a review of the theme diff → affected UI components and their docs → tests in the order tokens, UI (tokens-only, smoke), typecheck, app, E2E.

### Tool traps
**DSG-50.** In design-tool automation, re-create and check property bindings after cloning a variant or moving layers (they do not move), store the resolved value with a variable-bound paint, and set opacity on the layer, not the paint.
**DSG-51.** In design-tool automation, read text truncation back after setting it on an instance and load fonts in parallel; publishing the library and closing comment threads stay with a human unless a decision allows automating them.
