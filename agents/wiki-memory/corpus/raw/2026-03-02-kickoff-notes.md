# Kickoff: Ledger Export

Date: 2 March 2026. Attendees: Amara Osei (engineering lead), Rui Costa (product), Dana Whitfield (support).

## Why

Customers on every plan ask support for a copy of their invoices each month. Support exports them by hand from the admin console, about 40 tickets a week.

## Decisions

- Build a self-serve export: a customer picks a date range and receives one CSV of their invoices.
- Exports run as a nightly batch job, not on demand, so the job can read from the Postgres read replica while traffic is low.
- Finished export files are kept for 30 days, then deleted.
- Invoice totals come from the Billing API, which the Payments team owns.

## Owners

Amara owns the project. Rui owns the customer-facing copy.

## Open questions

- What request rate may we use against the Billing API? Amara will ask Payments.
