# Connecting a phone number

The agent does not care whether a caller arrives from the browser or a phone. LiveKit SIP
turns a phone call into a room with a SIP participant, and the dispatch rule sends the
`clinic-agent` worker into it. This example provisions nothing; these are the steps to try
it with your own number. Phone minutes cost money at your carrier and on LiveKit Cloud.

Steps follow LiveKit's guide [Inbound calls with Twilio](https://docs.livekit.io/telephony/accepting-calls/inbound-twilio/),
checked on 2026-10-28. Telnyx, Exotel and other carriers follow the same pattern with their own
trunk settings.

## 1. Use LiveKit Cloud

SIP needs a LiveKit Cloud project (or a self-hosted LiveKit SIP service). Put its URL, key and
secret in `.env`, and install the [LiveKit CLI](https://docs.livekit.io/home/cli/) (`lk`).

## 2. Send the number to LiveKit

In Twilio, buy a number and create a TwiML Bin that dials your LiveKit SIP endpoint
(shown in the LiveKit Cloud project settings), with a username and password:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip username="<sip_user>" password="<sip_password>">
      sip:+1XXXXXXXXXX@<your-sip-endpoint>;transport=tcp
    </Sip>
  </Dial>
</Response>
```

Set the number's voice configuration to use this TwiML Bin.

## 3. Create the inbound trunk and dispatch rule

From `agents/clinic-voice-agent/`, after putting your number in `telephony/inbound-trunk.json`:

```bash
lk sip inbound create telephony/inbound-trunk.json --auth-user <sip_user> --auth-pass <sip_password>
lk sip dispatch create telephony/dispatch-rule.json --trunks "<trunk-id>"
```

The dispatch rule puts each call in its own `call-…` room and dispatches `clinic-agent`, the
name the worker registers with (`AGENT_NAME`).

## 4. Run the worker and call

```bash
uv run python -m voiceagent serve
uv run python -m voiceagent.worker dev
```

Call the number. The worker reads the caller's number from the SIP participant's
`sip.phoneNumber` attribute and runs the same pre-call lookup as the dashboard. To be
recognised as a patient, add your number to `PATIENTS` in `voiceagent/crm/server.py`.

## Transfers

On a phone call, `transfer_call` and the guards call LiveKit's `transfer_sip_participant`
with `tel:<number>` from `workflow/clinic.yaml`, which asks the carrier to transfer the call
(SIP REFER). With Twilio this needs an Elastic SIP Trunk with call transfer enabled; the
TwiML Bin route above does not support REFER. The placeholder numbers in the workflow
(`+1555010010x`) do not ring anywhere: replace them with real ones.
