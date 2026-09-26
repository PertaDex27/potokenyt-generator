const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const COPYRIGHT = "© XyncTeam - 2026";
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const CACHE_TTL_MS = Number(process.env.POT_CACHE_TTL_MS || 30 * 60 * 1000);

const tokenCache = new Map();
let generationQueue = Promise.resolve();
let runtimePromise = null;

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import("bgutils-js"),
      import("jsdom"),
      import("youtubei.js"),
    ]).then(([bgutils, jsdom, youtubei]) => {
      const dom = new jsdom.JSDOM("<!doctype html><html><body></body></html>", {
        url: "https://www.youtube.com/",
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
      });
      return {
        BG: bgutils.BG,
        Innertube: youtubei.Innertube,
      };
    });
  }
  return runtimePromise;
}

function enqueue(task) {
  const current = generationQueue.then(task, task);
  generationQueue = current.catch(() => {});
  return current;
}

async function createVisitorData() {
  const { Innertube } = await getRuntime();
  const innertube = await Innertube.create({
    retrieve_player: false,
    enable_session_cache: false,
  });
  const visitorData = innertube.session?.context?.client?.visitorData;
  if (!visitorData) throw new Error("YouTube tidak mengembalikan visitorData");
  return visitorData;
}

async function mintContentPoToken(videoId) {
  const { BG } = await getRuntime();
  const bgConfig = {
    fetch: (input, init) => fetch(input, init),
    globalObj: globalThis,
    identifier: videoId,
    requestKey: REQUEST_KEY,
  };
  const challenge = await BG.Challenge.create(bgConfig);
  if (!challenge) throw new Error("BotGuard challenge tidak tersedia");

  const interpreter =
    challenge.interpreterJavascript
      ?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreter) throw new Error("BotGuard VM tidak tersedia");
  new Function(interpreter)();

  const result = await BG.PoToken.generate({
    program: challenge.program,
    globalName: challenge.globalName,
    bgConfig,
  });
  if (!result?.poToken) throw new Error("BotGuard gagal membuat poToken");

  return {
    poToken: result.poToken,
    placeholderPoToken: BG.PoToken.generatePlaceholder(videoId),
    tokenTtlSeconds:
      Number(result.integrityTokenData?.estimatedTtlSecs) || null,
  };
}

async function generateTokens(videoId) {
  const cached = tokenCache.get(videoId);
  if (cached && Date.now() < cached.cacheExpiresAt) return cached.value;

  return enqueue(async () => {
    const secondCheck = tokenCache.get(videoId);
    if (secondCheck && Date.now() < secondCheck.cacheExpiresAt) {
      return secondCheck.value;
    }

    const [visitorData, token] = await Promise.all([
      createVisitorData(),
      mintContentPoToken(videoId),
    ]);
    const value = {
      videoId,
      visitorData,
      poToken: token.poToken,
      playerPoToken: token.poToken,
      placeholderPoToken: token.placeholderPoToken,
      tokenType: "content_bound",
      tokenTtlSeconds: token.tokenTtlSeconds,
      generatedAt: new Date().toISOString(),
    };

    tokenCache.set(videoId, {
      value,
      cacheExpiresAt: Date.now() + CACHE_TTL_MS,
    });
    if (tokenCache.size > 100) tokenCache.delete(tokenCache.keys().next().value);
    return value;
  });
}

function sendJson(res, status, payload) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.json(status < 400 ? { copyright: COPYRIGHT, ...payload } : payload);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (!/^(GET|POST)$/.test(req.method || "")) {
    return sendJson(res, 405, {
      success: false,
      error: "Method tidak diizinkan. Gunakan GET atau POST.",
    });
  }

  const videoId = String(
    req.query?.video || req.body?.video || "dQw4w9WgXcQ",
  ).trim();
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return sendJson(res, 400, {
      success: false,
      error: "Video ID tidak valid.",
    });
  }

  try {
    const result = await generateTokens(videoId);
    return sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    return sendJson(res, 502, {
      success: false,
      error: error?.message || "Gagal membuat poToken dan visitorData.",
    });
  }
}
