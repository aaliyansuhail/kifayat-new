const DEFAULT_BACKEND_ORIGIN = "https://p01--kifayat-backend--62p9lfb7xpvc.code.run";

function backendOrigin(env: Record<string, unknown>): string {
  const configured = typeof env.BACKEND_ORIGIN === "string" ? env.BACKEND_ORIGIN : DEFAULT_BACKEND_ORIGIN;
  return configured.replace(/\/+$/, "");
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (key !== "host" && key !== "content-length") headers.set(key, value);
  });
  return headers;
}

export async function proxyToBackend(request: Request, env: Record<string, unknown>): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(`${backendOrigin(env)}${incoming.pathname}`);
  target.search = incoming.search;

  const headers = forwardedHeaders(request);
  headers.set("cache-control", "no-store");

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  try {
    const response = await fetch(target, init);
    const outputHeaders = new Headers(response.headers);
    outputHeaders.set("cache-control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outputHeaders,
    });
  } catch {
    return Response.json(
      { success: false, message: "Backend is temporarily unavailable" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
