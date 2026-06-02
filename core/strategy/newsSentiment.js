/**
 * Core Quant Engine - News Sentiment Analytics Module
 * Path: core/strategy/newssentiment.js (or strategy/newssentiment.js)
 */

export async function getNewsSentiment(symbol) {
  try {
    // FIX 1: Map missing or broken symbol properties to a reliable macro market index keyword
    const searchKeyword = (!symbol || symbol.includes("ID:") || symbol === "undefined") ? "Nasdaq" : symbol;

    // FIX 2: Free tier NewsAPI requires a specific User-Agent header when executing from cloud serverless hosts like Vercel
    const response = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchKeyword)}&sortBy=publishedAt&language=en&pageSize=10&apiKey=${(process.env.NEWS_API_KEY || "").trim()}`,
      {
        headers: {
          "User-Agent": "QuantDashboardPro/1.0 (Production Serverless Handler)"
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`NewsAPI server rejected access with HTTP status: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.articles || data.articles.length === 0) {
      return { newsSentiment: 0.0, newsCount: 0, recentNews: [], message: "No relevant articles found for token" };
    }
    
    const articles = data.articles;
    let totalScore = 0;
    
    const positiveKeywords = ["surge", "rally", "gain", "bullish", "strong", "boom", "profit", "outperform", "rise", "upside", "growth", "high"];
    const negativeKeywords = ["crash", "plunge", "loss", "bearish", "weak", "drop", "decline", "downside", "risk", "concern", "threat", "low"];
    
    articles.forEach(article => {
      const text = ((article.title || "") + " " + (article.description || "")).toLowerCase();
      let articleScore = 0;
      
      positiveKeywords.forEach(kw => { if (text.includes(kw)) articleScore += 1; });
      negativeKeywords.forEach(kw => { if (text.includes(kw)) articleScore -= 1; });
      
      totalScore += articleScore;
    });
    
    // Normalize return values to float scores between -1.00 and +1.00
    const calculatedSentiment = Math.max(-1.0, Math.min(1.0, totalScore / (articles.length * 2)));
    
let newsBias = "NEUTRAL";
if (calculatedSentiment > 0.15) newsBias = "BULLISH";
if (calculatedSentiment < -0.15) newsBias = "BEARISH";

const newsConfidence = Math.min(100, Math.round(Math.abs(calculatedSentiment) * 100));

return {
  newsBias,
  newsConfidence: `${newsConfidence}%`,
  newsProvider: "NewsAPI",
  newsSummary: `Analyzed ${articles.length} recent articles`,
  newsSentiment: calculatedSentiment,
  newsCount: articles.length,
  recentNews: articles.slice(0, 3).map(a => ({ 
    title: a.title, 
    url: a.url,
    publishedAt: a.publishedAt
  })),
  source: "NewsAPI"
};
  } catch (err) {
    console.error("News sentiment tracking error caught inside module:", err);
    // Graceful fallback structures ensuring market.js pipeline never fails with 500 crashes
    return { newsSentiment: 0.0, newsCount: 0, recentNews: [], error: err.message };
  }
}
