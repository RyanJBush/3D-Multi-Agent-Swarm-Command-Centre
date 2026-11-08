# Trace Inspector

Local-only tool that validates a trace, replays it deterministically, and shows it in an accessible 2D table or a 3D agent graph, both driving one shared event inspector. Nothing is uploaded: files are read in the browser with `FileReader`, and the built page's CSP sets `connect-src 'none'`.

## Requirements

Use Node.js 22.23.4 for the verified setup. Node 22.19.0 is below jsdom's supported version range. npm 10 or newer.

## UI refinement by ChatGPT

- Mobile event rows show event ID, role, readable event type, and status without hiding diagnosis behind a wide timestamp column. Full UTC timestamps remain in the inspector; desktop table timestamps show the time with the full value in a tooltip.
- Failure summaries link to the nearest handoff in the failed call's explicit parent chain. They do not infer causality from nearby events or reveal future events.
- Larger, higher-resolution handoff labels improve the 3D graph's label treatment. Keyboard-accessible graph controls remain available.
- Inspector details use the available width, with desktop sticky positioning, larger mobile controls, and retained light/dark themes.

Verification for this refinement: TypeScript check passed; 265 tests passed across 8 files; production build passed under Node 22.23.4. Dependencies were reused from the installed project after confirming identical lockfile SHA-256 hashes; the fresh-install attempt in the review environment failed with npm's "Exit handler never called" error. No dependency versions changed.

Manual desktop smoke check in the in-app browser on 2026-11-08: the updated interface loaded; Prior handoff e02 selected planner -> implementer without moving the replay position; Explanation e04 showed ENOENT and the missing requirements.txt message; switching to 3D preserved selection and rendered the graph. This was a solo functional check, not a usability study or complete browser regression run. Mobile layout, screen-reader behavior, and rendering performance remain unverified for this refinement. Known visual issue: at six revealed events, handoff labels can overlap the implementer label. No usability or performance improvement has been measured.

## Commands

```
npm ci                  # install exactly what package-lock.json pins
npm start               # local dev server: http://localhost:5173
npm run typecheck       # tsc --noEmit (strict)
npm run test -- --run   # vitest, one pass
npm run build           # production bundle in dist/
npm run preview         # serve dist/ at http://localhost:4173
```

