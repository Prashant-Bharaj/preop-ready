# PreOp Ready

Assistive checklist for planned cardiac procedures (TAVI, M-TEER). A deterministic rule engine decides the traffic light. A language model, when configured, only extracts structured fields from a report. The app never marks a patient cleared; a physician confirms that separately.

This is a prototype. It is not a medical device. Every patient in the seed data is synthetic.

The requirements and thresholds shipped with the demo are marked in the settings screen as **Demo-Werte – klinisch zu validieren**.

## Run in GitHub Codespaces or locally

```bash
docker compose up --build
```

Open http://localhost:8080. In Codespaces, use the forwarded port 8080.

If 8080 or 3000 is already taken on your machine, publish different host ports. The containers still listen on 8080 and 3000.

```bash
FRONTEND_PORT=8090 BACKEND_PORT=3010 docker compose up --build
```

The backend listens on port 3000. The browser calls `/api/...`; local nginx strips that prefix before the request reaches FastAPI.

## Environment

Create `backend/.env` only if you want live extraction. With no key, uploads use the offline mock and the demo still runs.

```bash
ALLOW_LOCAL_DEV_IDENTITY=true
MGA_BASE_URL=https://your-mygenassist-host/api/v1
MGA_API_KEY=your-key
MGA_MODEL=your-model-id
```

The same values are accepted under the platform names `LLM_ENDPOINT` / `SECRET_1`, `LLM_API_KEY` / `API_KEY`, and `LLM_MODEL` / `SECRET_2`. Do not point the client at a public model endpoint. There is no fallback URL.

`ALLOW_LOCAL_DEV_IDENTITY=true` is set in `docker-compose.yml` so a local session records confirmations as **Dr. Test Freigabe**. Do not set that flag in a deployed environment. There, the name comes from the verified `x-amzn-oidc-data` header. A present but invalid token is rejected.

## Reset the synthetic cohort

Dates are relative to the day you seed, so “tomorrow” stays populated.

```bash
docker compose exec backend python -m app.seed
```

## Tests

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pytest
```

## Demo script

1. Open the worklist. It defaults to tomorrow (T-1).
2. Testperson A is green: labs, echo, chest X-ray, ECG, a patient agreement signed beforehand, and anesthesia clearance are present and in range. The case is not “cleared” until you press **Freigabe bestätigen**.
3. Testperson B is yellow: labs are 10 days old (limit 7) and anesthesia is conditional (“Kalium korrigieren”).
4. Testperson C is red: echo missing, potassium critically low, patient agreement not signed, no anesthesia clearance.
5. Testperson D is red: a DOAC is still active and no pause is documented.
6. Testperson E is yellow: creatinine is in mg/dL instead of the configured µmol/L.
7. Testperson F is red: the chest X-ray is dated after the procedure.
8. Open **Aufgaben**, copy an order text, mark one done.
9. Open **Befund hochladen**. The list of synthetic files is on that page. Load `echo.txt` or `anesthesia.txt` (both are written for Testperson C), confirm, and reopen the case. The matching gap closes; the other findings stay.
10. Open **Einstellungen**, change a max age or a threshold, save, and return to the worklist. The lights are recomputed from the new JSON config.

The uploadable texts live in `context/` and are listed on the upload page: `labs.txt`, `echo.txt`, `ecg.txt`, `xray.txt`, `anesthesia.txt`, `agreement.txt`.

## Layout

- `frontend/` React, TypeScript, Vite, Tailwind. German by default, English toggle.
- `backend/app/rules/engine.py` the only place a traffic light is decided.
- `backend/app/llm_client.py` the only outbound model call.
- `backend/app/integrations/` empty extension points for a later ORBIS HL7/FHIR connector, booking intake, automatic re-check, notifications, and a discharge-letter hand-off.

SQLite is stored at `/data/preop-ready.sqlite` inside the backend container.
