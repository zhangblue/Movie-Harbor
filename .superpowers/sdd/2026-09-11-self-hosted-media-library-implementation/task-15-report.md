# Task 15 implementation report

Status: DONE

Base: `fb987c7`

## Implemented

- Added production multi-stage Docker images for the Axum API and the independently built public/admin Vite applications. The API runs as UID/GID `10001`; the two static applications are served by separate Caddy containers.
- Added an isolated Docker Compose topology with a health-checked PostgreSQL service and persistent database volume, one-shot private media-volume ownership initialization, API startup after database health, automatic SeaORM migrations, a read/write API media mount, and a read-only edge-Caddy media mount. PostgreSQL has no host port and the edge uses `${APP_PORT:-8080}:80`.
- Added safe database configuration from separate host, port, database, username, and password variables. URI delimiters in strong credentials are encoded by the API rather than interpolated into a Compose URL.
- Added same-origin Caddy routing that preserves `/api`, permits static access only to `/media/poster/*` and `/media/video/*`, returns 404 for other media namespaces, redirects `/admin` to `/admin/`, isolates the admin SPA fallback, and leaves all other routes to the public SPA. HTTPS remains a deployer concern.
- Added a complete administrator genre page for list, create, rename, reorder, deactivate, and unreferenced delete operations, including session expiry and conflict feedback.
- Added Playwright 1.61 deployment acceptance coverage. A guarded runner accepts only `mh-task15-e2e*` project names, checks the selected port, generates a tiny browser-playable MP4 using ffmpeg, starts empty named volumes, and cleans only its exact project resources.
- The browser suite drives initial login, genre creation, the movie lifecycle, and incremental series/episode publication through the real admin DOM. It also verifies public search/details, immediate archive invisibility, byte Range `206` and `Content-Range`, private media namespace denial, real `canplay`/`play()`/time advancement, database and media persistence after Compose restart, changed-password persistence, and non-overwrite by the unchanged initial-password environment.
- Expanded README and `.env.example` with first-start variables, media permissions and formats, public URL implications, same-point database/media backup guidance, Demo/development commands, production commands, and HTTPS expectations.

## TDD evidence

1. Added the five Playwright specifications and orchestration runner before deployment files. `npm run test:e2e` failed because `docker-compose.yml` did not exist.
2. Initial Compose build failed because the binary lacked the migration trait import; adding the existing migration crate trait enabled automatic startup migrations. The first browser run then exposed an assertion that expected the wrong public 404 copy; the trace showed the real `404 · 内容不存在` heading and the assertion was corrected.
3. Independent review found unsafe raw database-password URI interpolation. A focused config test failed with `Missing("DATABASE_URL")`; constructing the URL from separate components made it pass, and the deployment suite subsequently started with `task15-P@ss:/?%word`.
4. A genre-page DOM test failed on the existing “此页面尚未开放” placeholder. The first create/list implementation made it pass. A second rename/reorder/deactivate/delete test then failed because those controls were absent; implementing the complete management surface made all admin tests pass.
5. A private-media sentinel regression failed with HTTP 200 through the original broad `/media/*` file server. Restricting Caddy to the poster/video namespaces made both `.incoming` and `.quarantine` requests return 404 while uploaded media retained Range behavior.
6. Reviewer-requested E2E tightening converted representative movie and series management from API calls to DOM operations and upgraded playback from a `src` assertion to application readiness plus real time advancement. One rerun caught a missing archive synchronization wait and another caught a test-helper typo; evidence-guided test fixes produced a complete 4+1 green run.

## Latest verification

- `cargo fmt --all -- --check`: exit 0.
- `cargo clippy --workspace --all-targets -- -D warnings`: exit 0.
- `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test cargo test --workspace`: exit 0; **113 passed**.
- `npm test --workspaces`: exit 0; public **34**, admin **68**, API client **20**, UI **31** = **153 passed**.
- `npm run build --workspaces`: exit 0; both Vite production builds and both shared-package typechecks passed.
- `npx playwright test --list`: exit 0; five deployment tests discovered.
- `docker compose -p mh-task15-e2e-check --env-file tests/e2e/.generated/e2e.env -f docker-compose.yml config --quiet`: exit 0.
- `npm run test:e2e`: exit 0; main deployment flow **4/4** and post-restart persistence **1/1** passed; the exact isolated stack and its two volumes were removed.
- `git diff --check`: exit 0.

## Changed files

- `backend/Dockerfile`
- `backend/src/config.rs`
- `backend/src/main.rs`
- `frontend/public-web/{Dockerfile,Caddyfile}`
- `frontend/admin-web/{Dockerfile,Caddyfile}`
- `frontend/admin-web/src/genres/GenrePage.tsx`
- `frontend/admin-web/src/app/{App.tsx,App.test.tsx}`
- `frontend/admin-web/src/styles.css`
- `docker-compose.yml`
- `Caddyfile`
- `.dockerignore`
- `.env.example`
- `.gitignore`
- `playwright.config.ts`
- `tests/e2e/{run.mjs,helpers.ts,public.spec.ts,admin.spec.ts,series.spec.ts,playback.spec.ts,persistence.spec.ts}`
- `package.json`
- `package-lock.json`
- `README.md`
- `.superpowers/sdd/2026-09-11-self-hosted-media-library-implementation/task-15-report.md`

## Self-review and scope notes

- Consulted current Docker Compose, Caddy, and Playwright documentation through Context7 before implementation.
- The E2E runner refuses broad Compose project names and never maps or removes the existing PostgreSQL test service on host port `55432`.
- The generated MP4 and runtime state are ignored; no large binary fixture is committed.
- Independent review's database credential, DOM coverage, playable-media, private-media, and complete genre-management findings were addressed with executable regressions before final verification.
- Demo files and implementation-plan checkboxes were not changed.

