# Design — Agent Framework

## Scope and context

Deep-space glass web application for developers and business operators configuring Agent roles, workflows and governed tasks. Existing API, business tool simulation, consent, authorization, verification and recovery semantics remain intact. Twelve routes share one design system; no marketing page or fabricated activity is added.

## Genre and structure

Atmospheric, native productivity workspace with restrained cyber influences. App family: Index-First (overview → searchable resources → contextual details). N13 command search plus grouped persistent navigation; mobile uses a labelled navigation sheet, not nine tiny unlabeled tabs. Footer: a compact live connection status line. Preserve all routes and component ownership.

## Theme

Deep Space Glass: dark indigo is the default appearance, with cyan and ultraviolet accents, layered translucent panels and restrained edge illumination. A browser-local choice supports light/dark/follow system; light mode uses a low-glare daylight interpretation of the same palette. Semantic variables in `webui/hig.css` override existing tokens; existing global CSS is preserved. Data and form surfaces remain nearly opaque and highly readable, while decorative blooms stay behind content. Reduced transparency and increased contrast receive opaque chrome. Semantic success, warning and error colors remain independent of the decorative accents.

## Typography and geometry

Display uses the locally bundled Space Grotesk with the platform stack for Chinese fallback; body uses the platform system stack (-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC); SFMono/system monospace is reserved for identifiers and technical eyebrows. No external font request is required. Typography roles are declared in `webui/ui_details.css`: page titles 28px desktop / 24px phone, section titles 18px, dialog titles 20px, body 14px desktop / 16px touch, labels 14px, help 13px desktop / 14px touch, metadata 12px. Roman headings and unitless reading line heights. Four point spacing scale; fields use a compact 40px desktop height and 44px touch height, with 8px corners. Content panels retain 18px corners and dialogs 24px.

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

All visible single-select controls across routes and dialogs progressively enhance native selects; multi-select fields and hidden state fields remain native. The native value, constraints and existing APIs remain authoritative. Short menus open directly into their option list; longer catalogs and domain, Agent and model choices retain filtering, result counts and keyboard hints. Popovers support arrow keys, Home/End, Enter, Escape, Tab and explicit empty-state recovery. Their Deep Space Glass surfaces share the application tokens, with distinct selected and keyboard-active options. Resource-creation and workflow-tool menus use the same surface treatment. Narrow screens use a bottom-sheet presentation, and reduced transparency receives an opaque surface. Task goals and work instructions show length limits and grow within a bounded reading area.

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

## Shared controls — interaction consistency

Use the `--control-*` tokens in `hig.css` for form fields and select triggers: 40px minimum height, 8px radius and 14px text on desktop; narrow screens and coarse pointers use 44px and 16px text. Textareas keep their reading height; browser date/time controls may be slightly taller. Fields have opaque neutral surfaces and quiet neutral borders rather than glass or saturated outlines at rest. Hover deepens the neutral edge; focus adds the existing blue accent without changing geometry. Compound search fields put one focus ring on their enclosing surface. Disabled, read-only, busy and invalid states use shared semantic colors and retain their field help.

Dropdowns use an opaque 12px-corner surface and a small elevation shadow. Hover and active options use a neutral fill; selection uses a subtle blue fill and checkmark. Keyboard focus is drawn around the active option instead of the whole list. Fixed enums such as run status and sorting explicitly suppress search, counts and keyboard-hint chrome; growing catalogs retain search. Mobile dropdowns remain bottom sheets with the same surface language.

The run directory initially exposes search, status, sorting and a labelled filter button. Agent, domain and date controls appear on request; selected advanced conditions remain visible as removable chips when collapsed. Changing or clearing filters resets pagination while preserving the user's sort choice. Clearing returns focus to search. Invalid date ranges keep their draft with an inline explanation and never reach the server; polling continues to use the last valid range. Empty or single-page results omit unnecessary paging buttons, and page numbers never wrap.

Select labels exclude hidden native options and popup content. Disabled options and groups remain visible and cannot be chosen, including after an asynchronous update. Advanced fields enhance when revealed; native resets restore the displayed value. Menus remain anchored while their scroll container moves and adapt to visual viewport changes. Keyboard users can reach search recovery and creation actions before continuing to the next field; Escape returns to the trigger without dismissing its dialog. Short lists also support character navigation and Space. Action menus share arrow/Home/End navigation, outside/focus dismissal and Escape restoration.

The `controls`, `control-routes` and `run-filters` browser suites in `scripts/run_browser_tests.py` verify these rules with isolated data. They cover twelve routes, representative dialogs, keyboard and IME input, light/dark appearance, touch pointers and 320/375/414/768/1440px widths. The run-filter suite checks real combination queries, date validation and cursor pagination against saved fixtures rather than mocked UI rows.

## Detail review — typography, geometry and density

The shared role layer `ui_details.css` loads after route styles and removes local typography drift without changing routes or business behavior. Important phone instructions and labels are at least 14px, ordinary prose is 16px, and 12px is reserved for secondary metadata. Controls can grow with enlarged text; dialog footers wrap instead of clipping actions.

Compound search shells include their border within the field height. Adjacent search buttons and select triggers share the same 40px/44px geometry. Desktop knowledge status filters use 176px instead of consuming half the toolbar. Empty panels use 32px desktop / 24px phone padding and content-driven height. Phone knowledge tabs remain in one labelled, keyboard-accessible scrolling strip with an inset focus indicator.

Default control boundaries must reach 3:1 on their actual field background, including the skill editor's subtle surface. The fixed five-dimension scorecard, visual review and explicit verification limits are in `docs/ui-detail-review-20261028/`. The `ui-details` browser suite measures 240 normal contexts and 21 enlarged-text contexts; its fixtures never enter the daily data directory.
