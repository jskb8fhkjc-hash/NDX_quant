import { EMA, ADX, ATR } from "./indicators.js";

export function detectRegime(candles) {
  if (!candles || candles.length < 60) {
    return { regime: "SIDEWAYS", direction: "MIXED", volatility: "QUIET", tradable: true, metrics: { atr: 0, atrPercent: 0, adx: 0 } };
  }
  const closes = candles.map(c => parseFloat(c.close));
  const currentPrice = closes[closes.length - 1];
  
  const ema20 = EMA(closes.slice(-20), 20);
  const ema50 = EMA(closes.slice(-50), 50);
  const ema100 = closes.length >= 100 ? EMA(closes.slice(-100), 100) : ema50;
  
  const adxScore = ADX(candles, 14).adx;
  const atr = ATR(candles, 14);
  const atrPercent = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

  let volatility = "QUIET";
  if (atrPercent > 4.5) volatility = "EXTREME";
  else if (atrPercent > 2.5) volatility = "EXPANDING";

  let direction = "SIDEWAYS";
  if (currentPrice > ema20 && ema20 > ema50) direction = "BULLISH";
  else if (currentPrice < ema20 && ema20 < ema50) direction = "BEARISH";

  const trendStrengthPercent = currentPrice > 0 ? (Math.abs(ema20 - ema50) / currentPrice) * 100 : 0;
  const tradable = volatility !== "EXTREME";

  return {
    regime: `${volatility} ${direction}`,
    direction,
    volatility,
    tradable,
    trendStrengthPercent,
    metrics: { atr, atrPercent, adx: adxScore, ema20, ema50, ema100 }
  };
}
