# Prompt caching experiment: gemini-3.8-flash, 2026-10-07

Run `r202610079c02`: 96 requests (12 per layout, 1500 ms apart, one at a time), 0 errors, total cost about $0.3777.
Prices used (USD per million tokens): input $0.75, cached input $0.075, output $3.75, explicit cache storage $0.5 per hour. Minimum cacheable prompt: 4,096 tokens.

Implicit caching: 0 hits in 84 eligible requests.

| Layout | Requests | Prompt tokens (median) | Requests with a cache hit | Cached share of prompt | Reusable prefix (tokens) | Reusable share | First token, median (ms) | Cost per request |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Stable prefix | 12 | 5398 | 0 | 0.0% | 5382 | 99.7% | 2101.5 | $0.00439 |
| Timestamp at the top | 12 | 5429 | 0 | 0.0% | 783 | 14.4% | 1968 | $0.00436 |
| Timestamp at the bottom | 12 | 5429 | 0 | 0.0% | 5403 | 99.5% | 2001.5 | $0.00435 |
| Customer details at the top | 12 | 5419.5 | 0 | 0.0% | 774 | 14.3% | 1799.5 | $0.00438 |
| Customer details at the bottom | 12 | 5419.5 | 0 | 0.0% | 5389 | 99.4% | 2116.5 | $0.00448 |
| Tools in a different order | 12 | 5401 | 0 | 0.0% | 11 | 0.2% | 2069 | $0.00443 |
| Question before the handbook | 12 | 5406 | 0 | 0.0% | 1086 | 20.1% | 1849 | $0.00436 |
| Explicit cache | 12 | 5398 | 12 | 99.7% | 5384 | 99.7% | 2299 | $0.00072 |

Reusable prefix: the median length, in tokens, of the prefix that consecutive requests shared byte for byte, with the request rendered as tools, then system instruction, then user message. It's the most a prefix cache could reuse, whatever the provider does. For the explicit cache, it's the size of the stored cache.

Projected input cost per 1,000 requests if the reusable prefix were always served from cache (a projection, not a measurement):

| Layout | Without cache | Reusable prefix cached |
|---|---:|---:|
| Stable prefix | $4.0485 | $0.4157 |
| Timestamp at the top | $4.0718 | $4.0718 |
| Timestamp at the bottom | $4.0718 | $0.4247 |
| Customer details at the top | $4.0646 | $4.0646 |
| Customer details at the bottom | $4.0646 | $0.4271 |
| Tools in a different order | $4.0508 | $4.0508 |
| Question before the handbook | $4.0545 | $4.0545 |
| Explicit cache | $4.0485 | $0.4143 |

Explicit cache: 5384 tokens, created in 2182 ms, alive 1.1 minutes, storage about $0.000049.
