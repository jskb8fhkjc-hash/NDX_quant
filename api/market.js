import { Redis } from "@upstash/redis";
import { detectRegime } from "../core/regime.js";
import { getEnsembleSignal } from "../core/strategy/aggregator.js";
import { calculateRiskSizing } from "../core/risk.js";

function uuidv4() { 
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => (c === "x" ? Math.random() * 16 | 0 : (Math.random() * 16 | 0 & 0x3 | 0x8)).toString(16)); 
}

// Fixed: Double environment variable check to automatically support Vercel Marketplace integrations
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

const TELEGRAM_COOLDOWN_MS = 1000 * 60 * 60 * 4;

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); } 
  finally { clearTimeout(id); }
}

function getCandlesFromResponse(candleData) {
  if (!candleData?.candles?.[0]?.candles) return [];
  return candleData.candles[0].candles.sort((a,b) => new Date(a.fromDate) - new Date(b.fromDate));
}

export default async function handler(req, res) {
  const instrumentId = req.query.instrumentId || "686";
  try {
    const API_KEY = process.env.ETORO_API_KEY;
    const USER_KEY = process.env.ETORO_USER_KEY;
    const BASE_URL = "https://public-api.etoro.com/api/v1";

    // 1. Fetch Market Data Streams
    const headers = { "x-api-key": API_KEY, "x-user-key": USER_KEY, "x-request-id": uuidv4() };
    const [liveRes, hourRes, fourHourRes, dayRes] = await Promise.all([
      fetchWithTimeout(`${BASE_URL}/market-data/instruments/rates?instrumentIds=${instrumentId}`, { headers }),
      fetchWithTimeout(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneHour/200`, { headers }),
      fetchWithTimeout(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/FourHours/200`, { headers }),
      fetchWithTimeout(`${BASE_URL}/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/200`, { headers })
    ]);

    const liveData = await liveRes.json();
    const ask = parseFloat(liveData.rates[0].ask);
    const bid = parseFloat(liveData.rates[0].bid);
    const currentPrice = (ask + bid) / 2;
    const spreadPercent = ((ask - bid) / currentPrice) * 100;

    const oneHour = getCandlesFromResponse(await hourRes.json());
    const fourHour = getCandlesFromResponse(await fourHourRes.json());
    const daily = getCandlesFromResponse(await dayRes.json());

    // 2. Compute Quant Mechanics via Centralized Brain
    const regimeState = detectRegime(daily);
    const ensemble = getEnsembleSignal(oneHour, fourHour, daily, regimeState);
    
    // Retrieve State Dependencies
    const positionState = (await redis.get(`position-state-${instrumentId}`)) || {};
    const backtestSummary = (await redis.get(`backtest-summary-${instrumentId}`)) || {};
    
    const amountInvested = parseFloat(positionState.amountInvested || 1000);
    const leverage = parseFloat(positionState.leverage || 1);
    const entryPrice = parseFloat(positionState.entryPrice || 0);
    const existingSL = parseFloat(positionState.existingSL || 0);
    const existingTP = parseFloat(positionState.existingTP || 0);
    
    // Risk Engine Allocation Sizing
    const riskSizing = calculateRiskSizing({
      amountInvested,
      leverage,
      currentPrice,
      atr: regimeState.metrics.atr,
      volatility: regimeState.volatility
    });

    const riskRewardRatio = (regimeState.metrics.atr * 4) / (regimeState.metrics.atr * 2);

    // Compile Warning Matrix
    const signalWarnings = [];
    if (!regimeState.tradable) signalWarnings.push(`BAD REGIME (${regimeState.regime})`);
    if (spreadPercent > 0.15) signalWarnings.push("SPREAD HIGH");

    const holding = positionState.holding === "yes" || positionState.holding === true;

    // Calculate Real-time Open PnL metrics if asset is currently held
    let pnl = "0.00";
    let exposure = "0.00";
    if (holding && entryPrice > 0) {
      exposure = (amountInvested * leverage).toFixed(2);
      const grossPnl = ((currentPrice - entryPrice) / entryPrice) * amountInvested * leverage;
      pnl = grossPnl.toFixed(2);
    }

    // 3. Persist State Changes to Redis History Cache
    const signalHistoryKey = `signal-history-${instrumentId}`;
    const logLine = `${new Date().toISOString()} | Price: ${currentPrice.toFixed(2)} | Signal: ${ensemble.signal} (Conf: ${ensemble.confidence}%) | RSI: ${ensemble.rsi.toFixed(2)}`;
    
    await redis.lpush(signalHistoryKey, logLine);
    await redis.ltrim(signalHistoryKey, 0, 19);

    const systemLog = `${new Date().toISOString()} | ANALYSIS | Instrument ${instrumentId} analyzed successfully. Signal: ${ensemble.signal}`;
    await redis.lpush("system-audit-logs", systemLog);
    await redis.ltrim("system-audit-logs", 0, 99);

    // 4. Return Data Payload Perfectly Bound to index.html UI IDs
    return res.status(200).json({
      success: true,
      instrumentId,
      price: currentPrice.toFixed(2),
      signal: ensemble.signal,
      confidence: ensemble.confidence + "%",
      rsi: ensemble.rsi.toFixed(2),
      spreadPercent: spreadPercent.toFixed(3),
      atrPercent: regimeState.metrics.atrPercent.toFixed(3),
      riskRewardRatio: riskRewardRatio.toFixed(2),
      multiTimeframeTrend: regimeState.direction,
      
      // Fixed: UI looks for 'marketRegime' property directly as a string status message
      marketRegime: `${regimeState.regime} (${regimeState.tradable ? "TRADABLE" : "BLOCKED"})`,
      
      signalQuality: signalWarnings.length ? signalWarnings.join(", ") : "OK",
      
      riskPercent: riskSizing.riskPercent,
      riskCapital: riskSizing.riskCapital.toFixed(2),
      recommendedInvestment: riskSizing.recommendedInvestment.toFixed(2),
      recommendedPositionValue: riskSizing.recommendedPositionValue.toFixed(2),
      recommendedUnits: riskSizing.recommendedUnits.toFixed(4),
      stopDistance: riskSizing.stopDistancePercent.toFixed(3) + "%",

      // Fixed: UI mappings for real-time tracking, background validation & alerts
      trailingStopAdvice: `Place Stop Loss at: ${(currentPrice - (regimeState.metrics.atr * 2)).toFixed(2)} (2x ATR)`,
      trailingStopLoss: existingSL || (currentPrice - (regimeState.metrics.atr * 2)).toFixed(2),
      drawdownGuardActive: backtestSummary?.maxDrawdownValue <= -25.0,
      backtestDrawdown: backtestSummary?.maxDrawdown || "0.00%",
      telegramCooldown: false,
      
      pnl,
      exposure,
      positionAdvice: holding ? "MONITORING POSITION" : "WAITING FOR ENTRY TRIGGER",
      holding,
      entryPrice,
      leverage,
      amountInvested,
      existingSL,
      existingTP
    });

  } catch(err) {
    console.error("MARKET API ERROR:", err);
    
    // Safely write failures back to the logging infrastructure
    try {
      const errorLog = `${new Date().toISOString()} | ERROR | ${err.message}`;
      await redis.lpush("system-audit-logs", errorLog);
      await redis.ltrim("system-audit-logs", 0, 99);
    } catch(redisErr) {}

    return res.status(500).json({ success: false, error: err.message });
  }
}
