export function request(app: { fetch(request: Request): Response | Promise<Response> }, path: string, init?: RequestInit) {
  return app.fetch(new Request(new URL(path, 'https://gateway.invalid'), init))
}
