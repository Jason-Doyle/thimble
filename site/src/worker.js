const apexHostname = "thimbledb.com";
const permanentRedirectStatus = 308;

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch(request: Request): Promise<Response> } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === `www.${apexHostname}`) {
      url.protocol = "https:";
      url.hostname = apexHostname;
      url.port = "";
      return new Response(null, {
        status: permanentRedirectStatus,
        headers: withSecurityHeaders(
          new Headers({
            location: url.toString(),
            "cache-control": "public, max-age=3600",
          }),
        ),
      });
    }

    const response = await env.ASSETS.fetch(request);
    const headers = withSecurityHeaders(new Headers(response.headers));
    headers.set("cache-control", cacheControl(url.pathname, response.status));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

/** @param {Headers} headers */
function withSecurityHeaders(headers) {
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "strict-transport-security",
    "max-age=31536000; includeSubDomains",
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return headers;
}

/**
 * @param {string} pathname
 * @param {number} status
 */
function cacheControl(pathname, status) {
  if (status >= 400) {
    return "public, max-age=0, must-revalidate";
  }
  if (pathname.startsWith("/_astro/")) {
    return "public, max-age=31536000, immutable";
  }
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=86400, stale-while-revalidate=604800";
  }
  if (
    pathname === "/robots.txt" ||
    pathname === "/sitemap-index.xml" ||
    pathname.startsWith("/sitemap-")
  ) {
    return "public, max-age=3600";
  }
  return "public, max-age=0, must-revalidate";
}
