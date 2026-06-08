import { Redis } from "@upstash/redis";
import { detectRegime } from "../core/regime.js";
import { getEnsembleSignal } from "../core/strategy/aggregator.js";
import { calculateRiskSizing } from "../core/risk.js";

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

function getCandlesFromResponse(candleData) {
  if (!candleData?.candles?.[0]?.candles) return [];
  return candleData.candles[0].candles.sort((a,b) => new Date(a.fromDate) - new Date(b.fromDate));
}

export default async function handler(req, res) {
  // Safe fallback configurations
  const instrumentId = req.query.instrumentId || "28";
  const symbol = req.query.symbol || `ID:${instrumentId}`; // Fallback if symbol is omitted in URL

  try {
    // FIX 1: Explicitly trim environment values to stop header pattern crashes
    const API_KEY = (process.env.ETORO_API_KEY || "").trim();
    const USER_KEY = (process.env.ETORO_USER_KEY || "").trim();
    const BASE_URL = "https://public-api.etoro.com/api/v1";

    if (!API_KEY || !USER_KEY) {
      throw new Error("Missing eToro API credentials in environment configuration.");
    }

    await writeAudit("MARKET", "REQUEST START", {
      instrumentId,
      symbol,
      holding: req.query.holding || "from-saved-position",
      amountInvested: req.query.amountInvested || "from-saved-position"
    });

    // Only supply instrumentId parameter inside the active eToro execution array URLs
    const headers = { "x-api-key": API_KEY, "x-user-key": USER_KEY, "x-request-id": uuidv4() };
    const [liveRes, hourRes, fourHourRes, dayRes] = await Promise.all([
      fetch(`${BASE_URL}/market-data/instruments/rates?instrumentIds=${instrumentId}`, { headers }),
      fetch(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneHour/200`, { headers }),
      fetch(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/FourHours/200`, { headers }),
      fetch(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/200`, { headers })
    ]);

    await writeAudit("MARKET", "ETORO FETCH RESULT", {
      ratesStatus: liveRes.status,
      oneHourStatus: hourRes.status,
      fourHourStatus: fourHourRes.status,
      oneDayStatus: dayRes.status
    });

    if (!liveRes.ok) throw new Error(`eToro Rates API rejected request (Status: ${liveRes.status})`);
    if (!dayRes.ok) throw new Error(`eToro Candles API rejected request (Status: ${dayRes.status})`);

    const liveData = await liveRes.json();
    if (!liveData?.rates?.[0]) throw new Error("Malformed raw live rates object received from eToro.");

    const currentPrice = parseFloat(liveData.rates[0].lastExecution);
    const ask = parseFloat(liveData.rates[0].ask);
    const bid = parseFloat(liveData.rates[0].bid);
    const spreadPercent = currentPrice > 0 ? (((ask - bid) / currentPrice) * 100) : 0;

    const oneHour = getCandlesFromResponse(await hourRes.json());
    const fourHour = getCandlesFromResponse(await fourHourRes.json());
    const daily = getCandlesFromResponse(await dayRes.json());

    await writeAudit("MARKET", "MARKET DATA PARSED", {
      price: currentPrice,
      ask,
      bid,
      spreadPercent,
      oneHourCandles: oneHour.length,
      fourHourCandles: fourHour.length,
      dailyCandles: daily.length,
      firstDailyCandle: daily[0]?.fromDate || null,
      lastDailyCandle: daily[daily.length - 1]?.fromDate || null
    });

    const regimeState = detectRegime(daily) || { metrics: {}, volatility: "NORMAL", direction: "MIXED", regime: "UNKNOWN", trendStrengthPercent: 0, tradable: true };

    await writeAudit("TECHNICAL", "REGIME ANALYSIS", {
      regime: regimeState.regime,
      direction: regimeState.direction,
      volatility: regimeState.volatility,
      tradable: regimeState.tradable,
      trendStrengthPercent: regimeState.trendStrengthPercent || 0,
      ema20: regimeState.metrics?.ema20 || 0,
      ema50: regimeState.metrics?.ema50 || 0,
      ema100: regimeState.metrics?.ema100 || 0,
      atr: regimeState.metrics?.atr || 0,
      atrPercent: regimeState.metrics?.atrPercent || 0,
      adx: regimeState.metrics?.adx || 0
    });

    const ensemble = await getEnsembleSignal(oneHour, fourHour, daily, regimeState, instrumentId, symbol);

    await writeAudit("SIGNAL", "ENSEMBLE RESULT", {
      signal: ensemble.signal || "HOLD",
      confidence: ensemble.confidence || 0,
      finalScore: ensemble.finalScore || 0,
      rsi: ensemble.rsi || 0,
      newsSentiment: ensemble.newsSentiment || 0,
      newsCount: ensemble.newsCount || 0,
      economicRiskLevel: ensemble.economicRiskLevel || "LOW",
      scoreBreakdown: ensemble.scores || {}
    });
    
    const positionState = (await redis.get(`position-state-${instrumentId}`)) || {};
    const backtestSummary = (await redis.get(`backtest-summary-${instrumentId}`)) || {};
    
    const amountInvested = parseFloat(positionState.amountInvested || req.query.amountInvested || 1000);
    const leverage = parseFloat(positionState.leverage || req.query.leverage || 1);
    const entryPrice = parseFloat(positionState.entryPrice || req.query.entryPrice || 0);

    const riskSizing = calculateRiskSizing({
      amountInvested, leverage, currentPrice, atr: regimeState.metrics?.atr || 0, volatility: regimeState.volatility
    }) || { riskPercent: 0, riskCapital: 0, recommendedInvestment: 0, recommendedPositionValue: 0, recommendedUnits: 0, stopDistancePercent: 0 };

    await writeAudit("RISK", "RISK SIZING", {
      amountInvested,
      leverage,
      riskPercent: riskSizing.riskPercent || 0,
      riskCapital: riskSizing.riskCapital || 0,
      recommendedInvestment: riskSizing.recommendedInvestment || 0,
      recommendedPositionValue: riskSizing.recommendedPositionValue || 0,
      recommendedUnits: riskSizing.recommendedUnits || 0,
      stopDistancePercent: riskSizing.stopDistancePercent || 0,
      backtestMaxDrawdown: backtestSummary?.maxDrawdown || "none"
    });

    const atrValue = regimeState.metrics?.atr || 0;
    const stopLoss = ensemble.signal === "SELL" ? currentPrice + (atrValue * 1.5) : currentPrice - (atrValue * 1.5);
    const takeProfit = ensemble.signal === "SELL" ? currentPrice - (atrValue * 3) : currentPrice + (atrValue * 3);

    const holding = req.query.holding === "yes" || positionState.holding === "yes";
    let pnl = "--"; let exposure = "--";
    if (holding && entryPrice > 0) {
      exposure = (amountInvested * leverage).toFixed(2);
      pnl = (((currentPrice - entryPrice) / entryPrice) * amountInvested * leverage).toFixed(2);
    }

    let adjustedExposure = exposure;
    if (ensemble.shouldReduceExposure && holding && exposure !== "--") {
      adjustedExposure = (parseFloat(exposure) * 0.7).toFixed(2);
    }

    // Safely structure output payload with type fallbacks for .toFixed() safety
    const outputPayload = {
      signal: ensemble.signal || "HOLD",
      confidence: (ensemble.confidence || 0) + "%",
      signalScore: (ensemble.confidence || 0) + "/100",
      duration: regimeState.volatility === "EXTREME" ? "INTRADAY" : "SWING",
      shortTrend: regimeState.direction || "MIXED",
      midTrend: regimeState.direction || "MIXED",
      longTrend: regimeState.direction || "MIXED",
      oneHourTrend: oneHour.length ? "PARSED" : "--",
      fourHourTrend: fourHour.length ? "PARSED" : "--",
      oneDayTrend: daily.length ? "PARSED" : "--",
      multiTimeframeTrend: regimeState.direction || "MIXED",
      marketRegime: regimeState.regime || "UNKNOWN",
      trendStrength: (regimeState.trendStrengthPercent || 0).toFixed(2) + "%",
      price: currentPrice.toFixed(2),
      ask: ask.toFixed(2),
      bid: bid.toFixed(2),
      spread: (ask - bid).toFixed(4),
      spreadPercent: spreadPercent.toFixed(3) + "%",
      ema20: typeof regimeState.metrics?.ema20 === "number" ? regimeState.metrics.ema20.toFixed(2) : "--",
      ema50: typeof regimeState.metrics?.ema50 === "number" ? regimeState.metrics.ema50.toFixed(2) : "--",
      ema100: typeof regimeState.metrics?.ema100 === "number" ? regimeState.metrics.ema100.toFixed(2) : "--",
      rsi: typeof ensemble.rsi === "number" ? ensemble.rsi.toFixed(2) : "--",
      atr: atrValue.toFixed(2),
      atrPercent: typeof regimeState.metrics?.atrPercent === "number" ? regimeState.metrics.atrPercent.toFixed(3) + "%" : "--",
      entry: currentPrice.toFixed(2),
      tradePlanDirection: holding ? (ensemble.signal === "SELL" ? "EXIT" : "HOLD") : (ensemble.signal || "HOLD"),
      stopLoss: stopLoss.toFixed(2),
      takeProfit: takeProfit.toFixed(2),
      trailingStopLoss: (currentPrice - (atrValue * 2)).toFixed(2),
      trailingStopAdvice: holding ? "ACTIVE" : "NO POSITION",
      riskScore: "45/100",
      riskRewardRatio: "2.00",
      riskPerTrade: (riskSizing.riskPercent || 0).toFixed(2) + "%",
      recommendedRiskAmount: (riskSizing.riskCapital || 0).toFixed(2),
      recommendedInvestment: (riskSizing.recommendedInvestment || 0).toFixed(2),
      recommendedPositionValue: (riskSizing.recommendedPositionValue || 0).toFixed(2),
      recommendedUnits: (riskSizing.recommendedUnits || 0).toFixed(4),
      stopDistance: (riskSizing.stopDistancePercent || 0).toFixed(3) + "%",
      drawdownGuard: backtestSummary?.maxDrawdownValue <= -25.0 ? "ACTIVE" : "OK",
      backtestDrawdown: backtestSummary?.maxDrawdown || "0.00%",
      signalQuality: regimeState.tradable ? "OK" : "HIGH VOLATILITY",
      pnl,
      exposure: adjustedExposure,
      positionAdvice: holding ? "HOLD" : "WAITING",
      holding,
      entryPrice,
      leverage,
      amountInvested,
      newsSentiment: typeof ensemble.newsSentiment === "number" ? ensemble.newsSentiment.toFixed(2) : "0.00",
      newsCount: ensemble.newsCount || 0,
      economicRiskLevel: ensemble.economicRiskLevel || "LOW",
      hasUpcomingEconomicEvent: !!ensemble.hasUpcomingEvent,
      upcomingEconomicEvents: ensemble.upcomingEvents || [],
      shouldReduceExposure: !!ensemble.shouldReduceExposure,
      finalScore: ensemble.finalScore || 0,
      scoreBreakdown: ensemble.scores || {}
    };

    // FIX 2: Build a fully validated JSON row string for signal history array
    const historyEntry = {
      time: new Date().toISOString().substring(0, 19).replace("T", " "),
      signal: ensemble.signal || "HOLD",
      price: currentPrice.toFixed(2),
      rsi: typeof ensemble.rsi === "number" ? ensemble.rsi.toFixed(2) : "--",
      multiTimeframeTrend: regimeState.direction || "MIXED",
      riskRewardRatio: "2.00",
      trailingStopLoss: (currentPrice - (atrValue * 2)).toFixed(2),
      warnings: ensemble.shouldReduceExposure ? ["High Economic Risk Exposure"] : []
    };
    
    await redis.lpush(`signal-history-${instrumentId}`, JSON.stringify(historyEntry));
    await redis.ltrim(`signal-history-${instrumentId}`, 0, 19);
    
    // FIX 3: Sanitized string template ensuring missing symbols never throw execution crashes
    await redis.lpush("system-audit-logs", `${new Date().toISOString()} | UI SYNC | ${symbol} (ID:${instrumentId}) | Signal: ${ensemble.signal || "HOLD"} | Confidence: ${ensemble.confidence || 0}% | News Sentiment: ${typeof ensemble.newsSentiment === "number" ? ensemble.newsSentiment.toFixed(2) : "0.00"} | Economic Risk: ${ensemble.economicRiskLevel || "LOW"}`);
    await redis.ltrim("system-audit-logs", 0, 199);
    await writeAudit("MARKET", "RESPONSE READY", {
      signal: outputPayload.signal,
      confidence: outputPayload.confidence,
      signalQuality: outputPayload.signalQuality,
      positionAdvice: outputPayload.positionAdvice,
      exposure: outputPayload.exposure,
      pnl: outputPayload.pnl
    });
    
    return res.status(200).json(outputPayload);
  } catch (err) {
    console.error("Market API error:", err);
    try {
      await writeAudit("MARKET", "ERROR", {
        instrumentId,
        symbol,
        error: err.message
      });
    } catch(e) {}
    return res.status(500).json({ success: false, error: err.message });
  }
}
