# Native lorebook workspace: first structural pass

Prepared on `codex/lorebook-entry-organization`, based on the previously committed folder/tag feature. This is a reviewable structural pass for the attached aesthetic direction; no new commit, push or PR was made. Existing theme tokens and density remain the basis for visual refinement.

## Behavior

- Maximize/restore resizes the same native editor. It no longer launches an extension editor. Mobile fills the available viewport automatically; fullscreen omits inline desktop width/height caps.
- Desktop book navigation collapses without unmounting and remembers its local collapse preference. Mobile Books is a transient navigation view; selecting a book returns to its workspace.
- The selected book header stays compact. Name, description, book folder administration and vector tools sit behind Book settings. Pending/error vector counts remain visible in the header.
- Entry summaries use neutral surfaces and a selection rail. Desktop has separate list/detail scrolling; mobile replaces the list with a dedicated detail view. Back restores list context and focus. Mobile type/position metadata is quiet text; those fields remain editable in the detail form.
- Mobile tag filters, sort, page size and token-display options are secondary controls. Disabled drag decoration and the permanent drag instruction are removed. Advanced entry sections retain their existing collapsed defaults.
- The sidebar is a navigation companion. Opening an entry takes it to the native authoring modal instead of rendering another large editor in the sidebar.

No backend, migration, dependency, lockfile or folder/tag API semantics changed in this pass. Existing core Spindle mount attributes remain. The legacy productivity host still imports the original modal/fullscreen CSS classes, so native fullscreen has separate classes and the shared legacy fullscreen rules were preserved. No new Suite dependencies were introduced.

## Verification on 2026-10-04

- Focused frontend regressions: **48 pass, 0 fail**, 206 assertions across eight files. Includes retained draft/DOM identity through a responsive transition, mobile return to list, lightweight sidebar authoring handoff and native fullscreen contracts.
- Frontend TypeScript, ESLint and production build: pass.
- Controlled workspace diagnostics: **12 cases pass** across Chromium, Firefox and WebKit; desktop 1200x915 and mobile 412x915 at UI scales 1 and 1.25. Checks same textarea instance/draft through maximize, restore and navigation collapse; mobile Books/detail/back; shortened viewport; no fullscreen inline caps; 0/1/44/50/137-entry boundaries; pagination/drag availability; exact comma-bearing tag filtering and visible pending/error vector status.
- Existing controlled organization diagnostics: **27 cases pass** across all three engines, including folder/tag dialogs, keyboard/focus, Escape, close/reopen and scale/mobile cases.
- Live test instance `http://kl:7860/`: inspected the existing controlled destination book without editing its entries. Verified mobile Back, desktop detail selection, native maximize, collapsed navigation and restore. Measured fullscreen at 412x915 mobile and 1200x900 desktop with origin 0,0 and no inline width/height caps. Captured desktop/mobile review screenshots. Temporary viewport override was reset.
- Source whitespace checks pass. New source remains unstaged. Generated `frontend/dist` is deliberately retained uncommitted because the live server serves this build during aesthetic review; it must be excluded from a future source commit/PR. A separate preserved copy is available in `%TEMP%/lumiverse-lorebook-workspace-first-pass-01a10465`.

Focused test output: `%TEMP%/lorebook-workspace-tests-final.log`. Build output: `%TEMP%/lorebook-workspace-final-build.log`. Diagnostics run from `scripts/e2e-diagnostics` with `node check-world-book-workspace.mjs` and `node check-entry-organization.mjs`; see that directory's README for engine/module overrides.

## Remaining acceptance work

Physical phone keyboard/scroll behavior, the Tauri wrapper, and installed Suite absent/disabled/enabled permutations have not been validated in this pass. Core controlled fixtures do not claim extension-installed compatibility. Existing mount points and shared legacy fullscreen rules were preserved by inspection.

The controlled workspace fixture is intentionally an in-memory API boundary; it does not prove backend sorting, activation, import/export, drag persistence or vector indexing execution. Those semantics were not changed here and their earlier feature checks remain documented separately. No new full-repository test-suite result is claimed. The historical ordinary-terminal 20 failures and one error remain in the detailed failure report; this layout pass does not silently classify them as fixed.

Aesthetic polish and the remaining device/extension acceptance checks are still pending review.

## Tabbed workspace follow-up

The next structural iteration introduces independent navigator/workspace state, persistent session tabs and explicit desktop split. See [lorebook-tabbed-workspace.md](lorebook-tabbed-workspace.md) for current behavior and verification. The results above describe the earlier single-editor pass.
