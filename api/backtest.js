import { Redis } from "@upstash/redis";
import { detectRegime } from "../core/regime.js";
import { getEnsembleSignal } from "../core/strategy/aggregator.js";

function uuidv4() { 
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => (c === "x" ? Math.random() * 16 | 0 : (Math.random() * 16 | 0 & 0x3 | 0x8)).toString(16)); 
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

const SCORE_THRESHOLDS = [55, 60, 65, 70];
const MAX_ACCEPTABLE_DRAWDOWN = -25.0;

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try { 
    return await fetch(url, { ...options, signal: controller.signal }); 
  } finally { 
    clearTimeout(id); 
  }
}

function getCandlesFromResponse(candleData) {
  if (!candleData?.candles?.[0]?.candles) return [];
  return candleData.candles[0].candles.map(c => ({
    fromDate: c.fromDate,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close)
  })).sort((a,b) => new Date(a.fromDate) - new Date(b.fromDate));
}

function getMaxDrawdown(equityCurve) {
  let peak = 0; let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  return maxDrawdown;
}

function runBacktest({ candles, horizonDays, spreadPercent, minConfidenceThreshold, warmupCandles }) {
  const trades = [];
  const equityCurve = [0];
  let cumulativeReturn = 0;

  for (let i = warmupCandles; i < candles.length - horizonDays; i++) {
    const setupCandles = candles.slice(0, i + 1);
    
    const regimeState = detectRegime(setupCandles) || { metrics: {} };
    
    // Provide simulated intraday contexts derived from daily candles to satisfy ensemble
    const simulatedHourCandles = setupCandles.slice(-24);
    const simulatedFourHourCandles = setupCandles.slice(-48);

    const ensemble = getEnsembleSignal(simulatedHourCandles, simulatedFourHourCandles, setupCandles, regimeState) || {};

    // Filter using confidence metrics; handle undefined properties safely
    if (!ensemble.signal || ensemble.signal === "HOLD" || (ensemble.confidence || 0) < minConfidenceThreshold) {
      continue;
    }

    const tradeEntryPrice = candles[i].close;
    const tradeExitPrice = candles[i + horizonDays].close;

    const grossReturn = ensemble.signal === "BUY"
      ? (tradeExitPrice - tradeEntryPrice) / tradeEntryPrice
      : (tradeEntryPrice - tradeExitPrice) / tradeEntryPrice;

    const netReturn = grossReturn - (spreadPercent / 100);
    cumulativeReturn += netReturn;
    equityCurve.push(cumulativeReturn);

    trades.push({
      date: candles[i].fromDate,
      signal: ensemble.signal,
      score: ensemble.confidence || 0,
      entry: typeof tradeEntryPrice === "number" ? tradeEntryPrice.toFixed(2) : "0.00",
      exit: typeof tradeExitPrice === "number" ? tradeExitPrice.toFixed(2) : "0.00",
      returnPercent: (netReturn * 100).toFixed(2),
      rsi: typeof ensemble.rsi === "number" ? ensemble.rsi.toFixed(2) : "--",
      atrPercent: typeof regimeState.metrics?.atrPercent === "number" ? regimeState.metrics.atrPercent.toFixed(3) : "0.000"
    });
  }

  const wins = trades.filter(t => parseFloat(t.returnPercent) > 0).length;
  const maxDrawdownValue = getMaxDrawdown(equityCurve) * 100;

  return {
    trades,
    totalSignals: trades.length,
    buySignals: trades.filter(t => t.signal === "BUY").length,
    sellSignals: trades.filter(t => t.signal === "SELL").length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? ((wins / trades.length) * 100).toFixed(1) + "%" : "0.0%",
    averageReturn: trades.length ? (trades.map(t => parseFloat(t.returnPercent)).reduce((a,b)=>a+b,0) / trades.length).toFixed(2) + "%" : "0.00%",
    cumulativeReturn: (cumulativeReturn * 100).toFixed(2) + "%",
    maxDrawdown: maxDrawdownValue.toFixed(2) + "%",
    maxDrawdownValue,
    drawdownGuardActive: maxDrawdownValue <= MAX_ACCEPTABLE_DRAWDOWN
  };
}

