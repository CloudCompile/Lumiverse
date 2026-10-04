# Lorebook workflow refinement

Branch: `codex/lorebook-entry-organization`. This follows the form refinement review. No commit, push or PR was requested or created; the index remains empty.

## Sidebar versus workspace

The sidebar now uses the existing inline entry editor with compact disclosures instead of the lightweight modal-launching presentation. Clicking the caret expands the actual row editor; clicking it again collapses the editor and retains the selected folder. It no longer opens a modal at folder root. Explicit Pop out still opens the native workspace separately.

The sidebar disclosure is now named **Book settings**, matching the modal, with a bordered theme surface and a clear summary label. This preserves existing book fields and actions without changing their persistence path.

## Presentation

- Organization shares the editor's `--world-book-detail-bg`, derived from existing theme background variables, and uses the same bordered section treatment. Editor vector status colors use existing warning/success/danger variables. The new CSS introduces no fixed color literals.
- Matching rules use a flex row in wider editor containers and an explicit two-by-two grid below 440px. Narrow split panes also use the grid.
- The single-checkbox Display options disclosure was replaced with a quiet Show token counts row. Mobile still exposes it through the existing filters/options toggle.
- While a mobile workspace entry is visible, the book title/count and Book settings section are hidden. Back to Entries restores them. An active workspace reports the detail-view state before paint; inactive book caches do not drive the visible header.

## Column edges

A small core `WorldBookColumnHandle` is shared by the native Books and Entries columns, with no extension or legacy Suite dependency. Sizes are local to the modal session. The existing Books collapse preference remains unchanged.

Books starts at 200px (140–320px bounds), Entries at 300px (200–420px bounds). Dragging below 100px/140px respectively collapses that column on release. Reopening retains the pre-drag width. Pointer movement is normalized by the actual rendered scale; release commits the final coordinate explicitly so delayed continuous-event rendering cannot discard the final size. Pointer cancellation or capture loss restores the starting width. Escape cancels the drag and does not propagate to the modal close handler.

Keyboard: Left/Right resize by 16px, Home resets the width, End collapses. Collapsing returns focus to the corresponding Show button. Mobile does not render these handles. Core mounted editors and drafts survive width/collapse changes.

## Verification

The focused lorebook regression set passed 59 tests with 266 assertions across nine files. The new sidebar regression expands and collapses an entry inside a named folder and checks retained folder context and absence of workspace tabs/deletes. Existing revisions, off-page saves, conflicts, pagination and draft-retention checks remain included.

The diagnostics harness now exercises real pointer capture, scale normalization, release thresholds, pointer cancellation, Escape and focus restoration in Chromium, Firefox and WebKit at desktop/mobile widths and UI scales 1 and 1.25. It also checks mobile header visibility and dynamic light/dark variables for shared organization/detail surfaces. Controlled fixtures use each engine's observed pointer ID rather than assuming a particular ID. Final combined run: **12 cases pass**, four per engine, on the final source. TypeScript, lint (no warnings) and checked production build pass. Source whitespace checks are clean. The served build was preserved at `%TEMP%/lumiverse-lorebook-workflow-refinement-01a10465` with every file byte-verified.

The final diagnostics exposed and now cover two scheduling issues: release explicitly commits the last coordinate in WebKit, and the mobile header report uses a layout effect so it updates before paint. Temporary tracing attributes were removed from product code; pointer logs exist only in the controlled diagnostics fixture.

Live read-only review used a separate tab and the existing controlled destination book at `http://kl:7860/`. Confirmed sidebar inline expand/collapse without a modal, retained folder context, consistent Book settings, desktop keyboard resize and mobile header hide/restore. No personal entries were edited. Temporary viewport overrides were reset. Screenshots in the thread visualization directory: `lorebook-workflow-sidebar.png`, `lorebook-workflow-desktop.png`, `lorebook-workflow-mobile.png`, `lorebook-workflow-mobile-matching.png`.

Logs: `%TEMP%/lorebook-workflow-tests-final.log`, `lorebook-workflow-browser-final.log`, `lorebook-workflow-lint-final.log`, `lorebook-workflow-build-final.log`. Historical full-suite failures remain documented separately; this pass makes no new full-suite claim. Physical phone keyboards, Tauri and installed legacy extension permutations remain unverified.

Generated dist remains served and uncommitted for review. Exclude it from any future source commit or PR. No dependencies, lockfiles, backend/API behavior, or unrelated architecture changed.


## Sidebar scroll/layout regression follow-up

