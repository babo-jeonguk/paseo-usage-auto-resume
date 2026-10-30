# Verification

- During implementation, run `npm run test:focus -- <test files>` for the changed behavior and affected callers. If the scope is unclear, run `npm test`.
- Run `npm run typecheck` when type validation is needed; it reuses an incremental cache.
- Before handing off code or build/test configuration changes, require `npm run check` to pass after the last relevant change. Reuse a passing result until another relevant change occurs.
- Report verification commands and results, including any failures or blockers; describe incomplete verification explicitly.
