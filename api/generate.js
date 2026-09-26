const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const COPYRIGHT = "© XyncTeam - 2026";

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: [
        ...chromium.args,
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--no-sandbox",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }
  return browserPromise;
}

async function generateTokens(videoId) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  let capturedVisitorData = null;
  let capturedPoToken = null;

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    await page.setRequestInterception(true);

    page.on("request", (request) => {
      const reqUrl = request.url();
      const headers = request.headers();

      if (!capturedVisitorData && headers["x-goog-visitor-id"]) {
        capturedVisitorData = headers["x-goog-visitor-id"];
      }

      if (!capturedPoToken && reqUrl.includes("youtubei/v1/player")) {
        try {
          const postData = request.postData();
          if (postData) {
            const body = JSON.parse(postData);
            const poToken = body?.serviceIntegrityDimensions?.poToken;
            if (poToken) capturedPoToken = poToken;
          }
        } catch (_) {}
      }

      request.continue().catch(() => {});
    });

    await page.goto(`https://www.youtube.com/embed/${videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page
      .evaluate(() => {
        const video = document.querySelector("video");
        if (video) {
          video.muted = true;
          video.play().catch(() => {});
        }
      })
      .catch(() => {});

    const startTime = Date.now();
    while (!capturedPoToken && Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!capturedPoToken || !capturedVisitorData) {
      const result = await page
        .evaluate(() => {
          return {
            visitorData:
              window.ytcfg?.get?.("VISITOR_DATA") ||
              window.ytcfg?.data_?.VISITOR_DATA ||
              null,
            poToken:
              window.ytcfg?.get?.("PO_TOKEN") ||
              window.ytcfg?.data_?.PO_TOKEN ||
              null,
          };
        })
        .catch(() => ({}));

      if (!capturedVisitorData && result.visitorData) capturedVisitorData = result.visitorData;
      if (!capturedPoToken && result.poToken) capturedPoToken = result.poToken;
    }

    return {
      videoId,
      visitorData: capturedVisitorData,
      poToken: capturedPoToken,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const videoId =
    (req.query && req.query.video) ||
    (req.body && req.body.video) ||
    "dQw4w9WgXcQ";

  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return res.status(400).json({
      copyright: COPYRIGHT,
      success: false,
      error: "Video ID tidak valid",
    });
  }

  try {
    const result = await generateTokens(videoId);

    if (!result.poToken && !result.visitorData) {
      return res.status(502).json({
        copyright: COPYRIGHT,
        success: false,
        error: "Gagal generate token (BotGuard gak trigger)",
        videoId: result.videoId,
      });
    }

    return res.status(200).json({
      copyright: COPYRIGHT,
      success: true,
      videoId: result.videoId,
      visitorData: result.visitorData,
      poToken: result.poToken,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      copyright: COPYRIGHT,
      success: false,
      error: err.message || "Internal error",
    });
  }
};
