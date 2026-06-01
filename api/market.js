import { Redis } from "@upstash/redis";
import { detectRegime } from "../core/regime.js";
import { getEnsembleSignal } from "../core/strategy/aggregator.js";
import { calculateRiskSizing } from "../core/risk.js";

function uuidv4() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => (c === "x" ? Math.random() * 16 | 0 : (Math.random() * 16 | 0 & 0x3 | 0x8)).toString(16)); }

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

function getCandlesFromResponse(candleData) {
  if (!candleData?.candles?.[0]?.candles) return [];
  return candleData.candles[0].candles.sort((a,b) => new Date(a.fromDate) - new Date(b.fromDate));
}

export default async function handler(req, res) {
  const instrumentId = req.query.instrumentId || "686";
  const symbol = req.query.symbol || "NDX";
  try {
    const API_KEY = process.env.ETORO_API_KEY;
    const USER_KEY = process.env.ETORO_USER_KEY;
    const BASE_URL = "https://public-api.etoro.com/api/v1";

    const headers = { "x-api-key": API_KEY, "x-user-key": USER_KEY, "x-request-id": uuidv4() };
    const [liveRes, hourRes, fourHourRes, dayRes] = await Promise.all([
      fetch(`${BASE_URL}/market-data/instruments/rates?instrumentIds=${instrumentId}`, { headers }),
      fetch(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneHour/200`, { headers }),
      fetch(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/FourHours/200`, { headers }),
      fetch(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/200`, { headers })
    ]);

    const liveData = await liveRes.json();
    const currentPrice = parseFloat(liveData.rates[0].lastExecution);
    const ask = parseFloat(liveData.rates[0].ask);
    const bid = parseFloat(liveData.rates[0].bid);
    const spreadPercent = ((ask - bid) / currentPrice) * 100;

    const oneHour = getCandlesFromResponse(await hourRes.json());
    const fourHour = getCandlesFromResponse(await fourHourRes.json());
    const daily = getCandlesFromResponse(await dayRes.json());

    const regimeState = detectRegime(daily);
    const ensemble = await getEnsembleSignal(oneHour, fourHour, daily, regimeState, instrumentId, symbol);
    
    const positionState = (await redis.get(`position-state-${instrumentId}`)) || {};
    const backtestSummary = (await redis.get(`backtest-summary-${instrumentId}`)) || {};
    
    const amountInvested = parseFloat(positionState.amountInvested || req.query.amountInvested || 1000);
    const leverage = parseFloat(positionState.leverage || req.query.leverage || 1);
    const entryPrice = parseFloat(positionState.entryPrice || req.query.entryPrice || 0);

    const riskSizing = calculateRiskSizing({
      amountInvested, leverage, currentPrice, atr: regimeState.metrics.atr, volatility: regimeState.volatility
    });

    const stopLoss = ensemble.signal === "SELL" ? currentPrice + (regimeState.metrics.atr * 1.5) : currentPrice - (regimeState.metrics.atr * 1.5);
    const takeProfit = ensemble.signal === "SELL" ? currentPrice - (regimeState.metrics.atr * 3) : currentPrice + (regimeState.metrics.atr * 3);

    const holding = req.query.holding === "yes" || positionState.holding === "yes";
    let pnl = "--"; let exposure = "--";
    if (holding && entryPrice > 0) {
      exposure = (amountInvested * leverage).toFixed(2);
      pnl = (((currentPrice - entryPrice) / entryPrice) * amountInvested * leverage).toFixed(2);
    }

    // Adjust position size if high economic risk
    let adjustedExposure = exposure;
    if (ensemble.shouldReduceExposure && holding) {
      adjustedExposure = (parseFloat(exposure) * 0.7).toFixed(2); // Reduce by 30%
    }

    const outputPayload = {
      signal: ensemble.signal,
      confidence: ensemble.confidence + "%",
      signalScore: ensemble.confidence + "/100",
      duration: regimeState.volatility === "EXTREME" ? "INTRADAY" : "SWING",
      shortTrend: regimeState.direction,
      midTrend: regimeState.direction,
      longTrend: regimeState.direction,
      oneHourTrend: oneHour.length ? "PARSED" : "--",
      fourHourTrend: fourHour.length ? "PARSED" : "--",
      oneDayTrend: daily.length ? "PARSED" : "--",
      multiTimeframeTrend: regimeState.direction,
      marketRegime: regimeState.regime,
      trendStrength: regimeState.trendStrengthPercent.toFixed(2) + "%",
      price: currentPrice.toFixed(2),
      ask: ask.toFixed(2),
      bid: bid.toFixed(2),
      spread: (ask - bid).toFixed(4),
      spreadPercent: spreadPercent.toFixed(3) + "%",
      ema20: regimeState.metrics.ema20.toFixed(2),
      ema50: regimeState.metrics.ema50.toFixed(2),
      ema100: regimeState.metrics.ema100.toFixed(2),
      rsi: ensemble.rsi.toFixed(2),
      atr: regimeState.metrics.atr.toFixed(2),
      atrPercent: regimeState.metrics.atrPercent.toFixed(3) + "%",
      entry: currentPrice.toFixed(2),
      tradePlanDirection: holding ? (ensemble.signal === "SELL" ? "EXIT" : "HOLD") : ensemble.signal,
      stopLoss: stopLoss.toFixed(2),
      takeProfit: takeProfit.toFixed(2),
      trailingStopLoss: (currentPrice - (regimeState.metrics.atr * 2)).toFixed(2),
      trailingStopAdvice: holding ? "ACTIVE" : "NO POSITION",
      riskScore: "45/100",
      riskRewardRatio: "2.00",
      riskPerTrade: riskSizing.riskPercent.toFixed(2) + "%",
      recommendedRiskAmount: riskSizing.riskCapital.toFixed(2),
      recommendedInvestment: riskSizing.recommendedInvestment.toFixed(2),
      recommendedPositionValue: riskSizing.recommendedPositionValue.toFixed(2),
      recommendedUnits: riskSizing.recommendedUnits.toFixed(4),
      stopDistance: riskSizing.stopDistancePercent.toFixed(3) + "%",
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
      // NEW: Sentiment & Economic Risk Analysis
      newsSentiment: ensemble.newsSentiment.toFixed(2),
      newsCount: ensemble.newsCount,
      economicRiskLevel: ensemble.economicRiskLevel,
      hasUpcomingEconomicEvent: ensemble.hasUpcomingEvent,
      upcomingEconomicEvents: ensemble.upcomingEvents,
      shouldReduceExposure: ensemble.shouldReduceExposure,
      finalScore: ensemble.finalScore,
      scoreBreakdown: ensemble.scores
    };

    await redis.lpush("system-audit-logs", `${new Date().toISOString()} | UI SYNC | ${symbol} | Signal: ${ensemble.signal} | Confidence: ${ensemble.confidence}% | News Sentiment: ${ensemble.newsSentiment.toFixed(2)} | Economic Risk: ${ensemble.economicRiskLevel}`);
    return res.status(200).json(outputPayload);
  } catch (err) {
    console.error("Market API error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
