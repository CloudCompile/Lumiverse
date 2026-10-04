# Lorebook authoring workspace: independent navigation and tabs

This extends the uncommitted native workspace structural pass on `codex/lorebook-entry-organization`. The previous folder/tag feature remains committed at `1b8ef479`; no new commit, push or PR was made for the workspace changes.

## Interaction model

- Books chooses a world book. The folder/entry navigator uses one physical pane: folder root drills into a contextual entry list, and Back returns to folders.
- Opening a row adds or activates its workspace tab. Reopening the same entry reuses the tab. Changing folders, tags, search or pages does not evict open editors. Activating a tab does not reveal or select its folder in the navigator.
- Books and Entries collapse independently. With both collapsed, the tabs and editor use the available authoring area.
- Each visited book keeps its mounted navigator and working set for the lifetime of the modal. Switching books preserves draft nodes, editor scroll and local navigation state. Tabs are session state, not stored settings; reloading or closing the modal clears the working set.
- Desktop tabs support arrow keys, Home and End. Closing a tab selects a nearby remaining tab and restores focus. It does not call delete and does not cancel queued entry saves.
- Split is deliberate and desktop only. It chooses another open entry, supports selecting the comparison entry and swapping panes, and shows at most two editors. Closing split keeps both tabs. There is no drag-to-split or recursive pane layout.
- Mobile uses an open-entry switcher rather than a desktop tab strip. Back restores the navigator while keeping editors mounted. Switching entries uses the same draft nodes; split controls are absent on phone widths.
- The narrower entry navigator uses quiet type/position metadata, wrapped labels and filters, and icon-sized open controls. Type/position editing remains in the main editor.

Folders continue to be derived from entry metadata. This does not introduce independently persisted empty folders or change the folder/tag backend model.

## Data and lifecycle

`useEntryWorkspace` owns a paginated navigator collection, cached working objects and ordered open IDs. A page replacement updates matching cached objects without evicting off-page tabs. Functional mutations apply to both collections, so optimistic fields, server revisions, conflict reconciliation, WebSocket changes and confirmed deletion share the existing pipeline. Closed tab objects remain cached during the modal session so queued writes retain their revision preconditions.

Revision lookups and organization action snapshots include cached off-page entries. Server-confirmed deletion removes a cached object and its tab; closing a tab only removes the open ID. A newly created entry can enter the workspace even if current filters exclude it from the navigator. The existing core editor remains responsible for dirty fields, save intent and conflict UI.

Visited book sections remain mounted during a book switch. Only the active section consumes the pending deep-link request and reports its entry count. Vector summary callbacks are guarded by the active book ID so background saves cannot replace another book's header status.

No backend, API, migration, dependency or lockfile changes were made. Core Spindle mounts and shared legacy fullscreen CSS remain as documented in the first-pass handoff. No new Suite coupling was added.

## Verification

- Focused frontend tests: **54 pass, 0 fail**, 232 assertions across nine files. Includes folder/tab independence, retained draft nodes, off-page revision-guarded saves, closing a tab with a queued save, external deletion preserving the other editor, split/swap/close behavior and earlier organization regressions.
- Controlled workspace diagnostics: **12 viewport/scale cases** across Chromium, Firefox and WebKit, desktop/mobile at scales 1 and 1.25. Adds cross-folder tabs, keyboard tab navigation, independent Entries collapse, split/swap/close, mobile switcher and per-book draft retention to the original fullscreen/pagination/vector-boundary checks.
- Controlled organization diagnostics: **27 cases pass** across all three engines.
- Frontend TypeScript, lint and checked production build were run. Hook dependency warnings found during the first lint run were corrected; the subsequent lint run has no errors or warnings.
- Live review uses only the existing controlled fixture books at `http://kl:7860/`; entry data is not modified during this pass. Desktop/mobile screenshots and the final visual-check result are recorded below after completion.

Logs are local and contain controlled fixture output: `%TEMP%/lorebook-tabs-tests-final.log`, `%TEMP%/lorebook-tabs-browser-final.log`, `%TEMP%/lorebook-tabs-organization-browser.log`, `%TEMP%/lorebook-tabs-typecheck-final.log`, `%TEMP%/lorebook-tabs-lint-final.log`, `%TEMP%/lorebook-tabs-build-final.log`.

Generated `frontend/dist` stays uncommitted for the running review instance. Exclude it from a future source commit/PR. The previous historical full-suite failures are still recorded separately; this pass makes no new full-suite claim. Physical phone keyboard behavior, Tauri and installed Suite permutations remain unverified.

## Final live review

The rebuilt instance was checked at 1200x900 desktop and 412x915 mobile using the existing controlled destination book. Verified two open tabs, arrow-key switching, independent Books/Entries collapse, split and swap, closing split without closing tabs, mobile Back and the open-entry switcher. The final mobile header has one Back control, active title, open-count button and entry actions; it no longer duplicates the Entries row. Entry content was not edited. A separate fresh review tab was used for the last build so the user's ongoing inspection was not reloaded. Temporary viewport overrides were reset.

Screenshots: `lorebook-tabs-desktop.png`, `lorebook-tabs-split.png` and `lorebook-tabs-mobile.png` in the thread's visualization directory. Final production build: `%TEMP%/lumiverse-lorebook-tabbed-workspace-01a10465` (29 files, byte-verified). The live dist remains served and uncommitted. Staging is empty and source whitespace checks pass.

## Form refinement follow-up

The form density, activation and hierarchy follow-up is documented in [lorebook-form-refinement.md](lorebook-form-refinement.md). Its verification supersedes the pending form-pass note from the structural handoff.