GitHub CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, test, and build. [The first GitHub run passed](https://github.com/RyanJBush/trace-inspector/actions/runs/42444697400) on 2026-11-08 for commit `ff4cbde`: clean `npm ci`, typecheck, 265 tests across 8 files, and production build, using Node 22.23.4 and npm 10.9.9 on Ubuntu.

Optional real-browser keyboard walkthrough (needs Playwright + Chromium installed separately; not a project dependency, not run by CI):

```
npm start &                                   # or: npm run build && npm run preview -- --port 4173
node scripts/browser-walkthrough.cjs http://localhost:5173/
node scripts/browser-3d-walkthrough.cjs http://localhost:5173/   # also needs Python 3 + Pillow
node scripts/ui-layout-check.cjs http://localhost:5173/ [screenshot-dir]
```
These are scripted checks. They are not human evaluation and are not evidence that 3D is better than 2D.

## Files

| Path | Purpose |
| --- | --- |
| `fixtures/synthetic-trace.json` | Canonical synthetic trace (schemaVersion 1.0). Do not edit; tests copy and mutate it in memory. |
| `src/types.ts` | Contract types, enums, issue codes. |
| `src/validate.ts` | Whole-trace runtime validation of untrusted JSON; sorts by sequence; deep-frozen output. |
| `src/replay.ts` | Pure replay: state after the first N events, derived call status, fingerprint. |
| `src/controller.ts` | Replay position, selection, and the single playback timer. No DOM dependency. Both existing views (2D table and 3D graph) share this one controller. |
| `src/app.ts` | Table, controls, inspector, view switch, and the 3D view's text equivalent. Untrusted text goes through `textContent` only. |
| `src/graph.ts` | Pure `buildGraph(ReplayState)`: three fixed nodes, handoff edges, failure markers, plus the `View3D` interface. No state of its own. |
| `src/view3d.ts` | Three.js renderer, loaded lazily on first use. WebGL probe, context-loss watcher, picking. |
| `tests/` | Validator, replay, controller (fake timers), and DOM tests (jsdom). |
| `scripts/browser-walkthrough.cjs` | Scripted real-browser keyboard walkthrough of the 2D view (optional). |
| `scripts/ui-layout-check.cjs` | Scripted layout measurements (1280 px and 375 px) and the e02/e03/e04 diagnosis in both views (optional; not a usability study). |
| `scripts/browser-3d-walkthrough.cjs` | Scripted real-browser checks of the 3D view, fallback, and context loss (optional). |

## Contract summary (what the validator enforces)

Run: `schemaVersion` is `"1.0"`, `runId` nonempty string, `synthetic` boolean, `events` nonempty array. Event: all nine fields present; `eventId` unique nonempty string; `sequence` unique positive integer, contiguous from 1 after sorting (input array order is irrelevant); `timestamp` exactly `YYYY-MM-DDTHH:mm:ss.sssZ` and a real calendar instant; `agentRole` in planner/implementer/reviewer; `eventType` in task_started/handoff/tool_call/tool_result/review_completed; both reference fields null or an existing event with a lower sequence. Per type: `task_started` (outcome started, message); `handoff` (outcome success, message, `toAgentRole` an allowed role different from the sender); `tool_call` (outcome started, toolName, path); `tool_result` (outcome success/failure; parent and related identify the same earlier tool_call with the same agentRole; failure needs errorCode and message); `review_completed` (outcome success/blocked, message). Every issue names the event and field. Timestamps are never used for ordering and are not required to be monotonic.

## Replay semantics

- Event IDs are arbitrary nonempty strings (including `constructor`, `__proto__`, or IDs with quotes). Replay state uses `Map`s keyed by ID, and the UI compares `data-event-id` values directly instead of building CSS selectors.
- Ordering is by `sequence`. State at position N is a pure function of the first N events; the source trace is never mutated.
- A tool_call's raw `outcome` stays `"started"` forever. The UI shows a **derived** call status: open until a tool_result referencing it is applied, then failed or succeeded. At position 3 e03 is open; at position 4 it is failed.
- Unrevealed events are not rendered, selectable, linked, or included in replay state.
- Initially paused at position 0 with nothing selected. **Step** applies one event and selects it. **Play** applies one event per 1,000 ms (also selecting it) and stops after the last event; Pause cancels; resume starts a fresh interval; at most one timer exists. **Reset** cancels playback, clears selection, returns to 0. Selecting a revealed event pauses playback and leaves the applied count unchanged. The slider and Step back seek: they pause, recompute from the prefix, and move a selection that would point past the prefix to the latest applied event (cleared at 0).
- Step (while playing) pauses playback; this is a choice, since the contract does not specify it.

## 3D view

Switch with **Table (2D)** / **Graph (3D)** above the events. Both views read the same `ReplayController`; there is no second replay state, so switching preserves replay position and the selected event.

- **Nodes:** three fixed, labelled agents (planner, implementer, reviewer). Selecting a node selects that agent's latest *revealed* event (events whose `agentRole` is that agent). If it has none, the page says "<role>: No events yet." and preserves the current selection.
- **Edges:** one directed edge per *applied* handoff, labelled with its event ID. Selecting an edge opens that event in the shared inspector.
- **Failure marker:** appears only after a failed tool_result is applied (e04 in the canonical trace). It is red *and* labelled "FAILED e03 → e04", and the text equivalent reads "Failure marker: e03 read_file(requirements.txt) failed with ENOENT. Explained by e04." with buttons for the failed call and its explanation.
- **Keyboard / screen readers:** the canvas is not keyboard-operable. Below it, a text equivalent offers the same nodes, edges, and failure marker as native buttons, driving the same selection.
- **Selecting from the graph pauses playback**, like selecting a table row.
- **Fallback:** 2D never depends on WebGL, and Three.js is loaded only when 3D is first requested. If WebGL is unavailable or the module fails to load, an alert explains and the 2D table stays active. If the WebGL context is lost while 3D is open, the app closes the 3D view, shows an alert, and returns to 2D with position and selection intact. You can switch back to 2D manually at any time.

### Walkthrough (about two minutes, keyboard only)

1. `npm start`, open http://localhost:5173. Tab to **Step forward** and press Enter twice. The table shows e01, e02, with e02 selected.
2. Tab to **Graph (3D)** and press Enter. Three labelled nodes appear, planner highlighted (its latest event e02 is selected), and one edge, "e02: planner → implementer". The status row still reads "Applied 2 of 6."
3. Activate "implementer — No events yet": the page says "implementer: No events yet." and the selection stays e02.
4. Step forward twice. The failure marker appears with "Failure marker: e03 read_file(requirements.txt) failed with ENOENT. Explained by e04."
5. Press **Failed call e03**: the inspector shows read_file, requirements.txt, parent e02, raw outcome "started", derived status "Failed". Press **Explanation e04**: ENOENT, the message, linked call e03.
6. Press **Table (2D)**. Same position, same selected event.

## Accessibility notes

Native buttons, labelled controls, a captioned table with scoped headers, visible focus outlines, `aria-current` on the selected event, a named inspector region, and a polite live region for replay status. Focus is preserved across re-renders (including playback ticks). When a control becomes disabled while focused (for example Step forward at the end), focus moves to Reset. Screen-reader testing: **not performed** (pending).

## Proposed evaluation—not yet conducted

No participants have been recruited and no study has been run. This is a protocol proposal only. The scripted browser walkthroughs in `scripts/` are automated checks, not human evaluation, and their results must never be mixed with study data.

- **Material:** the unchanged synthetic fixture (`fixtures/synthetic-trace.json`) and the same diagnostic task in both views (2D table and 3D graph).
- **Task:** identify (1) the prior handoff, (2) the failed call, (3) the explanation of the failure.
- **Correct answers:** prior handoff `e02`, failed call `e03`, explanation `e04`.
- **Measures:**
  - per-answer accuracy (e02, e03, e04 each scored correct/incorrect);
  - joint e02/e03 accuracy (both correct);
  - time to first fully correct answer, with a 120-second limit. A trial not fully correct within 120 seconds is incomplete and has no time-to-correct value (it is not recorded as 120).
- **Design records:** participant count, view order, and trial position for every trial. Alternate which view comes first across participants. Report first-view results separately from second-view results, because the second trial is affected by prior exposure to the same fixture.
- **Not yet decided:** target sample size and statistical analysis plan. These must be fixed before data collection.
- **Claim boundary:** this study cannot show that 3D improves diagnosis unless it is run and supports that. No such claim is made now.

## Known limitations

- The 2D/3D screen redesign (header, toolbar, status row, two-column layout, inspector, failure summary) is a visual and structural change. No usability improvement has been measured, and nothing here shows faster or more accurate diagnosis.
- No SwarmOS integration, no SwarmOS trace inspected. No live execution or workflow editor.
- 3D checks ran in Chromium with a software WebGL renderer (SwiftShader). No GPU rendering and no performance measurements were taken; no performance claims are made. The 3D chunk is about 550 kB (137 kB gzip), loaded only on first use.
- The 3D view has a fixed camera and no orbit controls; labels are canvas textures. Cleanup covers the geometries, materials, and map (label) textures the view owns, through `disposeObject3D` in `src/view3d.ts`, tested by `tests/view3d-cleanup.test.ts`. Edge and failure-marker objects, with their label textures, are disposed on every rebuild. The three node meshes and their label textures stay allocated until the view closes. Three.js's shared sprite geometry is not owned by the view and is not disposed. This was verified with a mocked renderer; GPU memory was not measured.
- No axe/automated accessibility audit and no screen-reader testing of any kind.
- GitHub CI verifies installation, types, unit/DOM tests, and the build. It does not run the optional real-browser scripts or a human diagnostic study.
- No GPU-memory measurement and no rendering-performance measurement.
- The contract does not say whether a tool_call may receive more than one result; the validator does not forbid it, and replay closes a call on the first result applied.
- Browser checks ran in Chromium 153 only (Playwright) with software WebGL. Firefox/Safari untested.
