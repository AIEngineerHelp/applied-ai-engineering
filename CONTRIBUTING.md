# Contributing

Share practical examples that others can understand, run, and improve through the [AI Engineer Help community](https://aiengineer.help/).

## Choose a home

Use the [category index](README.md) to choose the main teaching topic. Place a project at `<category>/<project-name>/` using a descriptive kebab-case name. Keep its source, tests, data fixtures, and deployment configuration together. Link from other category indexes when useful instead of copying code.

`agents/` includes agents, workflows, orchestration, tools, and memory. Its community category currently uses the `agents-workflows` URL slug.

## Make the project usable

Include a README with the learning goal, prerequisites, exact setup/run/check commands, expected output, configuration placeholders, API costs, limitations, and sources. Until a project is runnable, clearly label it as planning or in development.

Keep dependency manifests and lockfiles inside the project. Document dataset provenance and use small synthetic or redistributable fixtures. Do not commit credentials, private data, model weights, or generated dependencies. The repository has not selected a license yet; preserve third-party notices and do not assume redistribution rights.

## Verify and share

Run relevant checks and report their results, including anything you could not verify. For model comparisons, document shared inputs, model versions, budgets, and evaluation methods; report failures as well as successes.

Add the project to its category README. Open a focused pull request explaining what readers can learn, how to run it, and how it was checked. When a community discussion exists, link it from the project and link the code from the discussion.

See [AGENTS.md](AGENTS.md) for the full repository conventions.
