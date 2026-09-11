# Task 13 implementation report

Status: DONE

Base: `ae1e782`

## Implemented

- Added `SeriesEditor`, `SeasonCard`, `EpisodeRow`, `SeriesPublishErrors`, and defensive lifecycle permission helpers. The production editor follows the approved Demo's two-part basic-information / season-and-episode layout and reuses the established compact movie form, poster picker, video picker, theme, and button styles.
- New series creation first persists a named series draft, then creates season 1 and renders one unsaved episode row with number 1 and a required blank administrator-entered name. An empty name cannot issue the episode create request.
- Seasons store/display only their number. Administrators can add, renumber, and delete eligible seasons, and add/remove unsaved episode rows. A season containing a published episode disables renumbering and deletion; the server still remains authoritative.
- Every persisted episode has its own form and request chain. Saving performs one episode PATCH, optionally uploads that episode's video using the returned episode version, validates both returned episode and parent-series versions against a fresh hierarchy read, and only then optionally publishes the episode. No season or full hierarchy is serialized as an update payload.
- Draft series fields, genres, and poster are editable. Published and archived series fields/poster are read-only. Descendant state remains independent as required by the existing backend contract: published or archived parents can retain/add/edit draft children, while published episodes remain read-only until archive then return-to-draft.
- Series and episode publish/archive/draft operations re-read the complete authoritative hierarchy. Failed follow-up reads keep writes locked until explicit reload; successful child transitions immediately update season locks. Series publication saves fields and poster first and uses each returned parent version.
- 409 conflicts lock further writes until explicit reload. 401 expires the App session. 403 refreshes session/CSRF state but never replays the rejected mutation; a second write occurs only after the administrator explicitly retries. Async chains stop after unmount.
- Poster object URLs use the existing picker cleanup contract and are released on replacement, successful refresh/read-only transition, explicit reload, and unmount. Cancelled file selection preserves the current preview.
- Connected create/edit/view/delete series entries through `App`, including the content-kind selector and return-to-list behavior, without duplicating the Task 12 movie editor.
- After the series record is created, its real ID is retained by `App`. Leaving and returning through the sidebar reopens the same draft instead of a fresh create form. Empty seasons in that active creation flow restore their initial blank episode row; if default-season creation failed after the parent was persisted, the administrator can return to that parent and explicitly retry with “添加一季” rather than orphaning it.
- Unsaved episode rows report edited numbers back to their season card, so the next row starts after the highest currently entered number instead of reusing a stale default.
- Permanent deletion first obtains fresh hierarchy state, displays season/episode/poster/video counts, warns that deletion is unrecoverable, and requires an exact full content name. Published episodes lock season deletion; published parent series cannot be deleted. A failed impact read cannot open the confirmation or issue DELETE.

## TDD evidence

1. The previous implementer first ran `npm test --workspace @movie-harbor/admin-web -- SeriesEditor` against an empty component stub and observed **13/13 behavior tests fail** for missing editor behavior (not an import error). The suite was then expanded to 14 cases while implementing the first green version.
2. On takeover, the focused suite passed **14/14**. I audited it against the design, Demo, Task 11/12 frontend patterns, shared API client, and the backend series/season/episode/media contract.
3. I added four focused regression cases covering: series field/poster/publication parent-version chaining and preview cleanup; archived-parent read-only fields with independent draft-child editing; 403 recovery followed by an explicit retry using renewed CSRF; and deletion impact read failure keeping deletion unavailable.
4. Because these were characterization tests for already-correct takeover code, their first run was **18/18 GREEN**. I then mutation-checked the new version-chain assertion by temporarily publishing with `saved.version - 1`; the focused run produced the expected **1 failure** (`expected version 5, received 4`). Restoring the correct `saved.version` returned the focused suite to **18/18 GREEN**.
5. Independent review found that App retained `seriesId=null` after parent creation and that a failed default-season request therefore became inaccessible after navigation. Two new tests failed **2/2** with empty recreated forms; the App/editor identity handoff and recoverable creation flow made them GREEN.
6. Review also found stale numbering for multiple unsaved episode rows. The regression failed **1/1** (`expected 6, received 3`); propagating unsaved number edits to `SeasonCard` made the complete focused suite **21/21 GREEN**.

Tests render the real App/editor/shared UI and use the real shared API client; only HTTP transport and browser object-URL facilities are controlled. Request assertions cover exact endpoints, method boundaries, payloads, multipart files, CSRF headers, independent episode versions, and parent version progression.

## Latest verification

- `npm test --workspace @movie-harbor/admin-web -- SeriesEditor`: exit 0; **21 passed**.
- `npm test --workspace @movie-harbor/admin-web`: exit 0; **66 passed**.
- `npm run build --workspace @movie-harbor/admin-web`: exit 0; TypeScript and Vite production build passed.
- `cargo fmt --all -- --check`: exit 0.
- `cargo clippy --workspace --all-targets -- -D warnings`: exit 0.
- `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test cargo test --workspace`: exit 0; all Rust unit, integration, and doc tests passed. The first unconfigured attempt failed because `TEST_DATABASE_URL` was absent; the configured sandbox attempt was denied local socket access, then the approved local-PostgreSQL run passed.
- `npm test --workspaces`: exit 0; public **15**, admin **66**, API client **20**, UI **31** = **132 tests passed**.
- `npm run build --workspaces`: exit 0; both frontend production builds passed and both shared packages typechecked.
- `git diff --check`: exit 0.

## Changed files

- `frontend/admin-web/src/series/SeriesEditor.tsx`
- `frontend/admin-web/src/series/SeasonCard.tsx`
- `frontend/admin-web/src/series/EpisodeRow.tsx`
- `frontend/admin-web/src/series/SeriesPublishErrors.tsx`
- `frontend/admin-web/src/series/permissions.ts`
- `frontend/admin-web/src/series/SeriesEditor.test.tsx`
- `frontend/admin-web/src/app/App.tsx`
- `frontend/admin-web/src/styles.css`
- `.superpowers/sdd/2026-09-11-self-hosted-media-library-implementation/task-13-report.md`

## Self-review and scope notes

- Confirmed from backend integration tests that an archived series freezes only the parent record/poster; descendant drafts and their videos keep independent lifecycle/editability, and new seasons/episodes remain allowed. The UI intentionally matches that contract.
- Consulted current official React documentation through Context7 for Effect cleanup, stale async-result guards, controlled form state, and key-based reset behavior.
- Independent review reported two Important identity/recovery issues and one Minor draft-numbering issue; all three were fixed with demonstrated RED/GREEN regressions before commit.
- The same independent reviewer rechecked those three findings against the final worktree and returned `RESOLVED`.
- No backend or shared API contract changes, dependency changes, or plan-checkbox edits were made.
- **Concern:** the current backend has no dedicated delete-impact endpoint. As in Task 12, this editor derives counts and the exact confirmation name/version from a fresh authoritative detail response. This is safe for the present hierarchy contract but should be revisited if deletion impact later includes hidden/non-detail resources.
