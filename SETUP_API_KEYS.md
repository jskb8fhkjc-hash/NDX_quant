# Setup Guide: Free API Keys for NDX_quant

## 1. **NewsAPI Key** (News Sentiment)

### Get Free API Key:
1. Go to: https://newsapi.org/register
2. Sign up with email
3. Verify your email
4. Copy your API key from the dashboard

### Free Tier Details:
- **Limit**: 100 requests/day
- **History**: Last 1 month only
- **Perfect for**: Development & monitoring

### Add to Vercel:
```bash
# In Vercel Dashboard → Settings → Environment Variables
NEWS_API_KEY=your_newsapi_key_here
```

---

## 2. **Economic Calendar API** (Multiple Options)

### **Option A: Rapid APIs (Recommended for Free Tier)**
1. Go to: https://rapidapi.com/casimiro.luis001-4PfSyFOXP8qJ/api/economic-calendar
2. Sign up with GitHub/Google (free)
3. Subscribe to **Economic Calendar API** (free tier)
4. Copy your **RapidAPI Key** from the header section

### Free Tier Details:
- **Limit**: 100 requests/month (adequate for monitoring)
- **Coverage**: Global economic calendar
- **Real-time data**: Yes

### Add to Vercel:
```bash
RAPIDAPI_KEY=your_rapidapi_key_here
RAPIDAPI_HOST=economic-calendar.p.rapidapi.com
```

---

### **Option B: FRED API (US Only, More Reliable)**
1. Go to: https://fred.stlouisfed.org/docs/api/fred-api-keys.asp
2. Register (free account)
3. Create API key
4. Get live US economic data

### Add to Vercel:
```bash
FRED_API_KEY=your_fred_api_key_here
```

---

### **Option C: Polygon.io (Extended Free Tier)**
1. Go to: https://polygon.io/
2. Sign up free
3. Get API key from dashboard
4. Includes forex, crypto, stocks, options

### Add to Vercel:
```bash
POLYGON_API_KEY=your_polygon_api_key_here
```

---

## 3. **All Environment Variables Needed**

Create `.env.local` for local development:

```env
# Existing
ETORO_API_KEY=your_etoro_api_key
ETORO_USER_KEY=your_etoro_user_key
UPSTASH_REDIS_REST_KV_REST_API_URL=your_redis_url
UPSTASH_REDIS_REST_KV_REST_API_TOKEN=your_redis_token

# New: News & Economic
NEWS_API_KEY=your_newsapi_key
RAPIDAPI_KEY=your_rapidapi_key
RAPIDAPI_HOST=economic-calendar.p.rapidapi.com

# Optional: Alternative sources
FRED_API_KEY=your_fred_api_key
POLYGON_API_KEY=your_polygon_api_key
```

---

## 4. **Vercel Deployment Steps**

### In your Vercel Dashboard:
1. Go to **Settings → Environment Variables**
2. Add all keys above
3. Make sure all are checked for Production
4. Redeploy project

### Deploy via CLI:
```bash
npm install -g vercel
vercel --prod
# Follow prompts to add env vars
```

---

## 5. **Default Instrument ID Updated**

All files now use **instrumentId 28** as default:
- `api/market.js` ✅
- `api/position.js` ✅
- `api/history.js` ✅
- `api/backtest.js` ✅
- `index.html` ✅

---

## 6. **Test Your Setup**

```bash
# Test News API integration
curl "https://your-vercel-domain/api/market?instrumentId=28&symbol=NDX"

# Expected response includes:
# - newsSentiment: number
# - economicRiskLevel: "LOW" | "HIGH" | "CRITICAL"
# - hasUpcomingEconomicEvent: boolean
```

---

## 7. **Cost Summary** (All Free)

| Service | Cost | Limit | Use Case |
|---------|------|-------|----------|
| NewsAPI | Free | 100/day | Market sentiment |
| RapidAPI Economic | Free | 100/month | Event detection |
| FRED | Free | Unlimited | Economic data |
| Polygon.io | Free | Tier-specific | Market data |

**Total Monthly Cost: $0**

---

## 8. **Troubleshooting**

### "403 Forbidden" errors:
- Check API key is correct
- Verify API is enabled in dashboard
- Check rate limits haven't been exceeded

### "No upcoming events":
- Economic calendar data may be sparse on weekends
- Most events happen Tue-Fri 1-2 PM ET

### "News sentiment not updating":
- NewsAPI updates daily around midnight UTC
- Check your 100/day limit with https://newsapi.org/account