Commit message: `feat: deliver self-hosted media library`.

## Final review fix round 1

- Replaced the bypassable `(IP, input-name)` login budget with independent IP and normalized-account budgets. Argon2 work is capped by a two-permit semaphore and runs outside database transactions; login then briefly locks and confirms the verified hash is unchanged, so concurrent password changes cannot authenticate an old hash.
- Added homogeneous `no-store` authentication errors and regression coverage for random-name IP exhaustion, independent client IPs, administrator row-lock contention, and concurrent password replacement.
- Added authoritative movie/series delete-impact endpoints with current name/version, hierarchy counts, and reference-counted exclusive/shared media totals. DELETE now returns cleanup state, attempts exclusive media cleanup after commit, retains failed jobs for retry, and surfaces a persistent accessible administrator warning.
- Added shared API-client DTO/route coverage and changed both deletion dialogs to use server impact data rather than details. A Compose E2E failure exposed deletion of a newly-created movie using the nullable route id; the dialog now uses the created model id.
- Added reusable PostgreSQL `TestDatabase` schema drop guard coverage for the new auth response regression without globally deleting schemas owned by concurrent suites.
- Moved post-pagination focus to the catalog heading after results load without stealing focus on initial render, rejected simultaneous `DATABASE_URL` and component settings, and documented the mutually exclusive database configuration modes.

Final verification after the review fixes:

- `cargo fmt --all -- --check`: exit 0.
- `cargo clippy --workspace --all-targets -- -D warnings`: exit 0.
- `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test cargo test --workspace`: exit 0; **121 passed**.
- `npm test --workspaces`: exit 0; public **34**, admin **68**, API client **21**, UI **31** = **154 passed**.
- `npm run build --workspaces`: exit 0.
- `npm run test:e2e`: first review-fix run reached **3/4** then failed in the admin deletion flow with `invalid movie request`; after the id fix the isolated deployment passed **4/4**, restart persistence passed **1/1**, and the runner removed only `mh-task15-e2e` resources.
- `git diff --check`: exit 0.

## Final review fix round 2

- Added atomic login admission before database and Argon2 work. Each IP and normalized account has a bounded in-flight reservation; admission checks and attempt-budget charging occur while both windows are locked. The owned reservation releases its in-flight slot on success, failure, cancellation, or other early errors, while cancellation keeps the attempt charge so disconnected `spawn_blocking` work cannot consume Argon2 indefinitely without reaching the failure budget. The existing two-permit global Argon2 semaphore remains the final CPU bound.
- Made proxy trust explicit. Direct deployments ignore `X-Forwarded-For` by default; standard Compose enables `TRUST_PROXY_HEADERS` only while the API remains internal, and edge Caddy overwrites the header with its actual remote client address plus a separate 32-byte proxy-authentication secret. Router tests cover direct and unauthenticated-proxy spoof attempts as well as authenticated-proxy client isolation.
- Unified episode, season, and full-series deletion cleanup results. Every media-removing series path commits its database cleanup jobs, immediately attempts its exclusive files, keeps failed jobs retryable, and returns the structured pending warning consumed by the App-level accessible alert.
- Added authoritative, hierarchy-scoped season and episode delete-impact endpoints. They validate parent/child ownership and calculate display name, the exact version required by DELETE, hierarchy size, and exclusive/shared media counts inside a read-only repeatable-read snapshot. The editor refuses to open confirmation if impact loading fails and uses only the returned name, counts, and version.
- Added movie and episode regressions where a preview reports exclusive media, another resource starts sharing it without changing the target version, and DELETE safely recomputes the real reference set, returns zero cleanup jobs, and preserves the file.
- Added a documented maintenance SQL script that only matches this repository's explicit per-suite schema prefixes. It is intentionally manual so it cannot race active test processes or delete another project's schemas.

Round 2 RED evidence:

- The concurrent admission regression showed every same-IP random-name request could pass before any failed Argon2 verification was recorded. Atomic reservations bound the burst and cancellation test now passes.
- A cancellation regression then showed dropping each admitted request released its slot without consuming the six-attempt budget. Admission now atomically pre-charges the attempt, success clears it, and failure completion does not double-count it; six cancelled admissions make the seventh return the limiter response.
- The proxy router regression showed direct peer addressing could not distinguish real clients behind Caddy. Explicit trust plus Caddy header replacement now separates trusted forwarded clients while rotating spoofed headers on a direct connection cannot evade the peer budget.
- The child deletion integration test received `404` from the first season `delete-impact` request. Both scoped endpoints now return authoritative snapshots.
- The SeriesEditor regression showed locally derived child counts and versions (no `独占媒体：1`) instead of the server preview. The dialog now requires the child endpoint, and an additional failure-path test proves no dialog or DELETE is possible when preview loading fails.

Round 2 final verification:

- `cargo fmt --all -- --check`: exit 0.
- `cargo clippy --workspace --all-targets -- -D warnings`: exit 0.
- `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test cargo test --workspace`: exit 0; **123 passed** (18 unit and 105 integration tests), including the final cancellation regression.
- `npm test --workspaces`: exit 0; public **34**, admin **71**, API client **22**, UI **31** = **158 passed**.
- `npm run build --workspaces`: exit 0; both Vite builds and shared-package typechecks passed.
- `E2E_COMPOSE_PROJECT=mh-task15-e2e-round2-final E2E_PORT=18080 npm run test:e2e`: exit 0; deployment flow **4/4** and restart persistence **1/1** passed after proxy authentication was enabled; only the exact isolated stack and its two volumes were removed.
- `git diff --check`: exit 0.
