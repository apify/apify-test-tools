# `readConfigFile` fixtures

One directory per scenario. The only files that exist are the ones actually read: a config file and
the `.actor/actor.json` of each actor it points at. Everything those paths resolve to — Dockerfiles,
READMEs, input schemas, override context folders — is never opened, so it is not on disk.

Remember that `folder` and `overrideActorContext` are resolved with `join()` against the config
file's directory (so they stay relative to the CWD), while everything inside `actor.json` is resolved
with `resolve()` against the `.actor/` directory (so it comes back absolute).

## Succeeding

| Fixture            | Covers                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monorepo`         | The whole shebang: config at the root plus four actors. `owner/minimal` takes every schema default; `owner/full` sets every path-carrying field, mixing path strings with inline definitions, and overrides the context; `other-owner/leaf` sits three levels down and overrides the context with a path pointing back at the root; `owner/dotted` is reached through a `folder` that only normalizes to its directory, and has a `dockerContextDir` of `.` (i.e. `.actor/` itself). |
| `config-in-subdir` | Config in `config/` under a non-default filename, so every `folder` walks back out with `../` — one to a sibling tree, one to the fixture root.                                                                                                        |
| `actor-at-root`    | A single actor with `folder: "."`, i.e. `.actor/` sitting next to the config file.                                                                                                                                                                     |
| `empty-actors`     | A valid config declaring no actors.                                                                                                                                                                                                                   |

## Failing

| Fixture              | Fails at                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `invalid-config`     | `ACTOR_CONFIG_SCHEMA` — empty `folder`, ownerless `actorFullName`, empty `tokenEnvVar`, empty `overrideActorContext`. |
| `missing-actors-key` | `ACTOR_CONFIG_SCHEMA` — a JSON object, but without the `actors` key.                           |
| `duplicate-names`    | `enforceUniqueActorFullNames` — two folders sharing `owner/twin`.                              |
| `missing-actor-json` | Reading `.actor/actor.json`. Only the config file exists; the actor folder does not, which is indistinguishable from a folder without an `actor.json` since only the `actor.json` path is ever stat'd. |
| `invalid-actor-json` | `ACTOR_JSON_SCHEMA` — wrong spec version, unparseable `version`, out-of-range memory, unknown key in the strict `storages` object. |

A config file that is missing, unparseable or not a JSON object needs no fixture here — `readConfigFile`
rethrows those straight from `safeReadJsonObjectFile`, which `files.test.ts` covers.
