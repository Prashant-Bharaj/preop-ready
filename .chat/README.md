# Harness credentials

The build harness reads its MGA credentials from `.chat/secrets.json`, which is
**gitignored** (never commit it).

## Set up

Copy the example and fill in your MGA API key:

```bash
cp .chat/secrets.example.json .chat/secrets.json
```

Then edit `.chat/secrets.json` and set `apiKey` to your MGA key. `baseUrl` and
`model` are pre-filled; `mode`/`projectType` can stay as-is.

Alternatively, start the harness and enter your key in the Connect screen — it
writes `.chat/secrets.json` for you.

The harness's shared assistant IDs live in `chat/config/assistants.json`
(tracked); only your personal `apiKey` goes in `.chat/secrets.json`.

⛔ `.chat/secrets.json` holds a real credential — it is gitignored on purpose.
