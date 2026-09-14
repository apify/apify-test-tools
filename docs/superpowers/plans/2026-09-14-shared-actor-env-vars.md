# Shared Actor Environment Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate Actor versions with configured GitHub secrets and variables, sharing selected entries with test/debug versions while preserving their other variables.

**Architecture:** GitHub supplies values through an extension of the existing secret-selection helper. The library resolves configured environment names, then creates or updates individual variables on the target Actor version before building it. It never copies secret values from another Apify version.

**Tech Stack:** TypeScript, apify-client 2.x, Vitest, Node.js, GitHub Actions.

**Spec:** The agreed design from this conversation is recorded in the behavior contract below. This is a simple plan; no separate specification is needed.

## Behavior contract and global constraints

Add an optional `envVars` map to each entry in `apify-test-tools.config.json`:

```json
{
    "envVars": {
        "OPENAI_API_KEY": {
            "fromEnv": "SHARED_OPENAI_API_KEY",
            "isShared": true,
            "isSecret": true
        }
    }
}
```

- The map key is the destination variable name on Apify; `fromEnv` is its source process environment name.
- `fromEnv` must be a non-empty string; `isSecret` is a required boolean. Optional `isShared` defaults to `false`.
- Production builds (`isLatest: true`) apply all configured entries. Test and local/debug builds apply only entries with `isShared: true`.
- Apply selected entries on both creation and subsequent updates, so rotations reach existing versions on their next build.
- Existing destination variables outside the selected set remain untouched. Removing a config entry or changing `isShared` to false stops synchronization; it does not delete an existing variable.
- Missing or empty selected source values fail with Actor and variable names only. Validate values for all selected Actors before starting mutations. Unselected entries do not require values.
- No configuration means no additional environment-variable API calls and unchanged behavior.
- Dry runs list destination/source names and flags only; require no source values and perform no mutations.
- Never log values, include them in build output JSON, or print API error request bodies. Keep deployment tokens separate from Actor variable payloads.
- GitHub is the source of current values. There is no production-secret readback, automatic propagation on secret edits, deletion synchronization, or new standalone sync command.
- Do not enable `applyEnvVarsToBuild`; retain existing behavior for build-time injection.
- Use existing dependencies. Commit format: `feat: message`, `fix: message`, `chore: message`, or `refactor: message`, without scope.

## Task 1: Parse config and resolve selected values

**Files:** Modify `bin/types.ts`, `bin/utils.ts`, and `test/unit/bin/utils.test.ts`; create `bin/actor-env-vars.ts` and `test/unit/bin/actor-env-vars.test.ts`.

**Interfaces:** Add `ActorEnvVarConfig` and optional `envVars: Record<string, ActorEnvVarConfig>` to both config-entry and runtime Actor types. Export `resolveActorEnvVars(actorConfig: ActorConfig, isLatest: boolean, env: NodeJS.ProcessEnv): Array<{ name: string; value: string; isSecret: boolean }>` from the new module.

- [ ] Add failing config tests for valid entries, absent configuration, invalid maps/entries, empty names, invalid `fromEnv`, and non-boolean flags. Add resolver tests for production versus shared-only selection, source renaming, empty/missing values, and missing values in unselected entries.
- [ ] Run `npx vitest run test/unit/bin/utils.test.ts test/unit/bin/actor-env-vars.test.ts`; confirm the new cases fail for the missing feature.
- [ ] Parse and preserve the mapping in `readConfigFile`. Implement the resolver using `isLatest || definition.isShared === true`; read values only after selection. Return no entries for absent/empty config. Use `isSecret` exactly as configured.
- [ ] Run the focused tests and `npm run type-check`. Commit as `feat: configure shared Actor environment variables`.

## Task 2: Synchronize variables before builds

**Files:** Modify `bin/build.ts`, `bin/build-from-local.ts`, and `bin/actor-env-vars.ts`; create `test/unit/bin/build-env-vars.test.ts`.

**Interfaces:** Extend `ApifyBuilder.createVersionAndBuild` with an optional fourth argument containing resolved variables, defaulting to `[]`. Export `syncActorEnvVars(versionClient: ActorVersionClient, variables: Array<{ name: string; value: string; isSecret: boolean }>): Promise<void>` from `bin/actor-env-vars.ts`.

