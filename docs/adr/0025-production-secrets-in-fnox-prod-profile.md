# 25. Production secrets live in the fnox `prod` profile

Date: 2026-09-28 · Status: accepted

## Context
The developer's shell runs `fnox activate`, which resolves the default
profile of `fnox.toml` on every prompt inside the project. With the
production secrets in the default profile, every `cd` into the repo tried to
read the 1Password item `granary` and printed warnings — even though dev and
tests never need real secrets (they use `config/dev.env`).

## Decision
Declare production secrets under `[profiles.prod.secrets]` in `fnox.toml`.
The default profile declares nothing for this project. Production runs use
the profile explicitly: `mise run prod` → `fnox exec -P prod -- bun build/index.js`.

## Consequences
Entering the project is silent. Missing 1Password items only surface when
actually starting production. Any new production secret goes in the `prod`
profile.