The prior live screenshot had Injection and Activation collapsed, and the browser fixture exercised default-density modal editors. It missed two failures in the restored inline compact path: `overscroll-behavior: contain` intercepted wheel chaining in an unbounded nested editor, and the later dropdown `flex-basis: 120px` rule overrode the narrow stacked field reset, turning horizontal sizing into vertical gaps.

Inline entry rows now explicitly pass `scrollMode="parent"`. Compact editors in that mode use natural document height and visible overflow; the containing list/panel owns scrolling. Existing bounded compact callers keep their default self-scrolling behavior. Narrow stacked fields reset the complete flex shorthand, including dropdown-bearing fields, to natural height. Form values, disclosures and theme variables remain unchanged.

Verification: 23 targeted tests pass (172 assertions). The final nine-file lorebook regression set passes 60 tests with 277 assertions; log: `%TEMP%/lorebook-sidebar-scroll-tests.log`. The expanded harness passes 30 cases across Chromium, Firefox and WebKit: the existing 12 native workspace cases plus 18 actual inline compact sidebar width/scale cases. New cases assert natural Injection/Activation field heights, wheel movement of the outer sidebar over an editor label, no independent editor scroll position, activation selection and draft retention through disclosure changes. TypeScript/build generation, lint and checked production build pass. Source whitespace is clean and generated source files remain unchanged.

Live read-only checks on the controlled destination book confirmed expanded dropdown field heights of 49.5px on desktop and 54.5px at a 412px mobile viewport, with no horizontal overflow. Wheel scrolling while hovering the expanded editor advanced the outer panel from 999 to 1359 on desktop and 835 to 1064 on mobile. No personal lorebooks were edited. Viewport overrides were reset. Proof: `lorebook-sidebar-scroll-fix.png` and `lorebook-sidebar-scroll-fix-mobile.png` in the thread visualization directory.

This remains uncommitted with an empty index and no PR. The generated production bundle stays served for live review and must be excluded from a future source commit.


## Sidebar compact rows

The inline compact editor now uses the same wrapping field rows as the modal rather than forcing every control into a full-width column. Below 440px editor width, Injection uses explicit Position/Role/Order columns (Order 64px) and Activation uses two columns with the probability mode across the following row. Probability and Scan Depth share a numeric row. Identity fields retain their narrow single-column behavior; shared scrolling and the existing Group/Timing/Metadata layouts remain unchanged. All styling uses existing theme variables.

The compact sidebar diagnostics additionally check Injection row alignment, Activation Method/Status row alignment, Probability/Scan Depth alignment and horizontal containment at 320/440/560px widths and scales 1/1.25.


Final compact-row verification: all 18 sidebar cases pass across Chromium, Firefox and WebKit. The initial unconstrained wrapping implementation failed the narrowest Activation row assertion and was replaced with explicit narrow grids before completion. A later Firefox fixture navigation timeout occurred during severe memory pressure; the final sequential retry passes all engines. The first lint run was stopped deliberately to free RAM; the final lint retry and checked TypeScript/production build pass. Live read-only mobile review confirmed three Injection columns, paired Activation controls and paired Probability/Scan Depth, with hover scrolling still working. Screenshot: `lorebook-sidebar-compact-rows.png`; viewport override reset. No personal data edits or PR/commit.


## Navigator hierarchy follow-up

Folder controls, tag filtering and entry rows now share the same horizontal edges. The breadcrumb has a divider, labels/counts use a smaller hierarchy, and selection uses a subtle theme-aware fill and left marker. Move/Add tags/Remove tags are consolidated into the existing selected-entry action menu; revision snapshots and focus restoration remain intact.

Verification: 27 targeted frontend tests pass with 105 assertions. All 30 controlled workspace/sidebar viewport and scale cases pass across Chromium, Firefox and WebKit, including aligned edges, the consolidated tag action, dialog cancellation/focus return and existing inline scrolling checks. Lint and checked TypeScript/production build pass. Source whitespace checks are clean. The full browser run required execution outside the sandbox because esbuild spawning was denied there.

Live controlled-fixture review exercised desktop sidebar selection and tag dialog cancellation, desktop modal selection and mobile modal selection. Screenshots: lorebook-selection-hierarchy-sidebar.png, lorebook-selection-hierarchy-modal.png and lorebook-selection-hierarchy-mobile.png in the thread visualization directory. Viewport override reset; no personal entries changed. User approved the visuals and confirmed a fresh ST export works after restarting the previously stale backend.

Generated frontend/dist stays served for live review and is excluded from the source commit. No dependencies or lockfiles changed. Historical full-suite failures and previously documented unverified platform cases still apply.
