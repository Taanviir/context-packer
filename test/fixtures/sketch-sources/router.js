// Tiny path router.
const routes = new Map();

/** Registers a handler for a path. */
function route(path, handler) {
  routes.set(path, handler);
}

/**
 * Dispatches a request to its handler.
 */
async function dispatch(request) {
  const handler = routes.get(request.path);
  if (!handler) {
    return { status: 404 };
  }
  return handler(request);
}

class Router {
  constructor() { this.routes = routes; }
  static create() { return new Router(); }
}

var fallback = () => ({ status: 500 })
module.exports = { route, dispatch, Router };
