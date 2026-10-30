---
name: measure-flakiness
description: Re-runs the failing Actor run many times in parallel to measure how often the failure happens. Use only when you are about to create a new issue for a failing platform test and its flakiness rate is not already obvious.
---

# Measure flakiness

Use this only when both are true:

- You are about to create a new issue — no existing issue already covers this failure.
- How often the failure happens isn't obvious. Blocking, too few scraped items or a missing field can happen in 1% of runs or in all of them, and one failed run doesn't tell which.

## Steps

The Apify API token is in the `TESTER_APIFY_TOKEN` environment variable. It is always set, so there's no need to check for it.

1. From the failing run (the run the failed test started; its link is in the test log), get the Actor ID, build number, memory, timeout and input. For example, you can get the first four from `GET https://api.apify.com/v2/actor-runs/{runId}`.
2. Decide how to tell whether a finished run hit the same failure. Check what the failed test assertion checked — e.g. the run's status, its dataset item count against the expected minimum, a field missing from items, a log line.
3. Start runs of the same Actor at once, with the same build, memory, timeout and input. For example, you can start each with `POST https://api.apify.com/v2/acts/{actorId}/runs`. If a run can't start because the account's memory limit is reached, start it once earlier runs finish.

    Alongside the test's exact input, if the need arises, you can also run other inputs when the bug isn't directly related to what the test checks, to get a better picture of how often it happens. E.g. if the test scrapes a list page, and the investigation showed that one specific item failed to be scraped while others were fine, likely because of the detail page parser, you can also scrape that item's direct URL. Its rate might be more characteristic of the bug: the list page's content keeps changing, so its reproduction might fail in only a few % of runs, while the direct URL's might fail in closer to 100%.

    Decide on your own how many runs you need, up to !`echo "$MAX_FLAKINESS_RUNS"` in total. The point isn't a statistically significant rate, but a rough idea of whether the failure is frequent, infrequent or a once-in-a-lifetime event. For example:
    - Blocking that looks persistent: if around 20 runs all get blocked the same way, that's enough.
    - A rare flake that's hard to reproduce, e.g. one item out of hundreds missing a field: start a lot of runs — it may take a hundred runs, and after that another hundred, to see it even a few times.

4. Wait until every run has finished, then apply the check from step 2 to each. If there were no or almost no reproductions and you can't tell yet how often the failure happens, start more runs and check them the same way, but up to !`echo "$MAX_FLAKINESS_RUNS"` in total.
5. Add a short `## Flakiness` section to the issue, right after the Summary:
    - The rate, e.g. "Fails in 28 of 47 runs (60%)", per input if you ran several. Leave out runs that failed for another reason, e.g. never started — only mention how many there were.
    - Links to up to 2 runs that hit the failure.
