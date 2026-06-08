import { Redis } from "@upstash/redis";
import { detectRegime } from "../core/regime.js";

function uuidv4() { 
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => (c === "x" ? Math.random() * 16 | 0 : (Math.random() * 16 | 0 & 0x3 | 0x8)).toString(16)); 
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

async function writeAudit(scope, event, details = {}) {
  const cleanDetails = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === "number" && Number.isFinite(value)
        ? Number(value.toFixed(6))
        : value
    ])
  );

  const line =
    `${new Date().toISOString()} | ${scope} | ${event} | ${JSON.stringify(cleanDetails)}`;

  await redis.lpush("system-audit-logs", line);
  await redis.ltrim("system-audit-logs", 0, 199);
}

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

function getHistoricalSignal(daily, regimeState) {
  const closes =
    daily.map(c => parseFloat(c.close));

  const currentPrice =
    closes[closes.length - 1];

  const ema20 =
    closes.slice(-20).reduce((sum, value) => sum + value, 0) /
    Math.min(20, closes.length);

  const previousPrice =
    closes[closes.length - 6] || closes[0];

  const momentumScore =
    currentPrice > ema20 && currentPrice > previousPrice
    ? 100
    : currentPrice < ema20 && currentPrice < previousPrice
    ? -100
    : 0;

  const rsi =
    getRsi(closes);

  const reversionScore =
    rsi < 30
    ? 100
    : rsi > 70
    ? -100
    : 0;

  const finalScore =
    regimeState.direction === "SIDEWAYS"
    ? (momentumScore * 0.25) + (reversionScore * 0.6)
    : (momentumScore * 0.65) + (reversionScore * 0.2);

  const confidence =
    Math.round(
      Math.min(
        100,
        50 + Math.abs(finalScore) / 2
      )
    );

  const marketIsTradable =
    regimeState.tradable !== false;

  let signal = "HOLD";

  if(
    finalScore >= 30 &&
    marketIsTradable &&
    confidence >= 55
  ){
    signal = "BUY";
  }

  if(
    finalScore <= -30 &&
    marketIsTradable &&
    confidence >= 55
  ){
    signal = "SELL";
  }

  return {
    signal,
    confidence,
    rsi,
    finalScore
  };
}

