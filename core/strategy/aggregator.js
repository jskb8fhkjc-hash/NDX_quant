import { RSI, EMA } from "../indicators.js";
import { getNewsSentiment } from "./newsSentiment.js";
import { getEconomicImpact, shouldReduceExposure } from "./economicCalendar.js";

export async function getEnsembleSignal(oneHour, fourHour, daily, regime, instrumentId, symbol) {
  if (!daily || daily.length === 0) {
    return { signal: "HOLD", confidence: 50, rsi: 50, newsSentiment: 0, newsCount: 0, economicRiskLevel: "LOW", hasUpcomingEvent: false, shouldReduceExposure: false, upcomingEvents: [], finalScore: "0.00", scores: {} };
  }

  const dCloses = daily.map(c => parseFloat(c.close));
  const currentPrice = dCloses[dCloses.length - 1];
  const rsi = RSI(dCloses, 14) || 50; // Safety fallback if RSI calculation is empty

  const isDailyBull = currentPrice > EMA(dCloses.slice(-20), 20);
  
  // Backtest adaptation: If fourHour candles aren't supplied in history loop, fall back gracefully to a short daily window
  const is4hBull = (fourHour && fourHour.length > 0)
    ? parseFloat(fourHour[fourHour.length - 1].close) > EMA(fourHour.map(c => parseFloat(c.close)).slice(-20), 20)
    : currentPrice > EMA(dCloses.slice(-10), 10);
    
  let momentumScore = 0;
  if (isDailyBull && is4hBull) momentumScore = 100;
  if (!isDailyBull && !is4hBull) momentumScore = -100;

  let reversionScore = 0;
  if (rsi < 30) reversionScore = 100;
  if (rsi > 70) reversionScore = -100;

  // Fetch news sentiment safely using unified mapping variables
  let newsScore = 0;
  let newsResult = {
    newsBias:"NEUTRAL",
    newsConfidence:"0%",
    newsProvider:"Unavailable",
    newsSummary:"News not checked",
    newsSentiment:0.0,
    newsCount:0,
    recentNews:[]
  };
  try {
    newsResult = await getNewsSentiment(symbol);
    // FIX 1: Weight the -1.0 to +1.0 normalized value accurately into a 15-point score matrix
    newsScore = (newsResult.newsSentiment || 0) * 15;
  } catch (err) {
    console.error("Failed to fetch news sentiment:", err);
  }

  // Fetch economic calendar data safely
  let economicScore = 0;
  let economicData = { hasHighImpactEvent: false, impact: "NORMAL", riskLevel: "LOW", events: [] };
  try {
    // Check if function exists before execution (helps with isolated testing environments)
    if (typeof getEconomicImpact === "function") {
      economicData = await getEconomicImpact();
      
      if (economicData.riskLevel === "CRITICAL") economicScore = -25; 
      else if (economicData.riskLevel === "HIGH") economicScore = -15; 
      else economicScore = 0;
    }
  } catch (err) {
    console.error("Failed to fetch economic data:", err);
  }

  // Combine all scores based on active trading market regime profile
  let finalScore = regime.direction === "SIDEWAYS" 
    ? (momentumScore * 0.25) + (reversionScore * 0.6) + newsScore + economicScore * 0.15
    : (momentumScore * 0.65) + (reversionScore * 0.2) + newsScore + economicScore * 0.15;

  let signal = "HOLD";
  let confidence = 50 + (Math.abs(finalScore) / 2);

  // Safely moderate metric metrics during active micro events
  if (economicData.hasHighImpactEvent) confidence *= 0.7;

  const confidenceThreshold = economicData.riskLevel === "HIGH" ? 65 : (economicData.riskLevel === "CRITICAL" ? 75 : 55);
  
  // Stricter checking flag: Ensure we don't break on uninitialized regime setups
  const marketIsTradable = regime.tradable !== undefined ? regime.tradable : true;

  if (finalScore >= 30 && marketIsTradable && confidence >= confidenceThreshold) signal = "BUY";
  else if (finalScore <= -30 && marketIsTradable && confidence >= confidenceThreshold) signal = "SELL";
  
  if (economicData.riskLevel === "CRITICAL") signal = "HOLD";

  // FIX 2: Ensure all keys returned strictly match variable naming requirements downstream
  return { 
    signal, 
    confidence: Math.round(Math.min(confidence, 100)),
    rsi,
    newsBias: newsResult.newsBias || "NEUTRAL",
    newsConfidence: newsResult.newsConfidence || "0%",
    newsProvider: newsResult.newsProvider || newsResult.source || "Unavailable",
    newsSummary: newsResult.newsSummary || "News check completed",
    newsSentiment: typeof newsResult.newsSentiment === "number" ? newsResult.newsSentiment : 0.0,
    newsCount: newsResult.newsCount || 0,
    recentNews: newsResult.recentNews || [],
    newsSearchKeyword: newsResult.searchKeyword || symbol || "",
    newsProviderError: newsResult.providerError || newsResult.error || null,
    economicRiskLevel: economicData.riskLevel || "LOW",
    hasUpcomingEvent: !!economicData.hasHighImpactEvent,
    shouldReduceExposure: typeof shouldReduceExposure === "function" ? shouldReduceExposure(economicData) : false,
    upcomingEvents: economicData.events || [],
    finalScore: typeof finalScore === "number" ? finalScore.toFixed(2) : "0.00",
    scores: {
      momentum: momentumScore,
      reversion: reversionScore,
      news: parseFloat(newsScore.toFixed(2)),
      economic: parseFloat(economicScore.toFixed(2))
    }
  };
}
