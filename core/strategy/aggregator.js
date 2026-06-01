import { RSI, EMA } from "../indicators.js";

export function getEnsembleSignal(oneHour, fourHour, daily, regime) {
  const dCloses = daily.map(c => parseFloat(c.close));
  const currentPrice = dCloses[dCloses.length - 1];
  const rsi = RSI(dCloses, 14);

  // 1. Momentum Model
  const isDailyBull = currentPrice > EMA(dCloses.slice(-20), 20);
  
  // Fallback smoothly if intraday (fourHour) streams aren't provided (like in backtesting)
  const is4hBull = (fourHour && fourHour.length)
    ? parseFloat(fourHour[fourHour.length - 1].close) > EMA(fourHour.map(c => parseFloat(c.close)).slice(-20), 20)
    : currentPrice > EMA(dCloses.slice(-10), 10); // Backtest historical proxy
    
  let momentumScore = 0;
  if (isDailyBull && is4hBull) momentumScore = 100;
  if (!isDailyBull && !is4hBull) momentumScore = -100;

  // 2. Mean Reversion Model
  let reversionScore = 0;
  if (rsi < 35) reversionScore = 100; // Oversold -> Buy pressure
  if (rsi > 65) reversionScore = -100; // Overbought -> Sell pressure

  // 3. Dynamic Weighting based on current regime
  let finalScore = 0;
  if (regime.direction === "SIDEWAYS") {
    finalScore = (momentumScore * 0.2) + (reversionScore * 0.8);
  } else {
    finalScore = (momentumScore * 0.8) + (reversionScore * 0.2); // Follow trend
  }

  let signal = "HOLD";
  let confidence = 50;

  if (finalScore >= 40 && regime.tradable) {
    signal = "BUY";
    confidence = Math.min(100, 50 + (finalScore / 2));
  } else if (finalScore <= -40 && regime.tradable) {
    signal = "SELL";
    confidence = Math.min(100, 50 + (Math.abs(finalScore) / 2));
  }

  return { signal, confidence: Math.round(confidence), rsi };
}