function getRsi(closes, period = 14) {
  if (closes.length < period + 1) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff =
      closes[i] - closes[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs =
    gains / losses;

  return 100 - (100 / (1 + rs));
}

function runBacktest({ candles, horizonDays, spreadPercent, minConfidenceThreshold, warmupCandles }) {
  const trades = [];
  const equityCurve = [0];
  const diagnostics = {
    evaluatedSetups: 0,
    holdSetups: 0,
    lowConfidenceSetups: 0,
    buyCandidates: 0,
    sellCandidates: 0
  };
  let cumulativeReturn = 0;

  for (let i = warmupCandles; i < candles.length - horizonDays; i++) {
    const setupCandles = candles.slice(0, i + 1);
    
    const regimeState = detectRegime(setupCandles) || { metrics: {} };
    
    const ensemble =
      getHistoricalSignal(
        setupCandles,
        regimeState
      );

    diagnostics.evaluatedSetups += 1;

    if(ensemble.signal === "BUY"){
      diagnostics.buyCandidates += 1;
    }

    if(ensemble.signal === "SELL"){
      diagnostics.sellCandidates += 1;
    }

    if (!ensemble.signal || ensemble.signal === "HOLD") {
      diagnostics.holdSetups += 1;
      continue;
    }

    if((ensemble.confidence || 0) < minConfidenceThreshold) {
      diagnostics.lowConfidenceSetups += 1;
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
    diagnostics,
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

    await writeAudit("BACKTEST", "REQUEST START", {
      instrumentId,
      horizonDays,
      spreadPercent,
      thresholds: SCORE_THRESHOLDS
    });

    // Robust candle fetch with cache fallback and validation
    const candleUrl = `https://public-api.etoro.com/api/v1/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/1000`;

    const candleResponse = await fetchWithTimeout(
      candleUrl,
      { headers: { "x-api-key": API_KEY, "x-user-key": USER_KEY, "x-request-id": uuidv4() } }
    );

    let candleJson;
    let candleSource = "etoro";

    if (!candleResponse || !candleResponse.ok) {
      console.error(`eToro Candles API failed: Status=${candleResponse?.status}. Attempting to use cached candles.`);
      await writeAudit("BACKTEST", "ETORO CANDLE FETCH FAILED", {
        status: candleResponse?.status || "no response",
        usingCache: true
      });
      const cached = await redis.get(`cached-candles-${instrumentId}`);
      if (cached) {
        try {
          candleJson = JSON.parse(cached);
          candleSource = "redis-cache";
        } catch (e) {
          console.error('Failed to parse cached candles from Redis:', e.message);
          throw new Error('Failed to retrieve valid candle data from eToro and cache.');
        }
      } else {
        throw new Error(`eToro Candles API rejected request (Status: ${candleResponse?.status || 'no response'})`);
      }
    } else {
      await writeAudit("BACKTEST", "ETORO CANDLE FETCH OK", {
        status: candleResponse.status
      });
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
          try {
            candleJson = JSON.parse(cached);
            candleSource = "redis-cache";
          }
          catch (pe) { console.error('Failed to parse cached candles after JSON error:', pe.message); throw new Error('Malformed candle JSON from eToro and cache fallback failed.'); }
        } else {
          throw new Error('Malformed candle JSON from eToro and no cache available.');
        }
      }
    }

    const candles = getCandlesFromResponse(candleJson);
    const minimumCandles = 100 + horizonDays;
    const marketDataStatus = {
      candlesReceived: candles.length,
      firstCandleDate: candles[0]?.fromDate || null,
      lastCandleDate: candles[candles.length - 1]?.fromDate || null,
      firstClose: candles[0]?.close ?? null,
      lastClose: candles[candles.length - 1]?.close ?? null,
      source: candleSource
    };

    await writeAudit("BACKTEST", "MARKET DATA PARSED", marketDataStatus);

    if (candles.length < minimumCandles) {
      await writeAudit("BACKTEST", "STOP INSUFFICIENT DATA", {
        candlesReceived: candles.length,
        minimumCandles
      });
      return res.status(200).json({ 
        success: true, 
        instrumentId, 
        horizonDays, 
        candlesTested: candles.length,
        marketDataStatus,
        warmupCandles: 0,
        minSignalScore: 0,
        totalSignals: 0, 
        buySignals: 0,
        sellSignals: 0,
        wins: 0,
        losses: 0,
        winRate: "0.0%", 
        averageReturn: "0.00%",
        cumulativeReturn: "0.00%", 
        maxDrawdown: "0.00%", 
        drawdownGuard: "OK",
        bestThreshold: "--",
        thresholdResults: [], 
        diagnostics: {
          evaluatedSetups: 0,
          holdSetups: 0,
          lowConfidenceSetups: 0,
          buyCandidates: 0,
          sellCandidates: 0
        },
        recentTrades: [],
        dataWarning: `Insufficient historical data: ${candles.length} candles received, minimum ${minimumCandles} required for backtesting`
      });
    }

    const warmupCandles = 100; 
    const baseConfidenceThreshold = 60;

    await writeAudit("BACKTEST", "TECHNICAL INPUT", {
      candles: candles.length,
      warmupCandles,
      horizonDays,
      baseConfidenceThreshold,
      spreadPercent,
      firstDate: marketDataStatus.firstCandleDate,
      lastDate: marketDataStatus.lastCandleDate
    });

    const primaryBacktest = runBacktest({ candles, horizonDays, spreadPercent, minConfidenceThreshold: baseConfidenceThreshold, warmupCandles });

    await writeAudit("BACKTEST", "PRIMARY RESULT", {
      totalSignals: primaryBacktest.totalSignals,
      buySignals: primaryBacktest.buySignals,
      sellSignals: primaryBacktest.sellSignals,
      winRate: primaryBacktest.winRate,
      averageReturn: primaryBacktest.averageReturn,
      cumulativeReturn: primaryBacktest.cumulativeReturn,
      maxDrawdown: primaryBacktest.maxDrawdown,
      diagnostics: primaryBacktest.diagnostics
    });

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

    await writeAudit("BACKTEST", "THRESHOLD RESULTS", {
      thresholds: thresholdResults
    });

    const bestThreshold = thresholdResults.filter(r => !r.drawdownGuardActive).sort((a,b)=> parseFloat(b.averageReturn) - parseFloat(a.averageReturn))[0] || thresholdResults.sort((a,b)=> parseFloat(b.averageReturn) - parseFloat(a.averageReturn))[0];

    await redis.set(`backtest-summary-${instrumentId}`, {
      instrumentId, horizonDays, totalSignals: primaryBacktest.totalSignals, winRate: primaryBacktest.winRate, cumulativeReturn: primaryBacktest.cumulativeReturn, maxDrawdown: primaryBacktest.maxDrawdown, bestThreshold: bestThreshold?.threshold || baseConfidenceThreshold
    });

    await writeAudit("BACKTEST", "SUMMARY STORED", {
      instrumentId,
      totalSignals: primaryBacktest.totalSignals,
      maxDrawdown: primaryBacktest.maxDrawdown,
      bestThreshold: bestThreshold?.threshold || baseConfidenceThreshold
    });

    return res.status(200).json({
      success: true,
      instrumentId,
      horizonDays,
      candlesTested: candles.length,
      marketDataStatus,
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
      diagnostics: primaryBacktest.diagnostics,
      recentTrades: primaryBacktest.trades.slice(-10).reverse()
    });

  } catch (err) {
    console.error("BACKTEST ENGINE CONTEXT ERROR:", err);
    try {
      await writeAudit("BACKTEST", "ERROR", {
        error: err.message
      });
    } catch(e) {}
    return res.status(500).json({ success: false, error: err.message });
  }
}
