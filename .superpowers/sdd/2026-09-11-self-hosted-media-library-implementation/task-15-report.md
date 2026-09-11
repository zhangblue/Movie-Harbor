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
