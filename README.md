# assemblyai-voice-agent-scheduler

A voice agent that books real dental appointments — built on AssemblyAI's
Voice Agent API using **server-side HTTP tools**, so there is no tool
dispatcher and nothing of yours stays connected during a call.

Reference implementation for the tutorial *"Ship a Voice Agent That Books
Appointments — Without Writing a Tool Dispatcher"*, written for the
[AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon)
(submissions close Sep 30, 2026).

## The idea

Most voice-agent tutorials put your program in the middle of every call:

```
caller <-> AssemblyAI <-> your script (connected all call) <-> your logic
                          listens for tool.call, replies with tool.result
```

This one doesn't. You describe the agent once as JSON, hand AssemblyAI a set
of URLs, and it calls your API itself:

```
caller <-> AssemblyAI --HTTP POST--> your booking API
```

Close your laptop and the agent still answers. That matters here: hackathon
submissions need a hosted demo URL that judges can actually try.

## Quickstart

```bash
python -m venv .venv
.venv/Scripts/activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

uvicorn app.main:app --reload   # booking API on :8000
```

AssemblyAI calls your tools from its own servers, so the API must be publicly
reachable over HTTPS. In another terminal:

```bash
cloudflared tunnel --url http://localhost:8000 

or

ngrok http 8000
```

Copy `.env.example` to `.env`, fill in `ASSEMBLYAI_API_KEY` and the tunnel URL (https://.....*)
as `PUBLIC_API_BASE_URL`, then publish the agent:

```bash
python scripts/create_agent.py
```

You get an `agent_id`. Edit `agent.json` and re-publish with
`python scripts/create_agent.py --update <agent_id>`.

## Layout

| Path | What it is |
| --- | --- |
| `agent.json` | The whole agent: prompt, voice, keyterms, and 4 HTTP tools |
| `app/main.py` | Booking API — the endpoints AssemblyAI calls |
| `app/store.py` | In-memory calendar; swap for a real database |
| `scripts/create_agent.py` | Publishes `agent.json` to `/v1/agents` |

## The four tools

| Tool | Why it exists |
| --- | --- |
| `get_today` | The model has no clock. Without this it guesses dates, and guesses wrong. |
| `check_availability` | Returns open slots, or suggests the next open day when full. |
| `book_appointment` | Reserves the slot, returns a confirmation code. |
| `send_confirmation` | Texts the caller their code. |

Every response carries a `message` field written to be read aloud, and an `ok`
flag. Failures are values, not exceptions — `slot_taken` comes back with the
times that are still free, so the agent recovers inside the conversation
instead of apologising and hanging up.

## Schema as a guardrail

The tool parameters use `pattern`, `enum` and `examples` deliberately. Values
that fail validation are rejected before your API is ever called, and the
agent re-asks the caller:

```json
"phone": {
  "type": "string",
  "pattern": "^[+][1-9]0-9{1,14}$",
  "examples": ["+14155552671"]
}
```

That single line is what stops the agent inventing a phone number when it
mishears one. (See `agent.json` for the exact expression.)

## Talking to it

With the API running and the agent published, open <http://localhost:8000>.

Press **Start call** and ask to book a cleaning. The left pane is the
conversation; the right pane fills with the HTTP calls AssemblyAI makes to your
booking API while you talk. Nothing in the browser handles those calls — that
pane is reading your API's own log, which is the whole point.

The browser never sees your API key. `GET /api/token` mints a 5-minute token
server-side and the socket authenticates with that.

## Status

- [x] Booking API, verified end to end
- [x] Agent definition with 4 HTTP tools and validated schemas
- [x] Publish / update script
- [x] Browser demo — mic capture, barge-in, live tool-call feed
- [ ] Agent published against a public tunnel URL
- [ ] Tutorial draft

Twilio is deliberately out of scope: trial numbers only dial pre-verified
numbers, so a reader could never call the agent. The browser demo works for
everyone.
