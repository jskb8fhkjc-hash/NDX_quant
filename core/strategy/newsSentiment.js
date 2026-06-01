export async function getNewsSentiment(symbol) {
  try {
    const response = await fetch(
      `https://newsapi.org/v2/everything?q=${symbol}&sortBy=publishedAt&language=en&pageSize=10&apiKey=${process.env.NEWS_API_KEY}`
    );
    
    if (!response.ok) throw new Error(`News API error: ${response.status}`);
    const data = await response.json();
    
    if (!data.articles?.length) return { sentimentScore: 0, newsCount: 0, recentNews: [] };
    
    const articles = data.articles;
    let sentimentScore = 0;
    
    const positiveKeywords = ["surge", "rally", "gain", "bullish", "strong", "boom", "profit", "outperform", "rise", "upside", "growth"];
    const negativeKeywords = ["crash", "plunge", "loss", "bearish", "weak", "drop", "decline", "downside", "risk", "concern", "threat"];
    
    articles.forEach(article => {
      const text = (article.title + " " + (article.description || "")).toLowerCase();
      let articleScore = 0;
      
      positiveKeywords.forEach(kw => { if (text.includes(kw)) articleScore += 1; });
      negativeKeywords.forEach(kw => { if (text.includes(kw)) articleScore -= 1; });
      
      sentimentScore += articleScore;
    });
    
    // Normalize to -100 to 100
    const normalizedScore = Math.max(-100, Math.min(100, (sentimentScore / articles.length) * 20));
    
    return {
      sentimentScore: normalizedScore,
      newsCount: articles.length,
      recentNews: articles.slice(0, 3).map(a => ({ 
        title: a.title, 
        url: a.url,
        publishedAt: a.publishedAt
      })),
      source: "NewsAPI"
    };
  } catch (err) {
    console.error("News sentiment error:", err);
    return { sentimentScore: 0, newsCount: 0, recentNews: [], error: err.message };
  }
}
