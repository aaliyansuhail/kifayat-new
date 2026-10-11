/**
 * Maintenance mode middleware.
 *
 * Cloudflare Pages evaluates `_redirects` rules on EVERY request, and a rule
 * like `/* /maintenance.html 302` loops forever: the redirect target
 * `/maintenance.html` matches `/*` again, so the browser never settles
 * (ERR_TOO_MANY_REDIRECTS). A `_redirects` rule cannot express "everything
 * EXCEPT /maintenance.html", so the redirect must live here in a Function,
 * where we can skip the maintenance page itself.
 *
 * Behavior:
 *   - All requests except /maintenance.html -> 302 redirect to /maintenance.html
 *   - /maintenance.html is served as a normal static asset (ctx.next())
 *   - During maintenance, API/socket.io requests are ALSO redirected
 *     (the whole site is down). When maintenance is OFF, normal routing
 *     resumes: Functions handle /api/* and /socket.io/* first, then static
 *     assets, then the SPA fallback.
 *
 * To turn maintenance OFF, set MAINTENANCE_ENABLED=false in the Cloudflare
 * Pages dashboard (Settings -> Environment Variables), or edit this file to
 * `return ctx.next()` unconditionally and redeploy.
 */
export default {
  async onRequest(request, env, ctx) {
    const url = new URL(request.url);

    // Serve the maintenance page asset directly — never redirect it to itself.
    if (url.pathname === '/maintenance.html') {
      return ctx.next();
    }

    // Maintenance mode is ON by default so the redirect takes effect
    // immediately after this deploy. Turn it OFF without a deploy by setting
    // MAINTENANCE_ENABLED=false in the Pages dashboard, or by editing this file.
    if (env.MAINTENANCE_ENABLED === 'false') {
      return ctx.next();
    }

    return new Response.redirect('/maintenance.html', 302);
  },
};