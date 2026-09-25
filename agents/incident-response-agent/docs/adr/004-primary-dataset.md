# ADR 4: Primary Dataset for Evaluation

## Context
To build, test, and evaluate the Incident Response Agent, we need realistic data representing system failures, alerts, and logs.

## Decision
We will use the Loghub and Loghub-2.0 datasets as our primary data source.

## Rationale
- Loghub provides real-world logs from systems like Hadoop, HDFS, BGL, and OpenStack, complete with failure injections and anomaly labels.
- Loghub-2.0 provides parsed templates which are critical for the Log Explorer grouping feature.
- It is freely available for research and allows us to rigorously evaluate fault-type accuracy and component localization.

## Consequences
- We must build a Loghub Replay Harness to simulate real-time incident generation from historical log slices.
- The evaluation will be heavily biased towards log-based RCA until we incorporate traces and metrics.
