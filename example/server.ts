import page from "./index.html";

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  routes: {
    "/": (request) => Response.redirect(new URL("/spaces", request.url), 302),
    "/spaces": (request) =>
      Response.redirect(new URL(`/spaces/${crypto.randomUUID()}`, request.url), 302),
    "/spaces/:id": page,
  },
  development: { hmr: true, console: true },
});

console.log(`DOM CRDT demo: ${server.url}`);