export default async function handler(req, res) {
  try {
    // Trim env vars to avoid accidental whitespace causing header validation errors
    const API_KEY = (process.env.ETORO_API_KEY || "").trim();
    const USER_KEY = (process.env.ETORO_USER_KEY || "").trim();
    const instrumentId = req.query.instrumentId || "28";
    const horizonDays = Math.max(1, Math.min(20, parseInt(req.query.horizonDays || "5", 10)));
    const spreadPercent = parseFloat(req.query.spreadPercent || "0.05");

    if (!API_KEY || !USER_KEY) {
      throw new Error("Missing eToro API credentials in backend environment.");
    }

    // Robust candle fetch with cache fallback and validation
    const candleUrl = `https://public-api.etoro.com/api/v1/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/1000`;

    const candleResponse = await fetchWithTimeout(
      candleUrl,
      { headers: { "x-api-key": API_KEY, "x-user-key": USER_KEY, "x-request-id": uuidv4() } }
    );

    let candleJson;

    if (!candleResponse || !candleResponse.ok) {
      console.error(`eToro Candles API failed: Status=${candleResponse?.status}. Attempting to use cached candles.`);
      const cached = await redis.get(`cached-candles-${instrumentId}`);
      if (cached) {
        try {
          candleJson = JSON.parse(cached);
        } catch (e) {
          console.error('Failed to parse cached candles from Redis:', e.message);
          throw new Error('Failed to retrieve valid candle data from eToro and cache.');
        }
      } else {
        throw new Error(`eToro Candles API rejected request (Status: ${candleResponse?.status || 'no response'})`);
      }
    } else {
      try {
        candleJson = await candleResponse.json();
        if (!candleJson?.candles?.[0]?.candles) {
          throw new Error('Malformed candle payload from eToro: missing candles[0].candles');
        }
        // Cache the raw response for resilience (best-effort)
        try { await redis.set(`cached-candles-${instrumentId}`, JSON.stringify(candleJson)); } catch (e) { console.warn('Failed to cache candles:', e.message); }
      } catch (e) {
        console.error('Failed to parse candle response JSON:', e.message);
        const cached = await redis.get(`cached-candles-${instrumentId}`);
        if (cached) {
          try { candleJson = JSON.parse(cached); }
          catch (pe) { console.error('Failed to parse cached candles after JSON error:', pe.message); throw new Error('Malformed candle JSON from eToro and cache fallback failed.'); }
        } else {
          throw new Error('Malformed candle JSON from eToro and no cache available.');
        }
      }
    }

    const candles = getCandlesFromResponse(candleJson);
    const minimumCandles = 100 + horizonDays;

    if (candles.length < minimumCandles) {
      return res.status(200).json({ 
        success: true, 
        instrumentId, 
        horizonDays, 
        totalSignals: 0, 
        winRate: "0.0%", 
        cumulativeReturn: "0.00%", 
        maxDrawdown: "0.00%", 
        thresholdResults: [], 
        recentTrades: [],
        warning: `Insufficient historical data: ${candles.length} candles received, minimum ${minimumCandles} required for backtesting`
      });
    }

    const warmupCandles = 100; 
    const baseConfidenceThreshold = 60;

    const primaryBacktest = runBacktest({ candles, horizonDays, spreadPercent, minConfidenceThreshold: baseConfidenceThreshold, warmupCandles });

    const thresholdResults = SCORE_THRESHOLDS.map(threshold => {
      const result = runBacktest({ candles, horizonDays, spreadPercent, minConfidenceThreshold: threshold, warmupCandles });
      return {
        threshold,
        totalSignals: result.totalSignals,
        winRate: result.winRate,
        averageReturn: result.averageReturn,
        cumulativeReturn: result.cumulativeReturn,
        maxDrawdown: result.maxDrawdown,
        drawdownGuardActive: result.drawdownGuardActive
      };
    });

    const bestThreshold = thresholdResults.filter(r => !r.drawdownGuardActive).sort((a,b)=> parseFloat(b.averageReturn) - parseFloat(a.averageReturn))[0] || thresholdResults.sort((a,b)=> parseFloat(b.averageReturn) - parseFloat(a.averageReturn))[0];

    await redis.set(`backtest-summary-${instrumentId}`, {
      instrumentId, horizonDays, totalSignals: primaryBacktest.totalSignals, winRate: primaryBacktest.winRate, cumulativeReturn: primaryBacktest.cumulativeReturn, maxDrawdown: primaryBacktest.maxDrawdown, bestThreshold: bestThreshold?.threshold || baseConfidenceThreshold
    });

    return res.status(200).json({
      success: true,
      instrumentId,
      horizonDays,
      candlesTested: candles.length,
      warmupCandles,
      minSignalScore: baseConfidenceThreshold,
      totalSignals: primaryBacktest.totalSignals,
      buySignals: primaryBacktest.buySignals,
      sellSignals: primaryBacktest.sellSignals,
      wins: primaryBacktest.wins,
      losses: primaryBacktest.losses,
      winRate: primaryBacktest.winRate,
      averageReturn: primaryBacktest.averageReturn,
      cumulativeReturn: primaryBacktest.cumulativeReturn,
      maxDrawdown: primaryBacktest.maxDrawdown,
      drawdownGuard: primaryBacktest.drawdownGuardActive ? "ACTIVE" : "OK",
      bestThreshold: bestThreshold?.threshold || baseConfidenceThreshold,
      thresholdResults,
      recentTrades: primaryBacktest.trades.slice(-10).reverse()
    });

  } catch (err) {
    console.error("BACKTEST ENGINE CONTEXT ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
