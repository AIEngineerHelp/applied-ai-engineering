import json
from openai import OpenAI

client = OpenAI()  # reads OPENAI_API_KEY from the environment

def get_order(order_id: str) -> dict:
    # stand-in for your real order API
    return {"order_id": order_id, "status": "shipped", "carrier": "DHL", "eta": "2026-10-16"}

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_order",
        "description": "Look up an order's status by its id, e.g. A-1042.",
        "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
    },
}]
RUN = {"get_order": get_order}

def run_agent(task: str, max_steps: int = 6) -> str:
    messages = [{"role": "system", "content": "You are a support agent. Check facts with tools before you answer."},
                {"role": "user", "content": task}]
    for _ in range(max_steps):
        reply = client.chat.completions.create(model="gpt-5-mini", messages=messages, tools=TOOLS).choices[0].message
        if not reply.tool_calls:      # no tool requested: the model thinks it's done
            return reply.content
        messages.append(reply)        # keep the model's tool request in the history
        for call in reply.tool_calls:
            args = json.loads(call.function.arguments)
            result = RUN[call.function.name](**args)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)})
    return "Stopped: hit the step limit."
