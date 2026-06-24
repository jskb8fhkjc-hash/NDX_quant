export async function getEconomicImpact() {
  try {
    // Using a free economic calendar API or cached approach
    // For best results, integrate with FRED, Polygon.io, or TradingEconomics
    const now = new Date();
    
    // Fallback: hardcoded high-impact events (US market)
    // In production, replace with real API call
    const highImpactPatterns = [
      { name: "FOMC Meeting", hour: 14 }, // 2 PM ET
      { name: "NFP Release", hour: 13, day: "first-friday" }, // First Friday 1 PM ET
      { name: "Fed Speaker", hour: 12 },
      { name: "CPI Release", hour: 13 },
      { name: "PPI Release", hour: 13 }
    ];
    
    let highImpactEvents = [];
    
    // Check if today is first Friday (NFP)
    const isFirstFriday = now.getDate() <= 7 && now.getDay() === 5;
    
    highImpactPatterns.forEach(event => {
      if (event.day === "first-friday" && !isFirstFriday) return;
      
      const eventTime = new Date(now);
      eventTime.setHours(event.hour, 0, 0, 0);
      const minutesUntilEvent = (eventTime - now) / (1000 * 60);
      
      if (minutesUntilEvent > 0 && minutesUntilEvent < 120) {
        highImpactEvents.push({
          name: event.name,
          time: eventTime.toISOString(),
          importance: "HIGH",
          minutesUntil: Math.round(minutesUntilEvent)
        });
      }
    });
    
    let riskLevel = "LOW";
    if (highImpactEvents.length > 2) riskLevel = "CRITICAL";
    else if (highImpactEvents.length > 0) riskLevel = "HIGH";
    
    return {
      hasHighImpactEvent: highImpactEvents.length > 0,
      impact: highImpactEvents.length > 0 ? "CAUTION" : "NORMAL",
      events: highImpactEvents,
      riskLevel,
      timestamp: now.toISOString(),
      source: "EconomicCalendar"
    };
  } catch (err) {
    console.error("Economic calendar error:", err);
    return { 
      hasHighImpactEvent: false, 
      impact: "NORMAL", 
      events: [], 
      riskLevel: "LOW", 
      error: err.message,
      timestamp: new Date().toISOString()
    };
  }
}

export function shouldReduceExposure(economicData) {
  // Return true if we should reduce position size due to upcoming events
  return economicData.riskLevel === "CRITICAL" || (economicData.riskLevel === "HIGH" && economicData.events.some(e => e.minutesUntil < 60));
}