- [ ] Verify the lockfile-resolved apify-client exposes `version.envVar(name).get/update` and `version.envVars().create`; use its existing public types.
- [ ] Add failing mocked tests for version creation and update, shared-only test/local builds, all-entry production builds, no-config compatibility, preservation of unrelated destination entries, dry-run redaction, and no build after synchronization failure.
- [ ] Run `npx vitest run test/unit/bin/build-env-vars.test.ts` and confirm the new cases fail.
- [ ] Resolve all selected Actors' values before any version updates or builds in each non-dry-run entry point. Pass resolved variables into `createVersionAndBuild`.
- [ ] Keep the existing version create/update payload free of `envVars`. After the target version exists, process each selected variable: get metadata by name; update `{ value, isSecret }` if present; otherwise create `{ name, value, isSecret }`. Await synchronization before `actorClient.build`.
- [ ] If creation races with another writer, handle only the specific `env-var-already-exists` conflict by updating that name. Propagate other failures using sanitized Actor/name/status information. A partial sync is possible; stop the build and allow rerunning to complete it.
- [ ] Test that missing selected values prevent all mutations, unrelated variables receive no writes/deletes, a second sync updates existing names, and both API failure paths prevent builds. Dry-run tests must confirm values are neither required nor printed.
- [ ] Run the focused tests and `npm run type-check`. Commit as `feat: sync configured variables before Actor builds`.

## Task 3: Forward declared values from GitHub

This task is in **apify-store/github-actions-source**, a separate repository. Inspect its current checkout and tests before editing. The helper and PR workflow were read during planning; inspect the release workflow when implementing.

**Files:** Modify `scripts/run-with-apify-tokens.mjs`, `.github/workflows/pr-build-test.yaml`, and `.github/workflows/push-build-latest.yaml`; add coverage in `scripts/run-with-apify-tokens.test.mjs` or extend its existing equivalent.

**Interface:** Preserve `ALL_SECRETS`; add optional `ALL_VARS` containing `${{ toJSON(vars) }}`. The child receives declared sources as individual environment variables, never either full context blob. `isSecret: true` selects from secrets; false selects from vars. The same source name declared with conflicting `isSecret` values fails explicitly.

- [ ] Add failing helper tests that launch a stub child and inspect its environment: existing token forwarding, configured secret/variable forwarding, omitted unrelated secrets, removed context blobs, conflicting source declarations, and value-free logs/errors.
- [ ] Run `node --test scripts/run-with-apify-tokens.test.mjs` (or the repository's existing test command for its equivalent).
- [ ] Extend the current config-derived allowlist with `fromEnv` sources. Preserve existing token handling; a source name colliding with a deployment token must resolve to the same GitHub secret or fail. Omit missing sources and leave selected-value validation to the library, which knows which Actors/build mode apply.
- [ ] Pass `ALL_VARS` at both build steps, alongside `ALL_SECRETS`. Do not expose either blob to test jobs or child processes. Parse errors must not echo context contents.
- [ ] Run helper tests and the repository's existing checks. Commit as `feat: forward configured Actor environment sources`.

## Task 4: Document and verify the complete flow

**Files:** Modify `README.md` in apify-test-tools.

- [ ] Document the config example, GitHub secret/variable naming, production/shared-only behavior, local environment setup, missing-value errors, preservation/removal semantics, and the required shared-workflow update.
- [ ] Run `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`, and the unit suite (`npx vitest run test/unit`). Report any pre-existing failures separately. Do not treat unit checks as live platform verification.
- [ ] In a disposable Actor, use dummy values to verify a shared variable is added and then rotated, a target-only variable survives, and a non-shared entry is not copied to a newly created test version. Verify production selection separately. Exercise the workflow with dummy GitHub inputs and confirm logs/output contain no values. Delete only fixtures created for this check.
- [ ] Roll out the library and coordinated workflow change before adding consuming-repository mappings. A GitHub secret edit alone does not select all Actors for rebuilding; document next-build propagation explicitly.
- [ ] Commit as `chore: document shared Actor environment variables`.

## References

- [Issue #110](https://github.com/apify/apify-test-tools/issues/110)
- [Shared workflow helper](https://github.com/apify-store/github-actions-source/blob/master/scripts/run-with-apify-tokens.mjs)
- [Version client environment-variable methods](https://docs.apify.com/api/client/js/reference/class/ActorVersionClient)
- [Secret values are omitted from version reads](https://docs.apify.com/api/v2/actor-version-get)
- [Create environment variable](https://docs.apify.com/api/v2/actor-version-env-vars-post)
- [Update environment variable](https://docs.apify.com/api/v2/actor-version-env-var-put)

## Cleanup status

The feature-specific tests described above were deliberately removed during the approved cleanup. Existing repository tests remain unchanged. The shared GitHub workflow/helper update is separate work in `apify-store/github-actions-source`; it is not implemented or verified in this repository.
