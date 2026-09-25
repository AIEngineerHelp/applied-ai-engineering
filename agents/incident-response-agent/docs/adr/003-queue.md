# ADR 3: Queue System

## Context
We need an asynchronous message queue to handle incoming incidents (from PagerDuty, Alertmanager, etc.) and buffer them for the orchestrator workers.

## Decision
We will use Redis Streams.

## Rationale
- Redis is already required for short-term memory and caching.
- Redis Streams provides consumer groups, which allows us to distribute work across multiple orchestrator workers.
- It supports retries and DLQ (Dead Letter Queue) semantics with a bit of custom logic.
- Simpler to deploy and maintain than Kafka or RabbitMQ for our scale.

## Consequences
- We need to implement custom DLQ logic.
- Memory size of Redis needs to be monitored since Streams can grow if consumers fall behind.
