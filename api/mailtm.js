const COPYRIGHT = "© XyncTeam - 2026";
const MAIL_TM_BASE = "https://api.mail.tm";
const TIMEOUT_MS = 20_000;

function setCors(res, success = false) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, X-Copyright");
  res.setHeader("Cache-Control", "no-store");
  if (success) res.setHeader("X-Copyright", COPYRIGHT);
}

function sendError(res, status, message, detail) {
  setCors(res, false);
  res.status(status).json({
    success: false,
    error: message,
    ...(detail ? { detail } : {}),
  });
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizePath(value) {
  const raw = String(value || "").trim().replace(/^\/+/, "");
  if (raw === "domains" || raw === "accounts" || raw === "token" || raw === "messages") {
    return raw;
  }
  if (/^messages\/[A-Za-z0-9]+$/.test(raw)) return raw;
  return null;
}

function bodyObject(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res, true);
    return res.status(204).end();
  }
  if (!/^(GET|POST)$/.test(req.method || "")) {
    return sendError(res, 405, "Method tidak diizinkan.");
  }

  const path = normalizePath(first(req.query?.path));
  if (!path) return sendError(res, 400, "Path Mail.tm tidak valid.");

  const expectedMethod = path === "accounts" || path === "token" ? "POST" : "GET";
  if (req.method !== expectedMethod) {
    return sendError(res, 405, `${path} harus memakai ${expectedMethod}.`);
  }

  const headers = {
    Accept: "application/ld+json, application/json",
    "User-Agent": "XyncTeam-MailTM-Proxy/1.0",
  };
  const authorization = first(req.headers?.authorization);
  if (authorization) headers.Authorization = authorization;

  const options = { method: expectedMethod, headers };
  if (expectedMethod === "POST") {
    const body = bodyObject(req);
    if (!body) return sendError(res, 400, "Body JSON tidak valid.");
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(`${MAIL_TM_BASE}/${path}`, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return sendError(
      res,
      error?.name === "AbortError" ? 504 : 502,
      error?.name === "AbortError"
        ? "Mail.tm melewati batas waktu."
        : "Gagal menghubungi Mail.tm.",
    );
  }
  clearTimeout(timer);

  const text = await upstream.text();
  setCors(res, upstream.ok);
  res.status(upstream.status);
  res.setHeader(
    "Content-Type",
    upstream.headers.get("content-type") || "application/json; charset=utf-8",
  );
  return res.send(text);
}
