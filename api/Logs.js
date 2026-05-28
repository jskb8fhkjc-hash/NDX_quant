import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

export default async function handler(req, res) {
  try {
    // Pull the latest 25 system logs from our Redis storage array list
    const logs = await redis.lrange("system-audit-logs", 0, 24);
    const parsedLogs = logs.map(item => typeof item === "string" ? JSON.parse(item) : item);
    
    return res.status(200).json({ success: true, logs: parsedLogs });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
