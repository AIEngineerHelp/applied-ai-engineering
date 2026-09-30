"""Small, dependency-free statistics so each formula stays readable."""

import math
import random


def agreement(a, b):
    return sum(x == y for x, y in zip(a, b)) / len(a) if a else None


def cohen_kappa(a, b):
    """Agreement corrected for chance: 1 is perfect, 0 is what random guessing at the same rates gives."""
    n = len(a)
    if n == 0:
        return None
    observed = agreement(a, b)
    labels = set(a) | set(b)
    expected = sum((a.count(label) / n) * (b.count(label) / n) for label in labels)
    if expected == 1:
        # Both raters used a single label: kappa is undefined.
        return None
    return (observed - expected) / (1 - expected)


def wilson(successes, n, z=1.96):
    """95% interval for a proportion; stays sensible for small n and rates near 0 or 1."""
    if n == 0:
        return None
    p = successes / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def bootstrap(a, b, statistic, samples=2000, seed=7):
    """95% percentile interval by resampling cases with replacement."""
    n = len(a)
    if n == 0:
        return None
    rng = random.Random(seed)
    values = []
    for _ in range(samples):
        idx = [rng.randrange(n) for _ in range(n)]
        value = statistic([a[i] for i in idx], [b[i] for i in idx])
        if value is not None:
            values.append(value)
    if not values:
        return None
    values.sort()
    return values[int(0.025 * len(values))], values[min(len(values) - 1, int(0.975 * len(values)))]


def confusion(human, judge):
    """Counts with 'pass' as the positive class. A false pass is the costly error for an eval."""
    pairs = list(zip(human, judge))
    counts = {
        "true_pass": sum(h == "pass" and j == "pass" for h, j in pairs),
        "false_pass": sum(h == "fail" and j == "pass" for h, j in pairs),
        "true_fail": sum(h == "fail" and j == "fail" for h, j in pairs),
        "false_fail": sum(h == "pass" and j == "fail" for h, j in pairs),
    }
    human_fail = counts["false_pass"] + counts["true_fail"]
    human_pass = counts["true_pass"] + counts["false_fail"]
    counts["false_pass_rate"] = counts["false_pass"] / human_fail if human_fail else None
    counts["false_fail_rate"] = counts["false_fail"] / human_pass if human_pass else None
    return counts
