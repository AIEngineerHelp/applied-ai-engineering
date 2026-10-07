# Tidewater Shipments API v3

The Tidewater Shipments API lets you create shipments, book pickups, track freight in real time, and receive status updates as webhooks. This reference covers version 3 of the API, which became generally available on 2026-03-02. All examples use the production base URL `https://api.tidewaterfreight.com/v3`. A sandbox with the same endpoints runs at `https://sandbox.tidewaterfreight.com/v3`; sandbox shipments never leave the dock and are deleted after 30 days.

## Getting started

Every request is made over HTTPS and every response body is JSON encoded in UTF-8. Timestamps use ISO 8601 in UTC, for example `2026-04-18T09:30:00Z`. Weights are expressed in kilograms and dimensions in centimeters unless the request sets `units` to `imperial`.

To make your first call you need an account in the Tidewater Console and an API key. New accounts start on the Starter plan, which is free for up to 200 shipments per month. You can upgrade to Growth or Enterprise from the Billing page in the Console at any time, and the new limits apply within five minutes.

### Authentication

The API authenticates requests with secret keys sent as a bearer token in the `Authorization` header. Keys that begin with `tw_live_` work only against production, and keys that begin with `tw_test_` work only against the sandbox. A request that sends a live key to the sandbox host, or a test key to production, fails with `401 key_environment_mismatch`.

```bash
curl https://api.tidewaterfreight.com/v3/shipments \
  -H "Authorization: Bearer tw_live_4f9c2a7e81d0" \
  -H "Content-Type: application/json"
```

Treat API keys like passwords. Do not embed them in mobile apps or browser code. If a key is exposed, roll it from the API Keys page in the Console; the old key keeps working for 24 hours after a roll so you can deploy the replacement without downtime. To revoke a key immediately instead, choose Revoke, which takes effect within 60 seconds.

### Scopes

Each key carries one or more scopes. A key without the required scope receives `403 insufficient_scope`.

- `shipments:read` lets a key list and retrieve shipments and tracking events.
- `shipments:write` lets a key create, update and cancel shipments.
- `pickups:write` lets a key book and cancel pickups.
- `webhooks:manage` lets a key create, update and delete webhook endpoints.

Restricted keys created for warehouse scanners should carry only `shipments:read`, because scanners only need to look up labels.

## Rate limits

Tidewater applies rate limits per account, not per key, so creating more keys does not raise your limit. Limits are measured with a sliding one-minute window. Read requests (GET) and write requests (POST, PATCH, DELETE) are counted separately.

| Plan | Read requests per minute | Write requests per minute | Burst allowance | Concurrent tracking streams | Typical use |
| --- | --- | --- | --- | --- | --- |
| Starter | 120 | 30 | 20 | 2 | Prototypes and small shops |
| Growth | 1,200 | 300 | 150 | 25 | Mid-size shippers and marketplaces |
| Enterprise | 6,000 | 1,500 | 600 | 200 | High-volume shippers and 3PLs |

The burst allowance is the number of extra requests you can send in any ten-second period above the steady rate before throttling begins. When you exceed a limit the API responds with `429 rate_limited` and includes a `Retry-After` header with the number of seconds to wait. Every response also includes `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers so you can slow down before you hit the limit.

Enterprise customers can request a temporary limit increase for peak season by contacting their account manager at least 14 days before the expected surge. Temporary increases last up to 45 days.

## Shipments

A shipment represents one consignment moving from an origin to a destination under one service level. A shipment contains one or more packages and can be tracked as soon as it is created.

### Create a shipment

Send a `POST` request to `/shipments`. The `service` field accepts `ground`, `express` or `freight_ltl`. For `freight_ltl` shipments you must also send `freight_class`, a value between 50 and 500 that describes the density and handling difficulty of the load.

```bash
curl -X POST https://api.tidewaterfreight.com/v3/shipments \
  -H "Authorization: Bearer tw_live_4f9c2a7e81d0" \
  -H "Idempotency-Key: 6b1f0c3e-2d7a-4e55-9a31-7c0e8f2d4b19" \
  -H "Content-Type: application/json" \
  -d '{
    "service": "express",
    "origin": {"postal_code": "97204", "country": "US"},
    "destination": {"postal_code": "M5V 2T6", "country": "CA"},
    "packages": [{"weight": 4.2, "length": 40, "width": 30, "height": 20}],
    "reference": "PO-88213"
  }'
