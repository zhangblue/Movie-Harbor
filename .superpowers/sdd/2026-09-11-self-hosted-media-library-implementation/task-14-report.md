# Task 14 implementation report

Status: DONE

Base: `74a0e98`

## Implemented

- Added movie playback at `/movies/:id/play` and episodic playback at `/series/:id/play/:episodeId`, plus a recent-episode redirect for `/series/:id/play`. Detail-page playback entries now use these browser-history-aware routes and each player retains a link back to its detail page.
- Added the native HTML `<video>` player using the public `/media` URL returned by the existing catalog API. It does not add transcoding or external-subtitle behavior. Readiness and unsupported-format failures are exposed as explicit live status/alert text.
- Added one versioned localStorage namespace (`movie-harbor:playback:v1`) containing isolated `movie:<id>` / `episode:<id>` progress records and `series:<id>` recent-episode records. Corrupt JSON, incompatible/invalid schema, inaccessible storage, and throwing storage methods safely fall back without blocking playback.
- Progress writes are throttled to at most once per five seconds during `timeupdate`, with immediate flushes on pause, `pagehide`, `beforeunload`, and player cleanup. Zero-position, less-than-30-seconds-remaining, and ended playback points are cleared.
- Existing progress presents keyboard-focused Continue / Start Over choices. Restoration happens only after metadata is available, works for both metadata/choice event orders, and clamps to the current media duration. Start Over clears and does not restore the old point. Pending choices cannot operate native controls or overwrite the saved point.
- Series playback sorts seasons and episodes numerically, remembers the latest episode, limits the picker to the active/browsed season, and provides ordered previous/next buttons with disabled boundaries. Episode switches remount the video by episode key so an old media element cannot restore or save into the new episode record.
- Added responsive dark-theme player, picker, navigation, prompt, and error presentation matching the approved public-site visual hierarchy.

## TDD evidence

1. Added the storage and real-App player tests first. `npm test --workspace @movie-harbor/public-web -- player` failed because `progressStore` did not exist.
2. Implemented only the store. Its focused suite passed **7/7**, while PlayerPage then failed **7/7** because playback routes still rendered 404 and detail entries still navigated directly to media.
3. Implemented player routing/components and integration. PlayerPage reached **7/7**, then a metadata-before-choice regression was added and failed **1/1** (`currentTime` remained 0 instead of 120); supporting both event orders made the player suites GREEN.
4. A zero-position regression failed **1/1** by persisting a 0-second record; treating the beginning as no resume point made the storage suite GREEN.
5. Independent review found pending-choice data loss and stale cross-season picker state, plus malformed deep-link and focus issues. Added observable assertions first; PlayerPage failed **3/10** for controls still enabled, stale season selection, and malformed URL fallback. The storage gate, current-episode picker reset, atomic decode, and initial focus changes made those checks pass.
6. Reviewer recheck found one remaining picker-state revival path after browsing another season and navigating away/back. Its exact regression failed **1/1**; remounting the picker on current-episode identity made the complete player suites pass **19/19**.

Tests render the real `App`, request hook, detail/player components, native media element, progress store, and history integration. Only the HTTP transport, jsdom media read-only properties, clock, and an in-memory standards-compatible `Storage` boundary are controlled.

## Latest verification

- `npm test --workspace @movie-harbor/public-web -- player`: exit 0; **19 passed**.
- `npm test --workspace @movie-harbor/public-web`: exit 0; **34 passed**.
- `npm run build --workspace @movie-harbor/public-web`: exit 0; TypeScript and Vite production build passed.
- `npm test --workspaces`: exit 0; public **34**, admin **66**, API client **20**, UI **31** = **151 tests passed**.
- `npm run build --workspaces`: exit 0; both frontend production builds passed and both shared packages typechecked.
- `git diff --check`: exit 0.
- No backend changes; cargo and live browser/Docker Compose playback were not rerun for this frontend-only task. Range-request and full cross-service playback remain Task 15 acceptance work.

## Changed files

- `frontend/public-web/src/player/PlayerPage.tsx`
- `frontend/public-web/src/player/VideoPlayer.tsx`
- `frontend/public-web/src/player/EpisodePicker.tsx`
- `frontend/public-web/src/player/progressStore.ts`
- `frontend/public-web/src/player/PlayerPage.test.tsx`
- `frontend/public-web/src/player/progressStore.test.ts`
- `frontend/public-web/src/app/App.tsx`
- `frontend/public-web/src/details/MovieDetails.tsx`
- `frontend/public-web/src/details/SeriesDetails.tsx`
- `frontend/public-web/src/details/Details.test.tsx`
- `frontend/public-web/src/styles.css`
- `.superpowers/sdd/2026-09-11-self-hosted-media-library-implementation/task-14-report.md`

## Self-review and scope notes

- Consulted current React and React Testing Library documentation through Context7 for browser-event synchronization, effect cleanup, native event tests, and cleanup semantics.
- Independent review reported no Critical findings. Its two Important and two Minor findings were addressed with focused regressions before final verification.
- Preserved the API DTO and backend contract: the player fetches only existing public movie/series detail endpoints and uses their public media URLs.
- No dependencies, backend files, Demo files, or implementation-plan checkboxes changed.

Commit message: `feat: add playback and local progress`.
