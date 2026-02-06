const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function callRedis(path) {
  const response = await fetch(`${REST_URL}/${path}`, {
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`
    }
  });
  if (!response.ok) {
    throw new Error(`Redis request failed: ${response.status}`);
  }
  return response.json();
}

function parseLeaderboard(raw) {
  const list = [];
  for (let i = 0; i < raw.length; i += 2) {
    const member = raw[i];
    const score = Number(raw[i + 1]);
    const name = String(member).split("::")[0];
    list.push({ name, time: score });
  }
  return list;
}

async function getLeaderboard(limit, excludeName) {
  const fetchLimit = Math.max(limit * 3, 12);
  const data = await callRedis(
    `zrange/leaderboard/0/${fetchLimit - 1}/WITHSCORES`
  );
  const items = parseLeaderboard(data.result || []);
  const filtered = excludeName
    ? items.filter((entry) => entry.name !== excludeName)
    : items;
  return filtered.slice(0, limit);
}

async function getBestTime(name) {
  if (!name) {
    return null;
  }
  const data = await callRedis(`hget/best_times/${encodeURIComponent(name)}`);
  if (data.result === null || data.result === undefined) {
    return null;
  }
  return Number(data.result);
}

export default async function handler(req, res) {
  if (!REST_URL || !REST_TOKEN) {
    return json(res, 500, { error: "Missing Upstash environment variables." });
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = Number(url.searchParams.get("limit") || 4);
      const exclude = url.searchParams.get("exclude") || "";
      const name = url.searchParams.get("name") || "";
      const leaderboard = await getLeaderboard(limit, exclude);
      const bestTime = await getBestTime(name);
      return json(res, 200, { leaderboard, bestTime });
    }

    if (req.method === "POST") {
      const body = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
          data += chunk;
        });
        req.on("end", () => {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (error) {
            reject(error);
          }
        });
      });

      const name = String(body.name || "").trim();
      const time = Number(body.time);
      if (!name || !Number.isFinite(time)) {
        return json(res, 400, { error: "Invalid payload." });
      }

      const previousBest = await getBestTime(name);
      const isNewBest = previousBest === null || time < previousBest;
      await callRedis(
        `hset/best_times/${encodeURIComponent(name)}/${time}`
      );
      const member = encodeURIComponent(`${name}::${Date.now()}`);
      await callRedis(`zadd/leaderboard/${time}/${member}`);

      const bestTime = await getBestTime(name);
      const leaderboard = await getLeaderboard(4, name);
      return json(res, 200, { bestTime, isNewBest, leaderboard });
    }

    return json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    return json(res, 500, { error: "Server error." });
  }
}
