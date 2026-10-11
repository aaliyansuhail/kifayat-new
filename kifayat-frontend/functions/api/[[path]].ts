import { proxyToBackend } from "../_backend";

export const onRequest = ({ request, env }: { request: Request; env: Record<string, unknown> }) =>
  proxyToBackend(request, env);
