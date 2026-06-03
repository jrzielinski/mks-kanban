## Delivery Engine — Phase Routing

This project uses the Delivery Engine. Work happens in three phases; detect the active phase and read its rules.

- **Plan** → `delivery/rules/plan.md` (+ `project-plan.md` overlay). Active for `/mks-{explore, blueprint, breakdown, ticket, board}`, or when creating/editing workstreams, overviews, tracks, stories, acceptance criteria, presentations, or estimates under `delivery/workstreams/`.
- **Build** → `delivery/rules/build.md` (+ `project-build.md` overlay). Active for `/mks-{techplan, build, review, review-profile}`, or when creating/editing build-plans or code under `delivery/repos/`.
- **Harden** → `delivery/rules/harden.md` (+ `project-harden.md` overlay). Active for `/mks-{validate, pentest}`, or when working with validation reports or pentest audits.

Switch phases explicitly with `/mode plan|build|harden`. The project overlay (`project-<phase>.md`) extends and overrides the base rules on conflict. Run `/mks-calibration` to see how Delivery Unit estimates track measured effort per repo.
