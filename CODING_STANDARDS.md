# Coding standards

Rules for reviewing a change in this repository. Each one is a judgement call; cite it by its heading.

## Documentation tiers

Each user-visible behavior has one precise description, in `docs/behavior.md`.

- `README.md`, `README.ko.md` and `OVERVIEW.md` are for users and the registry listing. They name features and the headline rules a user acts on, and change when a feature, control or term is added, removed or renamed, or a headline rule changes (such as what cancels a reservation).
- Edge cases, races, event ordering and exceptions to a rule belong in `docs/behavior.md`. Such a sentence added to a README or `OVERVIEW.md` is a finding: move it to `docs/behavior.md`.
- `docs/behavior.md` is what the code is checked against. A behavior change without a matching `docs/behavior.md` change, or a sentence there broader than the code, is a finding. A README or `OVERVIEW.md` that says less than `docs/behavior.md` is not.
