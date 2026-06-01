import { Redis } from "@upstash/redis";
import { detectRegime } from "../core/regime.js";
import { getEnsembleSignal } from "../core/strategy/aggregator.js";
import { calculateRiskSizing } from "../core/risk.js";

function uuidv4() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => (c === "x" ? Math.random() * 16 | 0 : (Math.random() * 16 | 0 & 0x3 | 0x8)).toString(16)); }
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
  try {
    const API_KEY = process.env.ETORO_API_KEY;
    const USER_KEY = process.env.ETORO_USER_KEY;
    const instrumentId = req.query.instrumentId || "686";
    const BASE_URL = "https://public-api.etoro.com/api/v1";

    // 1. Fetch Market Data
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

    // 2. Core Execution Pipeline
    const regimeState = detectRegime(daily);
    const ensemble = getEnsembleSignal(oneHour, fourHour, daily, regimeState);
    
    // Retrieve User Portfolio State
    const positionState = (await redis.get(`position-state-${instrumentId}`)) || {};
    const amountInvested = parseFloat(positionState.amountInvested || 1000);
    const leverage = parseFloat(positionState.leverage || 1);
    
    // Phase 3 Sizing
    const riskSizing = calculateRiskSizing({
      amountInvested,
      leverage,
      currentPrice,
      atr: regimeState.metrics.atr,
      volatility: regimeState.volatility
    });

    const riskRewardRatio = (regimeState.metrics.atr * 4) / (regimeState.metrics.atr * 2); // 1:2 Target Default

    // 3. Compile Alerts
    const signalWarnings = [];
    if (!regimeState.tradable) signalWarnings.push(`REGIME (${regimeState.regime})`);
    if (spreadPercent > 0.15) signalWarnings.push("SPREAD HIGH");

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
      marketRegime: { regime: regimeState.regime, tradable: regimeState.tradable },
      signalQuality: signalWarnings.length ? signalWarnings.join(", ") : "OK",
      
      riskPercent: riskSizing.riskPercent,
      riskCapital: riskSizing.riskCapital.toFixed(2),
      recommendedInvestment: riskSizing.recommendedInvestment.toFixed(2),
      recommendedPositionValue: riskSizing.recommendedPositionValue.toFixed(2),
      recommendedUnits: riskSizing.recommendedUnits.toFixed(4),
      stopDistance: riskSizing.stopDistancePercent.toFixed(3) + "%",

      trailingStopAdvice: "CALCULATED OFFLINE", // Can be re-implemented via Upstash state tracking
      holding: positionState.holding === "yes",
      entryPrice: positionState.entryPrice || 0,
      leverage,
      amountInvested
    });

  } catch(err) {
    console.error("MARKET PIPELINE ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
