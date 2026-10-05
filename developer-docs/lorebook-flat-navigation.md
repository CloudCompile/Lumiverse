# Folderless lorebook navigation

Follow-up to the merged entry organization feature, based on staging `aed64882`.

Books without named entry folders now show entries immediately in both the sidebar and native modal. The folder root, All entries/Unfiled folder rows and folder breadcrumb appear only while the book has named folders. Empty tag controls are hidden; existing tags and active tag filters remain usable. The editor's Folder field and selected-entry Move action can still create the first folder.

When the last folder disappears, the current folder filter is cleared and the first unfiltered entry page is loaded. Existing server pagination, editor drafts, tabs and foldered-book navigation remain intact.

Verification:

- Targeted frontend tests: 31 tests pass across the two relevant files (30-test combined run followed by the 16-test organization run with one additional boundary case).
- Controlled diagnostics: all 30 Chromium/Firefox/WebKit workspace and sidebar viewport/scale cases pass. Checks include direct folderless entry rendering, no folder picker/breadcrumb, empty books, existing named-folder paths and shared editor interactions.
- Frontend typecheck, lint, backend typecheck and atomic production build pass. The initially stale backend type package was synchronized to staging's pinned version with a frozen lockfile install; manifests and lockfiles are unchanged.
- Source whitespace checks pass. Generated dist is served for review and excluded from the source diff.

Live controlled-fixture review confirms immediate entry rendering in desktop/mobile sidebar and modal, inline expand/collapse, empty books and preserved named-folder navigation. Screenshots: lorebook-flat-sidebar-desktop.png, lorebook-flat-sidebar-mobile.png, lorebook-flat-modal-desktop.png and lorebook-flat-modal-mobile.png in the thread visualization directory. Viewport override reset; no personal lorebooks or entries changed. The user-authorized start.ps1 -b process remains running for review at localhost:7860. Latest staging rejects the kl:7860 browser origin; no origin/security settings were changed. The user audited the live behavior in Helium and Zen and confirmed it works before opening the follow-up PR.
