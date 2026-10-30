---
id: incident-gateway
title: Incident review: Telemetry Gateway outage
kind: Incident review
date: 2026-05-15
---

On 14 May 2026, the Telemetry Gateway rejected device connections for three hours. Every device that uploads through the gateway lost data for that window.

The cause was an expired TLS certificate on the gateway's load balancer. Uploads from Atlas-3 sensors, Borealis controllers and Meridian flow meters all failed.

The review recommended automating certificate renewal and alerting 30 days before any certificate expires.
