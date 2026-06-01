import { RSI, EMA } from "../indicators.js";

export function getEnsembleSignal(oneHour, fourHour, daily, regime) {
  const dCloses = daily.map(c => parseFloat(c.close));
  const currentPrice = dCloses[dCloses.length - 1];
  const rsi = RSI(dCloses, 14);

  const isDailyBull = currentPrice > EMA(dCloses.slice(-20), 20);
  const is4hBull = (fourHour && fourHour.length)
    ? parseFloat(fourHour[fourHour.length - 1].close) > EMA(fourHour.map(c => parseFloat(c.close)).slice(-20), 20)
    : currentPrice > EMA(dCloses.slice(-10), 10);
    
  let momentumScore = 0;
  if (isDailyBull && is4hBull) momentumScore = 100;
  if (!isDailyBull && !is4hBull) momentumScore = -100;

  let reversionScore = 0;
  if (rsi < 30) reversionScore = 100;
  if (rsi > 70) reversionScore = -100;

  let finalScore = regime.direction === "SIDEWAYS" 
    ? (momentumScore * 0.3) + (reversionScore * 0.7) 
    : (momentumScore * 0.7) + (reversionScore * 0.3);

  let signal = "HOLD";
  let confidence = 50 + (Math.abs(finalScore) / 2);

  if (finalScore >= 35 && regime.tradable) signal = "BUY";
  else if (finalScore <= -35 && regime.tradable) signal = "SELL";

  return { signal, confidence: Math.round(confidence), rsi };
}
