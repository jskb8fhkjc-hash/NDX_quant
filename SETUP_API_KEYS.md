# API Keys and Setup

This project requires a few environment variables for runtime. Only the keys listed under "Required at runtime" are necessary for the deployed backend to run. Several keys shown below are optional integrations mentioned in the docs — they are NOT required and will not be used by the running code unless you explicitly implement calls to those services.

## Required at runtime
- ETORO_API_KEY — eToro public API key used for market data
- ETORO_USER_KEY — eToro user key for market requests
- UPSTASH_REDIS_REST_KV_REST_API_URL — Upstash REST Redis URL (primary)
- UPSTASH_REDIS_REST_KV_REST_API_TOKEN — Upstash REST Redis token (primary)
- NEWS_API_KEY — (optional) NewsAPI key used for sentiment; if missing the system falls back to neutral sentiment

## Optional/future integrations (not used by default)
These services are documented for reference only. The runtime codebase on the `news_integration` branch does not call these services and omitting these environment variables will not break the backend.

- RAPIDAPI_KEY / RAPIDAPI_HOST — (optional) If you later enable Economic Calendar via RapidAPI
- FRED_API_KEY — (optional) If you later integrate FRED economic data
- POLYGON_API_KEY — (optional) If you later integrate Polygon market data

## Local development
Create a `.env.local` with required keys for local testing. Example:

```env
ETORO_API_KEY=your_etoro_api_key
ETORO_USER_KEY=your_etoro_user_key
UPSTASH_REDIS_REST_KV_REST_API_URL=your_upstash_url
UPSTASH_REDIS_REST_KV_REST_API_TOKEN=your_upstash_token
# NEWS_API_KEY is optional — system will continue with neutral sentiment if not provided
NEWS_API_KEY=your_newsapi_key
```

## Notes
- The codebase contains safe fallbacks and validations — missing optional keys will not throw unhandled errors.
- If you want me to remove all references to the optional keys from the docs entirely instead of keeping them for reference, tell me and I will strip them out.
