# ADR 1: Orchestration Framework

## Context
We need a robust framework for orchestrating multiple LLM agents, handling state management, and supporting human-in-the-loop (HITL) workflows.

## Decision
We will use LangGraph.

## Rationale
- LangGraph provides a stateful graph abstraction which aligns well with our flow (Plan -> Gather -> Analyze -> Report).
- It has native support for checkpoints and interrupt/resume functionality, which is essential for our HITL requirements.
- Native integration with LiteLLM/Langchain ecosystem.

## Consequences
- Team needs to learn LangGraph paradigms.
- State must be explicitly modeled in typed dictionaries.
