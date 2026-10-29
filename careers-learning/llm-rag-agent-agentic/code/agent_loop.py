import json
from openai import OpenAI
from config import OPENAI_MODEL

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
    client = OpenAI()  # reads OPENAI_API_KEY from the environment
    messages = [{"role": "system", "content": "You are a support agent. Check facts with tools before you answer."},
                {"role": "user", "content": task}]
    for _ in range(max_steps):
        reply = client.chat.completions.create(model=OPENAI_MODEL, messages=messages, tools=TOOLS).choices[0].message
        if not reply.tool_calls:      # no tool requested: the model thinks it's done
            return reply.content if reply.content is not None else "No response from model."
        messages.append(reply)        # keep the model's tool request in the history
        for call in reply.tool_calls:
            try:
                args = json.loads(call.function.arguments)
            except json.JSONDecodeError as e:
                error_result = {"error": f"Invalid JSON in tool arguments: {e}"}
                messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(error_result)})
                continue
            
            try:
                fn = RUN[call.function.name]
            except KeyError:
                error_result = {"error": f"Unknown tool: {call.function.name}"}
                messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(error_result)})
                continue
            
            try:
                result = fn(**args)
            except TypeError as e:
                error_result = {"error": f"Invalid arguments for {call.function.name}: {e}"}
                messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(error_result)})
                continue
            
            messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)})
    return "Stopped: hit the step limit."
