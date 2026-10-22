# Design: Ledger Export pipeline

Author: Amara Osei. Status: approved. 16 March 2026.

## Schedule

The export job runs nightly at 02:00 UTC. Requests made during the day are queued and processed in that run.

## Data flow

1. Read the queued requests.
2. For each customer, page through their invoices on the read replica.
3. Fetch each invoice's final total from the Billing API.
4. Write one CSV per request to the exports-prod bucket and email the customer a signed download link.

## Billing API limits

Jun Park (Payments team) confirmed that the Billing API allows 100 requests per second per client. The export job will call it at 80 requests per second to leave headroom.

## Retention

A lifecycle rule on exports-prod deletes export files 30 days after they are written. Signed download links expire after 7 days; a customer can request a new link while the file still exists.

## Risks

If the Billing API slows down, the nightly run may not finish before 06:00 UTC.
