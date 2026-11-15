export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export function requireSecureCredentialOrigin(request: Request) {
  const url = URL.parse(process.env.NODEGUARD_ORIGIN ?? request.url);
  const local = url && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!url || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new ApiError(403, "SECURE_ORIGIN", "برای ارسال اعتبارنامه از HTTPS یا دسترسی محلی NodeGuard استفاده کنید.");
  }
}

export function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  // no-transform keeps a reverse proxy from compressing or replacing the body.
  // An altered or empty body surfaces in the browser as invalid JSON.
  headers.set("Cache-Control", "no-store, no-transform");
  return Response.json(data, { ...init, headers });
}

export async function jsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new ApiError(415, "CONTENT_TYPE", "درخواست باید JSON باشد.");
  }
  if (!request.body) throw new ApiError(400, "INVALID_JSON", "بدنهٔ درخواست خالی است.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE", "اندازهٔ درخواست بیش از حد مجاز است.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "بدنهٔ JSON معتبر نیست.");
  } finally {
    reader.releaseLock();
  }
}
