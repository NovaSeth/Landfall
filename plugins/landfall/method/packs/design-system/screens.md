# Screens and behavior gates

**Purpose:** UI code that never hides a failure, mockups that code and tests can consume, and gates that judge behavior, not pixels. **Reads:** implementer, reviewer, designer; orchestrator for gates. **When:** a project with a UI: building screens, writing E2E flows, preparing mockups for code, running an area gate with UI.

**Section map**
- §Screen code — read states, back navigation, navigation after writes, the error boundary, system surfaces, definition of done.
- §E2E and devices — dev links, assertions, native changes, screenshots, shared components.
- §Consumable mockups — area pages, screen heights, stable row numbers, out-of-scope screens, API map, rebuilds, screen IDs, comments.
- §Behavior gate — what the gate checks, diagnostic visual QA, model verdicts, classification.

## Pack: design-system

### Screen code
**SCR-1.** A read error is not an empty result: show loading, empty and error states (cause, next step, retry); MUST NOT show an error as "no data".
**SCR-2.** Back inside a tab returns to the tab's previous screen or a fallback, and on a stack it closes to the main screen; MUST NOT call `back()` on the global history.
**SCR-3.** Gate back navigation with a test that enters the screen from another tab and from a deep link on the real layout tree.
**SCR-4.** Navigate after a successful write through a shared hook that never navigates from an unmounted screen.
**SCR-5.** One error boundary sits in the shell inside the providers; recovery clears the start route's parameters, mounts from it and navigates to the target, and an E2E route that throws during render tests it.
**SCR-6.** System surfaces (notification, lock screen, share sheet, biometrics) are not screens: implement the call and the navigation target, and let the backend build notification content.
**SCR-7.** A screen is done with a catalog route and a stable test ID, data only through the API layer, every mockup state reachable by a mock scenario, transitions matching the area map, a render-and-main-action test and a step in the E2E flow.

### E2E and devices
**SCR-8.** An E2E flow starts from a dev link (reset, scenario, clock) and checks the screen ID; a run starts with a warm-up, and helper sub-flows are not tests.
**SCR-9.** E2E assertions are structural, with IDs from the API; on live data MUST NOT assert names or amounts, and demo writes are reversible.
**SCR-10.** A brief for a native change states what the dev preview does not exercise, the flow after a rebuild and the device preparation.
**SCR-11.** Save screenshots per platform and run with a timestamp in the name, and clear the directory at the start of a run. Symptom: the screenshot you looked at was old or from another platform.
**SCR-12.** When a shared component changes, review the assertions on its texts and accessibility labels. Symptom: a component change broke E2E in other lanes.

### Consumable mockups
**SCR-13.** An area page shows the main screen, ALL states (loading, empty, offline, no results, error, conflict) and the tree of screens reachable by clicks: an arrow from the first trigger, then numbered pills.
**SCR-14.** A screen is as tall as its content (at least the device height), except full-screen ones.
**SCR-15.** Map row numbers are permanent and a removed row leaves a gap, because tasks and tests cite them.
**SCR-16.** Before a rebuild, move screens cut from scope to an "Out of scope" page with the comment number; MUST NOT delete them.
**SCR-17.** Describe the API beside the map: a spec file (reads, writes, gaps per screen) generates the cards and the API map with gaps `API-<n>`, and the gap list sets the backend scope.
**SCR-18.** Before rebuilding an artifact (mockups, a document), read fresh comments, rebind by names rather than IDs, and abort on missing frames before deleting the old section. Symptom: lost comments and bindings.
**SCR-19.** The screen's root component sets `testID="screen-<mockup id>"`; nobody sets it by hand.
**SCR-20.** Answer reviewer comments in their thread, close them after the change, and keep open only those waiting for the PO.

### Behavior gate
**SCR-21.** An area gate with UI checks tests, E2E with behavior and data assertions, and code review, not pixels (PRI-13); its precondition is a clean mockup audit (DSG-32), the tokens-only test (DSG-44) and components matching the library 1:1.
**SCR-22.** Visual QA of mockup–app pairs is diagnostic only (a large design-system change or a PO request): deep link → `testID` → screenshot, with the status bar masked and the time taken from the data world.
**SCR-23.** A pixel difference is a signal; a model gives the verdict from both images and a fixed prompt as `{id, verdict: ok | minor | defect, diffs: […]}`.
**SCR-24.** Read the JSON numbers first and open images only for "defect" or growth above the threshold (default 1 percentage point); after swapping a shared component, review every pair that uses it.
**SCR-25.** Classify QA results as A (a defect of the area's code), B (a shared gap: component, token, fixture), C (a difference accepted by a decision) or "to decide"; the QA reviewer MUST NOT create decisions.
