"""Tool safeguards: deterministic checks that run before every tool call.

The model proposes a call; this code decides. Three kinds of check, in order:
1. Authorization: the order belongs to the signed-in customer, and emails go only to them.
2. Business rules on the arguments: refund limits, order status.
3. Risk gating: high-risk calls, and any write after untrusted text entered the context,
   pause for a human instead of running. This is the "Rule of Two": untrusted input plus
   the power to change state should not both be in one autonomous session.

Identity comes from the session, never from the conversation, so "I'm a supervisor" changes nothing.
"""

from guardlab.tools import TOOLS, UNTRUSTED_FIELDS

AUTO_REFUND_LIMIT = 100.00   # refunds above this need a person
REFUND_WINDOW_DAYS = 30


def decide(store, session, name, args):
    """Return ("allow" | "deny" | "approve", reason). "approve" means: pause for a human."""
    if name not in TOOLS:
        return "deny", f"Unknown tool {name}."
    customer = store.customer(session["customer_id"])
    order = store.order(args["order_id"]) if "order_id" in args else None

    if "order_id" in args:
        if order is None:
            return "deny", "No such order."
        if order["customer"] != session["customer_id"]:
            return "deny", "That order belongs to a different customer."

    if name == "send_email" and args.get("to", "").strip().lower() != customer["email"].lower():
        return "deny", "Emails can only go to the customer's address on file."

    if name in ("update_address", "cancel_order") and order["status"] != "processing":
        return "deny", f"The order is already {order['status']}; it can no longer be changed."

    if name == "issue_refund":
        try:
            amount = round(float(args["amount"]), 2)
        except (TypeError, ValueError, KeyError):
            return "deny", "The refund amount is not a number."
        remaining = round(order["total"] - order.get("refunded", 0), 2)
        if order["status"] not in ("delivered", "returned"):
            return "deny", "Only delivered or returned orders can be refunded."
        if order.get("delivered_days_ago", 0) > REFUND_WINDOW_DAYS:
            return "deny", f"Refunds are available for {REFUND_WINDOW_DAYS} days after delivery."
        if not 0 < amount <= remaining:
            return "deny", f"The refund must be between $0.01 and the ${remaining:.2f} not yet refunded."
        if amount > AUTO_REFUND_LIMIT:
            return "approve", f"Refunds over ${AUTO_REFUND_LIMIT:.0f} need a person to approve them."

    rating = TOOLS[name]
    if session.get("tainted") and rating["access"] == "write":
        return "approve", "Untrusted text is in the conversation, so changes need a person to approve them."
    return "allow", ""


def taints(name, result):
    """True when a tool result carries text the agent did not write (an order note, say)."""
    if name != "lookup_order" or not isinstance(result, dict):
        return False
    return any(str(result.get(f) or "").strip() for f in UNTRUSTED_FIELDS)
