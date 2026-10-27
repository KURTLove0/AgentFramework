# Design — Agent Framework

## Scope and context

Deep-space glass web application for developers and business operators configuring Agent roles, workflows and governed tasks. Existing API, business tool simulation, consent, authorization, verification and recovery semantics remain intact. Twelve routes share one design system; no marketing page or fabricated activity is added.

## Genre and structure

Atmospheric, native productivity workspace with restrained cyber influences. App family: Index-First (overview → searchable resources → contextual details). N13 command search plus grouped persistent navigation; mobile uses a labelled navigation sheet, not nine tiny unlabeled tabs. Footer: a compact live connection status line. Preserve all routes and component ownership.

## Theme

Deep Space Glass: dark indigo is the default appearance, with cyan and ultraviolet accents, layered translucent panels and restrained edge illumination. A browser-local choice supports light/dark/follow system; light mode uses a low-glare daylight interpretation of the same palette. Semantic variables in `webui/hig.css` override existing tokens; existing global CSS is preserved. Data and form surfaces remain nearly opaque and highly readable, while decorative blooms stay behind content. Reduced transparency and increased contrast receive opaque chrome. Semantic success, warning and error colors remain independent of the decorative accents.

## Typography and geometry

Display uses the locally bundled Space Grotesk with the platform stack for Chinese fallback; body uses the platform system stack (-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC); SFMono/system monospace is reserved for identifiers and technical eyebrows. No external font request is required. Body 15px, secondary 13–14px, identifiers 12px; headers 28–32 / 20 / 16. Roman headings. Four point spacing scale, 44px controls, 12px control radius, 18px content radius, 24px dialog radius.

## Interaction

One primary action per context. Search and filters preserve focus and input method composition. Long Agent configuration has named keyboard accessible sections; resource detail and JSON stay behind disclosure. Empty states guide the next action with real navigation. Explicit business authorization and model sharing consent remain reviewable. Destructive/recoverable actions keep existing confirmation and restore paths. Local preferences never modify task scope.

Feedback: pending labels/disabled controls, inline recoverable errors, visible run states and check results. Support Cmd/Ctrl+K, Escape and predictable tab focus. Refresh must not rebuild an active form or change the current route. Navigation sheet traps focus and makes covered content inert. Focus rings appear immediately.

## Motion and accessibility

No decorative animation or scroll reveals. Atmospheric background lighting is static. Short opacity/transform transitions use shared easing; no layout animation. Reduced motion removes spatial transitions. All icon controls have labels; state isn't conveyed by color alone. Check text contrast separately in light/dark, aim 4.5:1 normal text and 3:1 focus/essential boundaries. Verify root layouts at 320, 375, 414, 768, 1024 and 1440 CSS pixels and with increased text size. Wide workflow canvases may pan inside their labelled region; the page must not overflow horizontally.

## Reference

Interpretation for this web app, not a claim of native platform certification:
- https://developer.apple.com/design/human-interface-guidelines/design-principles
- https://developer.apple.com/design/human-interface-guidelines/materials
- https://developer.apple.com/design/human-interface-guidelines/accessibility

## Interaction journeys — 1.2.0

Normal task creation uses an editable goal and saved Agent. Task drafts survive configuration round trips. Runtime, instructions and read capabilities come from that frozen Agent; concrete business write proposals are authorized during legacy business workflow execution. Saved resources expose their next review/publish action; entering a newly created workspace is explicit.

Workflow nodes support pointer and keyboard movement plus click controls, with pan, zoom and fit for navigation. Mobile separates canvas and inspector into labelled panes. Layout coordinates are browser-local and do not change workflow API contracts. Motion is tied to navigation and state changes; polling stays still and reduced motion removes transitions.


## Agent creation and use — interaction review

Agent creation starts from blank basic information and stays within three steps; processing domains carry optional business guidance, independently of capabilities and deliverables. Optional role, description and runtime tuning remain behind disclosure. A saved Agent has a persistent next action leading directly to a task with its identity and version selected.

All visible single-select controls across routes and dialogs progressively enhance native selects; multi-select fields and hidden state fields remain native. The native value, constraints and existing APIs remain authoritative. Popovers support filtering, arrow keys, Enter, Escape, Tab and explicit empty-state recovery. Their Deep Space Glass surfaces share the application tokens, with distinct selected and keyboard-active options, result counts and keyboard hints. Resource-creation and workflow-tool menus use the same surface treatment. Narrow screens use a bottom-sheet presentation, and reduced transparency receives an opaque surface. Task goals and work instructions show length limits and grow within a bounded reading area.

Agent directory rows expose the saved revision and a labelled task action. Detail headers add runtime, model and domain metadata without replacing the configuration inspector. The three-step editor includes a live configuration summary on wide screens; narrow screens retain a single-column form and flexible, keyboard-scrollable step navigation.

Task setup uses a compact Agent summary and editable goal examples instead of duplicate locked choices. Configuration round trips preserve the task goal. Normal tasks use a chronological conversation with public runtime summaries, streamed output and results; follow-up requests keep the same task. Hidden reasoning is never displayed. Legacy business runs retain their records and result views. The earlier score is withdrawn in `docs/ux90/README.md`. Measured button geometry, interaction states and viewport checks are recorded in `docs/ui-strict/README.md`.


## Workspace-wide refinement — UI95

All twelve routes share the Deep Space Glass palette and Index-First structure. The fixed 50-item acceptance rubric is `docs/ui95/rubric.json`; final evidence and explicit validation limits live in `docs/ui95/`. Scores require evidence for each criterion and cannot average away a blocking usability problem.

Use a 12px minimum for visible secondary text, with 14–15px normal content. Empty workbenches show one actionable introduction; zero-value dashboards and an additional empty run list do not compete for attention. Resource tabs use a quiet selected underline. Capability listings lead with readable responsibilities and action names, while frozen identifiers and raw rules remain available through disclosure.

Workspace, resource, skill, workflow-start and operations forms share a stable header/footer and one scrolling body. Validation names the affected field, preserves its help references and focuses the first invalid field. A fresh dialog session clears old validation feedback. Operations settings protect unsaved changes on close and Escape. General notifications occupy a row in the top bar, and header height updates the scroll offset so feedback does not float over page actions.

## Agent directory and detail — Multica reference

The Agent route now follows a compact directory → linked detail → task structure. The public `/kl/agents` reference required sign-in during this review; local Multica source supplied the list, scope/filter/sort and inspector patterns. Preserve this project's Deep Space Glass tokens and task authorization rules; do not imply live availability from an Agent configuration's usable status.

Directory rows lead with identity and purpose, with actual status/domain/runtime metadata. Search, scope, domain, runtime and sort combine without replacing the active input. Browser history returns to the same directory context and link. Detail routes (`#/agents/:id` and instructions/skills/activity subroutes) separate responsibilities, instructions, frozen skill versions and actual recent task records, with a contextual configuration inspector. Mobile rows retain table semantics and accessible headers; archived detail allows viewing, inspection, copying and restoration while hiding edit and new-task controls.

Creating an Agent opens its detail; editing preserves directory filters and creates a new revision. A saved notice and next action use the authoritative save response even if the follow-up list read fails. Task records carry the selected Agent identity and frozen revision; the detail activity view explicitly describes the latest-200-run window. The fixed independent product-manager rubric and each review round live in `docs/multica-agent-review/`.