```

A successful request returns `201 Created` with the new shipment:

```json
{
  "id": "shp_01HVZ8K2Q4",
  "status": "label_created",
  "service": "express",
  "tracking_number": "TWF7730194425",
  "estimated_delivery": "2026-04-21",
  "label_url": "https://labels.tidewaterfreight.com/shp_01HVZ8K2Q4.pdf",
  "created_at": "2026-04-18T09:30:00Z"
}
```

Labels are generated as 4x6 inch PDFs by default. Send `"label_format": "zpl"` to receive ZPL for thermal printers instead. Label URLs are signed and expire after 72 hours; retrieve the shipment again to get a fresh URL.

A single shipment can contain at most 50 packages, and each package can weigh at most 68 kg for `ground` and `express`. Heavier items must use `freight_ltl`, which accepts pallets up to 1,800 kg each.

### Cancel a shipment

Send `DELETE /shipments/{id}` to cancel a shipment. You can cancel a shipment only while its status is `label_created` or `pickup_scheduled`. Once the carrier has scanned the first package the shipment can no longer be cancelled through the API, and the request fails with `409 shipment_in_transit`. Cancelled labels are voided and are not billed.

### Shipment statuses

A shipment moves through these statuses in order: `label_created`, `pickup_scheduled`, `in_transit`, `out_for_delivery`, `delivered`. Two statuses can occur at any point after `in_transit`: `exception`, when a delay or damage is reported, and `returned_to_sender`, when delivery has failed three times or the recipient refuses the shipment.

## Tracking

Retrieve the full event history with `GET /shipments/{id}/events`. Events are returned newest first and include a location, a status and a free-text description from the handling facility.

For live dashboards, open a tracking stream with `GET /tracking/stream`. The stream uses server-sent events and pushes an event within five seconds of each scan. The number of streams you can hold open at once depends on your plan; see the Rate limits section. Streams are closed by the server after 24 hours, so clients should reconnect and pass the `Last-Event-ID` header to resume without gaps.

## Pagination

List endpoints such as `GET /shipments` and `GET /shipments/{id}/events` use cursor pagination. Pass `limit` to set the page size, from 1 to 100, with a default of 25. Each response includes a `next_cursor` field; pass it as the `cursor` parameter to fetch the next page. When `next_cursor` is `null` you have reached the last page.

```json
{
  "data": [{"id": "shp_01HVZ8K2Q4", "status": "in_transit"}],
  "next_cursor": "c2hwXzAxSFZaOEsyUTQ"
}
```

Cursors remain valid for 15 minutes. Offset-based pagination with the `page` parameter was removed in v3; requests that send `page` fail with `400 unsupported_parameter`.

## Idempotency

Network failures can leave you unsure whether a request succeeded. To retry safely, send an `Idempotency-Key` header with a unique value, such as a UUID, on every `POST` request. If Tidewater receives a second request with the same key, it returns the stored response of the first request instead of creating a duplicate shipment or pickup.

Idempotency keys are stored for 24 hours. Reusing a key with a different request body returns `422 idempotency_key_reused`. Keys are scoped to your account, so two different accounts can safely use the same value. `GET` and `DELETE` requests are already idempotent and ignore the header.

## Webhooks

Webhooks notify your server when something happens to a shipment, so you do not need to poll. Create an endpoint with `POST /webhook_endpoints`, giving an HTTPS URL and the list of events you want to receive.

### Event types

- `shipment.created` fires when a label is generated.
- `shipment.status_changed` fires on every status change, including exceptions.
- `shipment.delivered` fires once, when proof of delivery is recorded.
- `pickup.missed` fires when a driver arrives and no freight is ready.

### Verifying signatures

Each webhook request includes a `Tidewater-Signature` header containing a timestamp and an HMAC-SHA256 signature of the raw request body, computed with your endpoint's signing secret. Compute the same HMAC on your side and compare it in constant time. Reject any request whose timestamp is more than five minutes old, to prevent replay attacks.

### Retries and delivery

Your endpoint must respond with a 2xx status code within 10 seconds. Any other response, or a timeout, counts as a failed delivery.

Tidewater retries failed deliveries with exponential backoff: after 1 minute, 5 minutes, 30 minutes, 2 hours, 8 hours and finally 24 hours, for a total of seven attempts over about 35 hours. If every attempt fails, the event is dropped and the endpoint is marked as failing in the Console. An endpoint that fails continuously for 72 hours is disabled automatically, and the account owner receives an email.

Webhook deliveries are not guaranteed to arrive in order, and the same event may be delivered more than once. Use the `event_id` field to discard duplicates and the `occurred_at` field to order events.

## Errors

Tidewater uses conventional HTTP status codes. Codes in the 4xx range mean the request was invalid and should not be retried without changes; codes in the 5xx range mean something went wrong on our side and the request can be retried with backoff. Every error response has the same shape:

```json
{
  "error": {
    "code": "invalid_postal_code",
    "message": "Destination postal code M5V 2T6X is not valid for CA.",
    "request_id": "req_9QX2M1T7"
  }
}
```

Include the `request_id` when you contact support; it lets the support team find the exact request in our logs.

### Common error codes

| HTTP status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_postal_code` | The origin or destination postal code does not match the country. |
| 400 | `unsupported_parameter` | The request includes a parameter that v3 does not accept. |
| 401 | `key_environment_mismatch` | A live key was sent to the sandbox or a test key to production. |
| 403 | `insufficient_scope` | The key does not carry the scope this endpoint requires. |
| 409 | `shipment_in_transit` | The shipment has been scanned and can no longer be changed. |
| 422 | `idempotency_key_reused` | The idempotency key was already used with a different body. |
| 429 | `rate_limited` | The account exceeded its plan's request rate. |
| 503 | `carrier_unavailable` | The carrier network for this lane is temporarily unreachable. |

A `503 carrier_unavailable` error usually clears within a few minutes. Retry with exponential backoff starting at two seconds, and stop after five attempts.

## Versioning and deprecation

The API version is part of the URL. Within a version we only make backward-compatible changes, such as adding optional request parameters, new response fields or new event types. Your integration should ignore response fields it does not recognize.

Version 2 of the Shipments API is deprecated and will be shut down on 2027-01-31. Until then, v2 responses include a `Sunset` header with that date. After the shutdown date, v2 requests will fail with `410 version_retired`. To migrate, replace offset pagination with cursors (see Pagination), switch the `weight_lbs` field to `weight` with `units`, and move webhook verification from the legacy `X-TW-Token` header to signature verification as described in Verifying signatures.

We announce every new major version at least 12 months before the previous one is retired, and we email the account owner 90, 30 and 7 days before a shutdown.
