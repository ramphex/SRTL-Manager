# Contributing

SRTL Manager accepts focused fixes and features that preserve its cautious file-handling model.

## Workflow

1. Open or reference an issue for behavior changes.
2. Branch from `beta`.
3. Keep the change scoped and add tests for changed behavior.
4. Run `npm run check`, `npm run build`, and relevant Playwright smoke tests.
5. Open the pull request against `beta`, never `main`.

Ordinary branch pushes run verification but do not publish containers or releases. Maintainers explicitly publish prereleases from `beta`, then promote tested releases from `beta` to `main` for an explicit stable release.

Prereleases use the upcoming stable version plus an ordered suffix, such as `0.1.1-beta.1` through `0.1.1`. Fixes to a stable release increment its patch version (`0.1.1`, `0.1.2`); the next feature line starts at `0.2.0-beta.1`.

Do not include credentials, local `.env` files, library paths, database dumps, logs, or inventory data in a pull request.

## Development

Use Node.js 22 and Postgres 17. Install dependencies with `npm ci`, then run `npm run dev`. The development UI and API default to ports `5178` and `3009`.

New filesystem mutations require server-side containment checks, durable recovery behavior, cancellation handling, and failure-path tests.
