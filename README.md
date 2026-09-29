# Personal Investing Agent

An educational stock-research agent built around the OpenAI Responses API.

The first slice is deliberately small: one agent loop, one typed research tool, paper theses, usage tracking, and delayed evaluation records. It does not place trades or provide personalized financial advice.

## Setup

```bash
npm install
cp .env.example .env
```

Add an API key to `.env`, then run:

```bash
npm run dev
```

Without an API key, the app runs in mock mode so the harness can be inspected without API spend.
When live mode is enabled, the `get_company_snapshot` tool uses the public SEC Company Facts API for historical filing data. Set `SEC_USER_AGENT` in `.env` to identify your app/contact per SEC guidance. Set `USE_MOCK_DATA=1` when you want deterministic offline tool fixtures.

Structured paper theses are saved to `data/theses.jsonl` with `status: "pending_review"`. These are educational paper records only; the app does not trade, size positions, or provide personalized buy/sell instructions.

## Next milestones

- Broaden company data with permitted price, benchmark, and fundamentals providers.
- Add specialist subagents for strategy, financials, and risk.
- Move thesis persistence from JSONL to SQLite once review/evaluation queries need indexing.
- Add a review worker for `reviewAt` dates.
- Compare predictions against a benchmark and classify reasoning errors.
