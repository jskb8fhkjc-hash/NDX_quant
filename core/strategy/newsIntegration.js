import fetch from "node-fetch";

export async function fetchLatestNews(symbol) {
  const apiKey = process.env.NEWS_API_KEY;

  // Validate symbol
  if (!symbol || typeof symbol !== "string" || !symbol.trim()) {
    console.error("Invalid symbol passed to fetchLatestNews:", symbol);
    return {
      sentimentScore: 0,
      newsCount: 0,
      recentNews: [],
    };
  }

  const newsApiUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol)}&sortBy=publishedAt&apiKey=${apiKey}`;

  try {
    const response = await fetch(newsApiUrl);
    const data = await response.json();

    if (data.status !== "ok" || !data.articles) {
      throw new Error("Error fetching news: " + (data.message || "Unknown error"));
    }

    const sentimentScore = calculateSentimentScore(data.articles);
    return {
      sentimentScore,
      newsCount: data.articles.length,
      recentNews: data.articles.slice(0, 5),
    };
  } catch (error) {
    console.error("Failed to fetch news from NewsAPI: ", error.message);
    return {
      sentimentScore: 0,
      newsCount: 0,
      recentNews: [],
    };
  }
}

function calculateSentimentScore(articles) {
  // Placeholder: assign neutral score for now
  if (!articles.length) return 0;
  return articles.reduce((score, article) => score + 50, 0) / articles.length;
}