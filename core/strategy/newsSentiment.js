const POSITIVE_KEYWORDS = [
  "surge",
  "rally",
  "gain",
  "bullish",
  "strong",
  "profit",
  "outperform",
  "rise",
  "upside",
  "growth",
  "upgrade",
  "beat",
  "record",
  "demand"
];

const NEGATIVE_KEYWORDS = [
  "crash",
  "plunge",
  "loss",
  "bearish",
  "weak",
  "drop",
  "decline",
  "downside",
  "risk",
  "concern",
  "threat",
  "lawsuit",
  "miss",
  "downgrade",
  "probe"
];

function getSearchKeyword(symbol) {
  if(
    !symbol ||
    symbol.includes("ID:") ||
    symbol === "undefined" ||
    symbol === "--"
  ){
    return "Nasdaq stocks";
  }

  return symbol;
}

function scoreArticles(articles) {
  let totalScore = 0;

  const scoredArticles =
    articles.map(article => {
      const text =
        `${article.title || ""} ${article.description || ""}`
          .toLowerCase();

      let articleScore = 0;

      POSITIVE_KEYWORDS.forEach(keyword => {
        if(text.includes(keyword)){
          articleScore += 1;
        }
      });

      NEGATIVE_KEYWORDS.forEach(keyword => {
        if(text.includes(keyword)){
          articleScore -= 1;
        }
      });

      totalScore += articleScore;

      return {
        ...article,
        articleScore
      };
    });

  const sentiment =
    scoredArticles.length
    ? Math.max(
      -1,
      Math.min(
        1,
        totalScore / (scoredArticles.length * 2)
      )
    )
    : 0;

  let newsBias = "NEUTRAL";

  if(sentiment > 0.15){
    newsBias = "BULLISH";
  }

  if(sentiment < -0.15){
    newsBias = "BEARISH";
  }

  return {
    sentiment,
    newsBias,
    newsConfidence:
      `${Math.min(100, Math.round(Math.abs(sentiment) * 100))}%`,
    scoredArticles
  };
}

async function fetchNewsApiArticles(searchKeyword) {
  const apiKey =
    (process.env.NEWS_API_KEY || "").trim();

  if(!apiKey){
    return null;
  }

  const response =
    await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchKeyword)}&sortBy=publishedAt&language=en&pageSize=10&apiKey=${apiKey}`,
      {
        headers:{
          "User-Agent":"QuantDashboardPro/1.0"
        }
      }
    );

  if(!response.ok){
    throw new Error(`NewsAPI HTTP ${response.status}`);
  }

  const data =
    await response.json();

  return {
    provider:"NewsAPI",
    articles:(data.articles || []).map(article => ({
      title:article.title,
      description:article.description,
      url:article.url,
      publishedAt:article.publishedAt
    }))
  };
}

async function fetchGdeltArticles(searchKeyword) {
  const response =
    await fetch(
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(searchKeyword)}&mode=artlist&format=json&maxrecords=10&sort=hybridrel&timespan=7d`
    );

  if(!response.ok){
    throw new Error(`GDELT HTTP ${response.status}`);
  }

  const data =
    await response.json();

  const articles =
    (data.articles || []).map(article => ({
      title:article.title,
      description:article.seendate || "",
      url:article.url,
      publishedAt:article.seendate || article.seendate || null,
      source:article.domain
    }));

  return {
    provider:"GDELT",
    articles
  };
}

export async function getNewsSentiment(symbol) {
  const searchKeyword =
    getSearchKeyword(symbol);

  try{
    let result = null;
    let providerError = null;

    try{
      result =
        await fetchNewsApiArticles(searchKeyword);
    }catch(err){
      providerError =
        err.message;
    }

    if(!result){
      result =
        await fetchGdeltArticles(searchKeyword);
    }

    const articles =
      result.articles || [];

    const scored =
      scoreArticles(articles);

    return {
      newsBias:
        scored.newsBias,
      newsConfidence:
        scored.newsConfidence,
      newsProvider:
        result.provider,
      newsSummary:
        articles.length
        ? `Analyzed ${articles.length} recent articles for ${searchKeyword}`
        : `No recent articles found for ${searchKeyword}`,
      newsSentiment:
        scored.sentiment,
      newsCount:
        articles.length,
      recentNews:
        scored.scoredArticles.slice(0, 5).map(article => ({
          title:article.title,
          url:article.url,
          publishedAt:article.publishedAt,
          source:article.source,
          score:article.articleScore
        })),
      source:
        result.provider,
      searchKeyword,
      providerError
    };

  }catch(err){
    console.error(
      "News sentiment tracking error caught inside module:",
      err
    );

    return {
      newsBias:"NEUTRAL",
      newsConfidence:"0%",
      newsProvider:"Unavailable",
      newsSummary:`News lookup failed for ${searchKeyword}: ${err.message}`,
      newsSentiment:0,
      newsCount:0,
      recentNews:[],
      source:"Unavailable",
      searchKeyword,
      error:err.message
    };
  }
}
