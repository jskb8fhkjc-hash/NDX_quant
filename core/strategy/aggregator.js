import { RSI, EMA } from "../indicators.js";
import { fetchLatestNews } from "./newsIntegration.js";
import { getEconomicImpact, shouldReduceExposure } from "./economicCalendar.js";

export async function getEnsembleSignal(oneHour, fourHour, daily, regime, instrumentId, symbol) {
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

  // Fetch news sentiment (weighted at 15%)
  let newsScore = 0;
  let newsSentiment = { sentimentScore: 0, newsCount: 0, recentNews: [] };
  try {
    newsSentiment = await fetchLatestNews(symbol);
    // Cap sentiment score influence to prevent extreme swings
    newsScore = (newsSentiment.sentimentScore / 100) * 15;
  } catch (err) {
    console.error("Failed to fetch news sentiment:", err);
  }

  // Fetch economic calendar data (weighted at 20%)
  let economicScore = 0;
  let economicData = { hasHighImpactEvent: false, impact: "NORMAL", riskLevel: "LOW", events: [] };
  try {
    economicData = await getEconomicImpact();
    
    // Penalize signals during high-impact economic events
    if (economicData.riskLevel === "CRITICAL") economicScore = -25; // Strong caution
    else if (economicData.riskLevel === "HIGH") economicScore = -15; // Moderate caution
    else if (economicData.riskLevel === "LOW") economicScore = 0; // No penalty
  } catch (err) {
    console.error("Failed to fetch economic data:", err);
  }

  // Combine all scores with appropriate weights
  let finalScore = regime.direction === "SIDEWAYS" 
    ? (momentumScore * 0.25) + (reversionScore * 0.6) + newsScore + economicScore * 0.15
    : (momentumScore * 0.65) + (reversionScore * 0.2) + newsScore + economicScore * 0.15;

  let signal = "HOLD";
  let confidence = 50 + (Math.abs(finalScore) / 2);

  // Adjust confidence based on economic events
  if (economicData.hasHighImpactEvent) confidence *= 0.7; // Reduce confidence by 30% during events

  return { signal, confidence, finalScore, newsSummary: newsSentiment.recentNews };
}