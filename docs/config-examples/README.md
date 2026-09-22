# Config examples for the grouped-mode debate

Six example config files for three real repos, in the two shapes proposed in
[#143](https://github.com/apify/apify-test-tools/pull/143). They exist so the shapes can be compared
on real data instead of on a sketch.

| Repo                                                   | Nested groups (Juan)                                                           | Split actors + configs (Marek)                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `apify-store/instagram`                                | [instagram.grouped.json](instagram.grouped.json)                               | [instagram.split.json](instagram.split.json)                               |
| `apify/store-website-content-crawler`                  | [website-content-crawler.grouped.json](website-content-crawler.grouped.json)   | [website-content-crawler.split.json](website-content-crawler.split.json)   |
| `apify-professional-services/e-commerce-scraping-tool` | [e-commerce-scraping-tool.grouped.json](e-commerce-scraping-tool.grouped.json) | [e-commerce-scraping-tool.split.json](e-commerce-scraping-tool.split.json) |

Both shapes use `"mode": "grouped"`. Only one of them can keep that name.

## Fields the examples assume

The examples include fields that do not exist yet. They are marked here so nobody reads them as
shipped behaviour.

| Field                                                            | State    | Source                                                     |
| ---------------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| `folder`, `actorFullName`, `tokenEnvVar`, `overrideActorContext` | shipped  | `master`                                                   |
| `envVars`                                                        | proposed | [#136](https://github.com/apify/apify-test-tools/pull/136) |
| `reportSlackChannel`, `releaseSlackChannel`                      | proposed | this discussion                                            |
| `actorNameGlob`, `folderGlob` in `configs`                       | proposed | Marek's comment on #143                                    |

`envVars` uses the map shape from #136: the key is the variable name on the Actor, `fromEnv` names
the process or GitHub variable that holds the value, `isSecret` controls Apify encryption, and
`isShared` includes the variable in test and debug versions.

The `isSecret` and `isShared` values in the examples are placeholders. The teams that own each repo
must set them.

Slack is two fields, not one. Today `--report-slack-channel` carries build and test failures and
defaults to `#notif-<repo-name>` in the shared workflow. `--release-slack-channel` carries the
changelog and is set only for public Actors. The examples keep both names.

## What was verified

The three grouped examples were parsed with the parser from the head of #143 (`46ab0a6`), then
resolved through `loadActorConfig` inside each repo checkout. Every Actor resolves to the same
`folder`, `tokenEnvVar` and `contextPaths` as the repo's live config today. The only addition is
`apify/website-content-crawler-data-viz`, which is explained below.

The split examples cannot be verified. No implementation exists.

## Findings

### 1. Instagram is the best case for nesting

All 13 Actors share one token, one report channel and one release channel. The grouped file is one
group and one per-Actor `envVars` override. The split file needs three `configs` entries to say the
same thing. Nesting wins here, and it is not close.

### 2. The e-commerce repo has three grouping axes, not one

The axes are the Apify account (`tokenEnvVar`), public against internal (`releaseSlackChannel`), and
the build context (`overrideActorContext`). They do not line up. Grouped needs three groups, repeats
`reportSlackChannel` in each of them, and still needs two Actor-level overrides on the hub. Split
needs five `configs` entries and states each fact exactly once.

### 3. The sample config in the PR loses `test/platform`

The e-commerce sample in [this comment](https://github.com/apify/apify-test-tools/pull/143#issuecomment-5777386209)
puts `ebay`, `shopify` and the three experimental spokes in one `standby` group. `ebay-standby` and
`shopify-standby` have `test/platform` in their context today. The other three do not. Resolved
against the repo, the sample silently drops `test/platform` from both:

```
live:      ["actors/ebay", "packages/external/protocol", "packages/internal/architecture", "test/platform"]
PR sample: ["actors/ebay", "packages/external/protocol", "packages/internal/architecture"]
```

Change detection then stops rebuilding those two Actors when a platform test changes. This is what a
second axis costs in practice, and it is easy to miss in review.

### 4. `envVars` makes Actor-level override semantics a real problem

The resolver in #143 spreads the Actor over the group, so an Actor-level field replaces the group
field. That is correct for scalars and defensible for arrays. It is wrong for a map.

Website Content Crawler shows it. Both Actors need
`RENDERING_TYPE_DETECTION_RESULT_DB_URI`. The main Actor needs three more secrets. In the grouped
file the main Actor must restate the shared entry, because setting `envVars` drops the group map:

```json
"envVars": {
    "RENDERING_TYPE_DETECTION_RESULT_DB_URI": { "...": "restated only to keep it" },
    "WEB_BOT_AUTH_PRIVATE_KEY": { "..." : "..." }
}
```

In the split file two `configs` entries each contribute keys and the maps merge. No restating.

If nesting ships, `envVars` needs a documented merge rule of its own, and the resolver needs a
special case. That is new work that the two current fields did not need.

### 5. Unknown keys are dropped without an error

The grouped schema is a plain `z.object`, so zod strips what it does not know. All three grouped
examples parsed clean with three unsupported fields in them. Once the Slack channel lives in the
config, `slackChanel` will be silently ignored and nobody will be notified of anything. Both
strategies should use `.strict()` before either of these fields ships.

### 6. An absent Slack channel must keep meaning "do not notify"

Website Content Crawler passes no `--report-slack-channel` today, so it sends nothing. Moving the
channel into the config without a default is fine. Giving it a default of `#notif-<repo>` would turn
notifications on for that repo for the first time. The example sets the channel explicitly, which is
a deliberate behaviour change for that repo to approve, not a migration side effect.

### 7. Every new field costs two schema entries under nesting

`tokenEnvVar` and `overrideActorContext` already appear at both the group and the Actor level. Add
the two Slack fields and `envVars` and it is five fields in two places. Under the split shape a new
field is added once, to `configs`.

## Two things found along the way, unrelated to the shape debate

- `standalone-actors/apify_quick-instagram-posts-checker` is in the instagram repo but not in its
  config. It has an `.actor/actor.json` and no `dockerfile` entry. Either it is deliberately out of
  CI, or it was forgotten.
- `data-visualizations` in Website Content Crawler is released by `apify push` in
  `_release-helper-actors.yml`, which runs `apify secrets add RENDERING_TYPE_DETECTION_RESULT_DB_URI`
  by hand. `envVars` from #136 replaces exactly that step. The examples include the Actor under the
  name `apify/website-content-crawler-data-viz`. That name is a guess. Confirm it before using the
  file.
