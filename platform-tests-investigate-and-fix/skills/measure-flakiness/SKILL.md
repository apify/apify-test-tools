---
name: measure-flakiness
description: Re-runs the failing Actor run many times in parallel to measure how often the failure happens. Use only when you are about to create a new issue for a failing platform test and its failure rate is not already obvious.
---

# Measure flakiness

Use this only when both are true:

- You are about to create a new issue — no existing issue already covers this failure.
- How often the failure happens isn't obvious. Blocking, too few scraped items or a missing field can happen in 1% of runs or in all of them, and one failed run doesn't tell which.

## Steps

1. From the failing run (the run the failed test started; its link is in the test log), get the Actor ID, build number, memory, timeout and input.
2. Decide how to tell whether a finished run hit the same failure. Check what the failed test assertion checked — e.g. the run's status, its dataset item count against the expected minimum, a field missing from items, a log line.
3. Start !`echo "$FLAKINESS_RUNS"` runs of the same Actor at once, with the same build, memory, timeout and input. If a run can't start because the account's memory limit is reached, start it once earlier runs finish.
4. Wait until every run has finished, then apply the check from step 2 to each.
5. Add a short `## Flakiness` section to the issue, right after the Summary:
    - The rate, e.g. "Fails in 28 of 47 runs (60%)". Leave out runs that failed for another reason, e.g. never started — only mention how many there were.
    - Links to up to 2 runs that hit the failure.
