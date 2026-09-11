# Hybrid module fixtures

Canonical recorded responses for the three hybrid specialist modules:
`retrieval`, `synthesis`, and `policy-checker`.

These fixtures are used by integration tests that stub `callMgaCompletions`
to avoid live LLM calls during CI.

## Scenarios

### `retrieval/`
- `healthcare-scheduling-retrieval.json` — domain context for a clinic scheduling app
- `demand-planning-retrieval.json` — domain context for a supply-chain demand planner
- `llm-content-generator-retrieval.json` — domain context for an LLM-powered content tool

### `synthesis/`
- `llm-content-generator-synthesis.json` — prompt template + API spec for a content app
- `demand-planning-synthesis.json` — synthesis output for a demand-planning app with LLM features

### `policy-checker/`
- `healthcare-scheduling-policy.json` — HIPAA + ADA flags for a healthcare scheduling app
- `llm-content-generator-policy.json` — GDPR + copyright flags for an AI content tool
- `finance-dashboard-policy.json` — FINRA + PCI-DSS flags for a finance app
- `clean-no-flags-policy.json` — empty flags (no compliance concerns detected)

## Usage in tests

```js
import { readFixture } from '../util/fixture-loader.js';

const fixture = readFixture('mga-responses/hybrid/retrieval/healthcare-scheduling-retrieval.json');
// fixture.response.completionText is the stringified JSON the specialist returns
vi.mocked(callMgaCompletions).mockResolvedValueOnce({
  content: fixture.response.completionText,
  ...fixture.response.usage,
});
```
