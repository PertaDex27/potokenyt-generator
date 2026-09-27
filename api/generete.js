const YOUTUBE_PLAYER_API = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const COPYRIGHT = "© XyncTeam - 2026";
const POTOKEN_API = "https://potokenyt-generator.vercel.app/api/generate";

const DEFAULT_REGIONS = ["ID", "US", "GB", "JP", "SG", "MY"];
const MAX_ATTEMPTS = 16;

const _tokenCache = new Map();
const TOKEN_TTL = 1000 * 60 * 30;
const FETCH_TIMEOUT = 15000;

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        if (err.name === "AbortError") {
            throw new Error(`Request to ${url} timed out after ${timeout}ms`);
        }
        throw err;
    }
}

async function fetchTokensFromService(videoId, env = {}) {
    const now = Date.now();
    const cached = _tokenCache.get(videoId);
    if (cached?.visitorData && cached?.poToken && now - cached.ts < TOKEN_TTL) {
        return { visitorData: cached.visitorData, poToken: cached.poToken };
    }

    const endpoint = env.POTOKEN_API || POTOKEN_API;
    try {
        const tokenUrl = new URL(endpoint);
        tokenUrl.searchParams.set("video", videoId);
        const headers = { Accept: "application/json" };
        if (env.POTOKEN_API_KEY) {
            headers.Authorization = `Bearer ${env.POTOKEN_API_KEY}`;
        }

        const res = await fetchWithTimeout(tokenUrl.toString(), { headers });
        if (!res.ok) throw new Error(`PoToken API HTTP ${res.status}`);
        const data = await res.json();
        const poToken = data.playerPoToken || data.poToken || null;

        if (data.success && data.visitorData && poToken) {
            const value = { visitorData: data.visitorData, poToken, ts: now };
            _tokenCache.set(videoId, value);
            if (_tokenCache.size > 100) {
                _tokenCache.delete(_tokenCache.keys().next().value);
            }
            return { visitorData: value.visitorData, poToken: value.poToken };
        }
        throw new Error(data.error || "PoToken API tidak mengembalikan token lengkap");
    } catch (_) {
        if (cached?.visitorData && cached?.poToken) {
            return { visitorData: cached.visitorData, poToken: cached.poToken };
        }
        return { visitorData: null, poToken: null };
    }
}

function getVisitorData(env, tokenBundle = null) {
    return tokenBundle?.visitorData || env.YT_VISITOR_DATA || null;
}

const YT_CLIENTS = [
    {
        name: "ANDROID",
        headerName: "3",
        version: "20.29.38",
        userAgent: "com.google.android.youtube/20.29.38 (Linux; U; Android 15) gzip",
        buildContext: (visitorData) => ({
            clientName: "ANDROID",
            clientVersion: "20.29.38",
            androidSdkVersion: 35,
            hl: "en",
            gl: "US",
            ...(visitorData ? { visitorData } : {}),
        }),
    },
{
    name: "TVHTML5",
    headerName: "7",
    version: "7.20240813.07.00",
    userAgent: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1",
    buildContext: (visitorData) => ({
        clientName: "TVHTML5",
        clientVersion: "7.20240813.07.00",
        hl: "en",
        gl: "US",
        ...(visitorData ? { visitorData } : {}),
    }),
},
{
    name: "IOS",
    headerName: "5",
    version: "20.10.4",
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)",
    buildContext: (visitorData) => ({
        clientName: "IOS",
        clientVersion: "20.10.4",
        deviceModel: "iPhone16,2",
        hl: "en",
        gl: "US",
        ...(visitorData ? { visitorData } : {}),
    }),
},
{
    name: "WEB",
    headerName: "1",
    version: "2.20250101.01.00",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    buildContext: (visitorData) => ({
        clientName: "WEB",
        clientVersion: "2.20250101.01.00",
        hl: "en",
        gl: "US",
        ...(visitorData ? { visitorData } : {}),
    }),
},
];

function corsHeaders(extra = {}) {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Content-Range, X-Copyright",
        ...extra,
    };
}

function jsonResponse(payload, status = 200) {
    const ok = status < 400 && payload?.success !== false;
    const body = ok ? { copyright: COPYRIGHT, ...payload } : payload;
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: corsHeaders({
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
        }),
    });
}

