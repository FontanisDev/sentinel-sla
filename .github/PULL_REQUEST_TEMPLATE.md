# Pull request checklist — Sentinel-SLA

Thank you for contributing. Please confirm the points below — the CI run
covers most of them, but some checks are judgement calls only a human
can make.

## What changed

<!-- One or two sentences: what does this PR do, and why? -->

## Type

- [ ] Bug fix (no behaviour change beyond the fix)
- [ ] New feature (within the scope of the project)
- [ ] Docs / guides
- [ ] Tests only
- [ ] Packaging / deploy

## Quality checks

- [ ] `bun run check` passes locally (eslint, `tsc --noEmit` strict, vitest)
- [ ] `bash tests/integration/test_stack.sh` passes locally
- [ ] If money math changed: golden-scenario fixtures still reproduce the
      hand-computed Rial amounts (`tests/golden/`, `tests/unit/scenario-iranian.test.ts`)
- [ ] If an API route changed: `openapi/openapi.yaml` updated and
      `bun run lint:spec` + `bun run test:contract` pass; `docs/API.md`
      regenerated (`bun run docs:api`)
- [ ] If UI changed: verified in dark and light, English and Persian
      (Persian strings natural and formal-neutral)
- [ ] If deploy/ changed: paths stay portable (no
      machine-absolute paths)

## Hard rules (must all hold)

- [ ] Prometheus / Grafana / Loki / Alertmanager configs stay unmodified
      upstream
- [ ] Offline-first preserved (no new CDN/runtime fetches)
- [ ] Demo mode still works end-to-end
- [ ] No secrets, `.env`, database files or PDFs committed
- [ ] All numbers in docs/UI are truthful and reproducible from the code
