import { EMA, ADX, ATR } from "./indicators.js";

const ADX_TREND_THRESHOLD = 25;
const HIGH_VOLATILITY_ATR_PERCENT = 3.5; 
const EXTREME_VOLATILITY_ATR_PERCENT = 5.5;

export function detectRegime(candles) {
  if (candles.length < 100) return { regime: "UNKNOWN", tradable: false, atr: 0 };

  const closes = candles.map(c => parseFloat(c.close));
  const currentPrice = closes[closes.length - 1];
  
  const ema20 = EMA(closes.slice(-20), 20);
  const ema50 = EMA(closes.slice(-50), 50);
  const ema100 = EMA(closes.slice(-100), 100);
  
  const adxScore = ADX(candles, 14).adx;
  const atr = ATR(candles, 14);
  const atrPercent = (atr / currentPrice) * 100;

  // 1. Map Volatility
  let volatility = "QUIET";
  if (atrPercent > EXTREME_VOLATILITY_ATR_PERCENT) volatility = "EXTREME";
  else if (atrPercent > HIGH_VOLATILITY_ATR_PERCENT) volatility = "EXPANDING";

  // 2. Map Direction
  let direction = "SIDEWAYS";
  if (adxScore > ADX_TREND_THRESHOLD) {
    if (ema20 > ema50 && ema50 > ema100 && currentPrice > ema20) direction = "BULLISH";
    if (ema20 < ema50 && ema50 < ema100 && currentPrice < ema20) direction = "BEARISH";
  }

  // 3. Define Tradability (Block extreme chop)
  const tradable = volatility !== "EXTREME" && !(direction === "SIDEWAYS" && volatility === "EXPANDING");

  return {
    regime: `${volatility} ${direction}`,
    direction,
    volatility,
    tradable,
    metrics: { atr, atrPercent, adx: adxScore }
  };
}