function extractVideoId(input) {
    if (typeof input !== "string") return null;
    const value = input.trim();
    if (VIDEO_ID_PATTERN.test(value)) return value;

    let url;
    try {
        url = new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (host === "youtu.be") {
        const id = url.pathname.split("/").filter(Boolean)[0];
        return VIDEO_ID_PATTERN.test(id || "") ? id : null;
    }

    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;

    const queryId = url.searchParams.get("v");
    if (VIDEO_ID_PATTERN.test(queryId || "")) return queryId;

    const match = url.pathname.match(/^\/(?:shorts|embed|v|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    return match?.[1] || null;
}

function isShortsUrl(input) {
    if (typeof input !== "string" || VIDEO_ID_PATTERN.test(input.trim())) return false;
    try {
        const url = new URL(input.includes("://") ? input : `https://${input}`);
        return /^\/shorts\/[A-Za-z0-9_-]{11}(?:\/|$)/.test(url.pathname);
    } catch {
        return false;
    }
}

function readableSize(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return null;
    if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
    if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(2)} MB`;
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${size} B`;
}

function sanitizeFilename(value) {
    return (
        String(value || "youtube-media")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140) || "youtube-media"
    );
}

function contentDisposition(filename) {
    const safe = sanitizeFilename(filename);
    const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(safe).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function getExt(mime, type) {
    if (mime === "audio/mp4") return "m4a";
    if (mime === "audio/webm") return "weba";
    if (mime === "video/webm") return "webm";
    if (mime === "video/3gpp") return "3gp";
    if (mime === "video/mp4") return "mp4";
    return type === "audio" ? "m4a" : "mp4";
}

async function tryClientRegion(videoId, client, region, visitorData, poToken) {
    const reqHeaders = {
        "Content-Type": "application/json",
        "User-Agent": client.userAgent,
        "X-YouTube-Client-Name": client.headerName,
        "X-YouTube-Client-Version": client.version,
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "Accept-Language": "en-US,en;q=0.9",
    };
    if (visitorData) reqHeaders["X-Goog-Visitor-Id"] = visitorData;

    const ctx = client.buildContext(visitorData);
    if (region) ctx.gl = region;

    const body = {
        videoId,
        context: { client: ctx },
        contentCheckOk: true,
        racyCheckOk: true,
        params: "2AMBCgIQBg==",
    };
    if (poToken) body.serviceIntegrityDimensions = { poToken };

    const label = `${client.name}/${region}`;

    try {
        const res = await fetchWithTimeout(YOUTUBE_PLAYER_API, {
            method: "POST",
            headers: reqHeaders,
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            return { ok: false, attempt: { client: client.name, region, error: `[${label}] HTTP ${res.status}` } };
        }

        const data = await res.json();
        const playability = data?.playabilityStatus || {};

        if (playability.status !== "OK") {
            const reason = playability.reason || playability.status || "YouTube menolak";
            return { ok: false, attempt: { client: client.name, region, error: `[${label}] ${reason}` } };
        }

        const formats = [
            ...(data.streamingData?.formats || []),
            ...(data.streamingData?.adaptiveFormats || []),
        ];
        const hasUrl = formats.some((f) => f.url);

        if (!hasUrl) {
            return { ok: false, attempt: { client: client.name, region, error: `[${label}] Tidak ada format media` } };
        }

        return {
            ok: true,
            data,
            client: client.name,
            region,
            userAgent: client.userAgent,
        };
    } catch (err) {
        return {
            ok: false,
            attempt: { client: client.name, region, error: `[${label}] ${err.message || String(err)}` },
        };
    }
}

async function getPlayer(videoId, env = {}, forcedRegion = null) {
    const attempts = [];

    const tokenBundle = await fetchTokensFromService(videoId, env);
    const visitorData = getVisitorData(env, tokenBundle);
    const poToken = tokenBundle.poToken || null;

    let regions;
    if (forcedRegion && /^[A-Z]{2}$/.test(forcedRegion)) {
        regions = [forcedRegion];
    } else if (env.YT_REGIONS) {
        regions = String(env.YT_REGIONS).split(",").map((r) => r.trim()).filter((r) => /^[A-Z]{2}$/.test(r));
        if (!regions.length) regions = [...DEFAULT_REGIONS];
    } else {
        regions = [...DEFAULT_REGIONS];
    }

    const order = [];
    for (const client of YT_CLIENTS) {
        for (const region of regions) {
            order.push({ client, region });
        }
    }

    const limit = Math.min(order.length, MAX_ATTEMPTS);

    for (let i = 0; i < limit; i++) {
        const { client, region } = order[i];
        const result = await tryClientRegion(videoId, client, region, visitorData, poToken);
        if (result.ok) {
            return {
                ok: true,
                data: result.data,
                client: result.client,
                region: result.region,
                userAgent: result.userAgent,
                attempts,
            };
        }
        attempts.push(result.attempt);
    }

    return {
        ok: false,
        error: `Semua ${limit} kombinasi client × region gagal`,
        attempts,
    };
}

function buildMetadata(player, videoId, isShorts, origin) {
    const streamingData = player.streamingData || {};
    const rawFormats = [
        ...(Array.isArray(streamingData.formats) ? streamingData.formats : []),
        ...(Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : []),
    ];

    const seen = new Set();
    const medias = [];
    let idx = 0;

    for (const f of rawFormats) {
        const itag = String(f.itag || "");
        if (!itag || seen.has(itag) || !f.url) continue;
        seen.add(itag);

        const mime = (f.mimeType || "").split(";")[0].trim().toLowerCase();
        const codecs = (f.mimeType || "").match(/codecs="([^"]+)"/)?.[1] || "";
        const type = mime.startsWith("audio/") ? "audio" : "video";
        const ext = getExt(mime, type);
        const hasAudio = type === "audio" || /(?:mp4a|aac|opus|vorbis|ac-3|ec-3)/i.test(codecs);
        const bitrate = Number(f.audioBitrate) || Math.round(Number(f.bitrate || 0) / 1000);
        const quality = type === "audio"
        ? `${bitrate || "Audio"}${bitrate ? "kbps" : ""}`
        : `${f.qualityLabel || f.quality || `${f.height || "Video"}p`}${hasAudio ? "" : " (video only)"}`;

        const size = Number(f.contentLength);
        idx++;

        const params = new URLSearchParams({
            dl: videoId,
            itag,
            q: quality.slice(0, 60),
                                           ext,
        });

        medias.push({
            id: idx,
            itag,
            type,
            quality,
            format: `${quality} [.${ext}]`,
                extension: ext,
                fileSize: Number.isFinite(size) ? size : null,
                    size: readableSize(size),
                    hasAudio,
                    width: Number(f.width) || null,
                    height: Number(f.height) || null,
                    fps: Number(f.fps) || null,
                    bitrate: Number(f.bitrate) || null,
                    url: `${origin}/?${params.toString()}`,
        });
    }

    const details = player.videoDetails || {};
    const thumbs = details.thumbnail?.thumbnails || [];
    const duration = Number(details.lengthSeconds);

    return {
        id: videoId,
        sourceUrl: isShorts
        ? `https://www.youtube.com/shorts/${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`,
        title: details.title || `youtube-${videoId}`,
        author: details.author || null,
        duration: Number.isFinite(duration) ? duration : null,
        thumbnail: thumbs.at(-1)?.url || null,
        videos: medias.filter((m) => m.type === "video"),
        audios: medias.filter((m) => m.type === "audio"),
        medias,
    };
}

async function handleMetadata(request, url, env) {
    const input = url.searchParams.get("url") || url.searchParams.get("id");
    if (!input) {
        return jsonResponse({ success: false, error: "Parameter url atau id wajib diisi" }, 400);
    }

    const videoId = extractVideoId(input);
    if (!videoId) {
        return jsonResponse({ success: false, error: "URL atau ID YouTube tidak valid" }, 400);
    }

    const forcedType = (url.searchParams.get("type") || "auto").toLowerCase();
    if (!/^(auto|video|shorts)$/.test(forcedType)) {
        return jsonResponse({ success: false, error: "Parameter type harus auto, video, atau shorts" }, 400);
    }

    const forcedRegion = (url.searchParams.get("region") || "").toUpperCase();

    const isShorts = forcedType === "shorts"
    ? true
    : forcedType === "video"
    ? false
    : isShortsUrl(input);

    const player = await getPlayer(videoId, env, forcedRegion || null);

    if (!player.ok) {
        return jsonResponse(
            { success: false, error: player.error, attempts: player.attempts },
            502,
        );
    }

    const data = buildMetadata(player.data, videoId, isShorts, url.origin);

    return jsonResponse({
        success: true,
        type: isShorts ? "shorts" : "video",
        client: player.client,
        region: player.region,
        data,
    });
}

async function resolveYtUrl(videoId, itag, env, forcedRegion) {
    const player = await getPlayer(videoId, env, forcedRegion);
    if (!player.ok) return { ok: false, error: player.error, attempts: player.attempts };
    const formats = [
        ...(player.data.streamingData?.formats || []),
        ...(player.data.streamingData?.adaptiveFormats || []),
    ];
    const selected = formats.find((f) => String(f.itag) === String(itag) && f.url);
    if (!selected) return { ok: false, error: "Format tidak tersedia di upstream" };
    return {
        ok: true,
        ytUrl: selected.url,
        title: player.data.videoDetails?.title || null,
        client: player.client,
        region: player.region,
        userAgent: player.userAgent,
    };
}

async function handleDownload(request, url, env) {
    const videoId = url.searchParams.get("dl");
    const itag = url.searchParams.get("itag");
    const quality = url.searchParams.get("q") || "media";
    const ext = url.searchParams.get("ext") || "mp4";
    const forcedRegion = (url.searchParams.get("region") || "").toUpperCase() || null;

    if (!VIDEO_ID_PATTERN.test(String(videoId || "")) || !/^\d+$/.test(String(itag || ""))) {
        return jsonResponse({ success: false, error: "Parameter dl atau itag tidak valid" }, 400);
    }

    let resolved = await resolveYtUrl(videoId, itag, env, forcedRegion);
    if (!resolved.ok) {
        return jsonResponse(
            { success: false, error: resolved.error, attempts: resolved.attempts },
            502,
        );
    }

    let ytUrl = resolved.ytUrl;
    let titleFallback = resolved.title || `youtube-${videoId}`;
    let upstreamUserAgent = resolved.userAgent || YT_CLIENTS[0].userAgent;

    const buildUpstreamHeaders = (range, userAgent) => {
        const h = {
            "User-Agent": userAgent,
            "Accept": "*/*",
            "Referer": "https://www.youtube.com/",
            "Origin": "https://www.youtube.com",
        };
        if (range) h["Range"] = range;
        return h;
    };

    const range = request.headers.get("Range");
    let upstream;

    try {
        upstream = await fetchWithTimeout(ytUrl, {
            headers: buildUpstreamHeaders(range, upstreamUserAgent),
        });
    } catch (err) {
        return jsonResponse({ success: false, error: `Gagal membuka stream: ${err.message}` }, 502);
    }

    if (!upstream.ok && upstream.status !== 206) {
        const firstStatus = upstream.status;
        upstream.body?.cancel?.().catch(() => {});

        resolved = await resolveYtUrl(videoId, itag, env, forcedRegion);
        if (!resolved.ok) {
            return jsonResponse(
                { success: false, error: `Retry resolve gagal: ${resolved.error}` },
                502,
            );
        }

        ytUrl = resolved.ytUrl;
        titleFallback = resolved.title || titleFallback;
        upstreamUserAgent = resolved.userAgent || upstreamUserAgent;
        try {
            upstream = await fetchWithTimeout(ytUrl, {
                headers: buildUpstreamHeaders(range, upstreamUserAgent),
            });
        } catch (err) {
            return jsonResponse({ success: false, error: `Retry stream gagal: ${err.message}` }, 502);
        }

        if (!upstream.ok && upstream.status !== 206) {
            const detail = await upstream.text().catch(() => "");
            return jsonResponse(
                {
                    success: false,
                    error: `File upstream gagal: HTTP ${firstStatus}, retry HTTP ${upstream.status}${detail ? ` - ${detail.slice(0, 120)}` : ""}`,
                },
                502,
            );
        }
    }

    const filename = `${sanitizeFilename(titleFallback)}-${sanitizeFilename(quality)}.${ext}`;

    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
    headers.set("Accept-Ranges", upstream.headers.get("Accept-Ranges") || "bytes");
    headers.set("Cache-Control", "private, no-store");
    headers.set("Content-Disposition", contentDisposition(filename));
    headers.set("X-Copyright", COPYRIGHT);

    for (const h of ["Content-Length", "Content-Range", "ETag", "Last-Modified"]) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
    }

    for (const [k, v] of Object.entries(corsHeaders())) {
        headers.set(k, v);
    }

    if (request.method === "HEAD") {
        upstream.body?.cancel?.().catch(() => {});
        return new Response(null, {
            status: upstream.status === 206 ? 206 : 200,
            headers,
        });
    }

    return new Response(upstream.body, {
        status: upstream.status === 206 ? 206 : 200,
        headers,
    });
}

async function handleDebug(request, url, env) {
    const videoId = url.searchParams.get("video") || "dQw4w9WgXcQ";
    const forcedRegion = (url.searchParams.get("region") || "").toUpperCase() || null;

    if (!VIDEO_ID_PATTERN.test(videoId)) {
        return jsonResponse({ success: false, error: "video ID tidak valid" }, 400);
    }

    const tokenBundle = await fetchTokensFromService(videoId, env);
    const visitorData = getVisitorData(env, tokenBundle);
    const poToken = tokenBundle.poToken || null;

    let regions = forcedRegion ? [forcedRegion] : (env.YT_REGIONS ? String(env.YT_REGIONS).split(",") : DEFAULT_REGIONS);

    const envInfo = {
        YT_VISITOR_DATA_set: !!visitorData,
        YT_VISITOR_DATA_source: tokenBundle.visitorData
        ? "PoToken API (Vercel)"
        : env.YT_VISITOR_DATA
        ? "env.YT_VISITOR_DATA"
        : "none",
        YT_VISITOR_DATA_length: visitorData?.length ?? 0,
        YT_VISITOR_DATA_preview: visitorData ? visitorData.slice(0, 50) + "..." : "N/A",
        PO_TOKEN_set: !!poToken,
        PO_TOKEN_length: poToken ? poToken.length : 0,
        PO_TOKEN_preview: poToken ? poToken.slice(0, 30) + "..." : "N/A",
        REGIONS: regions.join(","),
        FORCED_REGION: forcedRegion || "(auto)",
        CF_COLO: request.cf?.colo || "unknown",
        CF_COUNTRY: request.cf?.country || "unknown",
        CF_ASN: request.cf?.asn || "unknown",
        CF_AS_ORGANIZATION: request.cf?.asOrganization || "unknown",
    };

    const results = [];

    for (const client of YT_CLIENTS) {
        for (const region of regions) {
            const r = await tryClientRegion(videoId, client, region, visitorData, poToken);
            const info = {
                client: client.name,
                region,
                version: client.version,
                ok: r.ok,
            };

            if (r.ok) {
                const data = r.data;
                const playability = data?.playabilityStatus || {};
                info.status = playability.status;
                info.title = data?.videoDetails?.title || null;
                const formats = [
                    ...(data.streamingData?.formats || []),
                    ...(data.streamingData?.adaptiveFormats || []),
                ].filter((f) => f.url);
                info.formatCount = formats.length;
            } else {
                info.error = r.attempt?.error || null;
            }

            results.push(info);
        }
    }

    const anyOk = results.some((r) => r.ok);

    return jsonResponse({
        success: true,
        debug: true,
        videoId,
        summary: {
            any_client_ok: anyOk,
            verdict: anyOk
            ? "✅ Minimal 1 kombinasi client × region lolos"
            : "❌ Semua kombinasi gagal — video mungkin region-locked di semua region yang dicoba",
        },
        env: envInfo,
        results,
    });
}

function handleDocs(origin) {
    return jsonResponse({
        success: true,
        name: "XyncTeam YouTube Downloader API",
        version: "2.0.0",
        endpoint: origin,
        powered_by: "Cloudflare Workers",
        features: {
            multiRegion: DEFAULT_REGIONS.join(", "),
                        autoRegionFallback: true,
                        poToken: "automatic content-bound token",
                        downloadProxy: "fresh URL per download invocation",
        },
        usage: {
            auto: `GET ${origin}/?url=YOUTUBE_URL`,
            video: `GET ${origin}/?type=video&url=YOUTUBE_URL`,
            shorts: `GET ${origin}/?type=shorts&url=SHORTS_URL`,
            forceRegion: `GET ${origin}/?region=US&url=YOUTUBE_URL`,
                download: `GET ${origin}/?dl=VIDEO_ID&itag=ITAG&q=QUALITY&ext=mp4`,
                debug: `GET ${origin}/?debug=1&video=VIDEO_ID`,
        },
    });
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        if (!/^(GET|HEAD)$/.test(request.method)) {
            return jsonResponse({ success: false, error: "Method tidak diizinkan" }, 405);
        }

        const url = new URL(request.url);

        try {
            if (url.searchParams.has("debug")) {
                return await handleDebug(request, url, env);
            }

            if (url.searchParams.has("dl")) {
                return await handleDownload(request, url, env);
            }

            if (url.searchParams.has("url") || url.searchParams.has("id")) {
                return await handleMetadata(request, url, env);
            }

            return handleDocs(url.origin);
        } catch (err) {
            return jsonResponse(
                { success: false, error: err.message || "Internal error" },
                500,
            );
        }
    },
};
