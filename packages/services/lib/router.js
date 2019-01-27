/* jshint esversion: 6, node: true */

'use strict';

const {Server} = require('./call');
const {Channel, Trace} = require('./channel');
const {Service} = require('./service');
const {SystemError} = require('./utils');

const backoff = require('backoff');
const debug = require('debug');
const {EventEmitter} = require('events');

const d = debug('@avro/services:router');

class Router extends EventEmitter {
  constructor(svcs, chan) {
    if (!svcs || !svcs.length) {
      throw new Error('no services');
    }
    if (!Channel.isChannel(chan)) {
      throw new Error(`not a channel: ${chan}`);
    }
    super();
    this.closed = false;
    this.services = svcs;
    this.channel = new Channel((trace, preq, cb) => {
      if (this.closed) {
        cb(routerClosedError());
        return;
      }
      chan.call(trace, preq, cb);
    });
  }

  close() {
    if (this.closed) {
      return;
    }
    d('Closing router.');
    this.closed = true;
    this.emit('close');
  }

  static forChannel(chan, svcs) {
    const serviceNames = new Set();
    for (const svc of svcs) {
      serviceNames.add(svc.name); // Speed up later routing check.
    }
    const routingChan = new Channel((trace, preq, cb) => {
      const clientSvc = preq.service;
      if (!isRoutable(clientSvc, serviceNames)) {
        cb(serviceNotFoundError(clientSvc));
        return;
      }
      chan.call(trace, preq, cb);
    });
    return new Router(svcs, routingChan);
  }

  static forServers(...servers) {
    if (!servers || !servers.length) {
      throw new Error('no servers');
    }
    const routers = [];
    for (const server of servers) {
      if (!Server.isServer(server)) {
        throw new Error(`not a server: ${server}`);
      }
      routers.push(Router.forChannel(server.channel, [server.service]));
    }
    return routers.length === 1 ? routers[0] : Router.forRouters(...routers);
  }

  static forRouters(...routers) {
    const routerMap = new Map();
    const svcs = [];
    let upstream;
    for (const downstream of routers) {
      if (downstream.closed) {
        throw new Error('router is already closed');
      }
      downstream.on('close', onClose);
      for (const svc of downstream.services) {
        if (routerMap.has(svc.name)) {
          throw new Error(`duplicate service name: ${svc.name}`);
        }
        routerMap.set(svc.name, downstream);
        svcs.push(svc);
      }
    }
    const chan = new Channel((trace, preq, cb) => {
      const clientSvc = preq.service;
      const names = routingNames(clientSvc);
      let downstream;
      for (const name of names) {
        const candidate = routerMap.get(name);
        if (candidate) {
          if (downstream) {
            const cause = new Error(`ambiguous service aliases: ${names}`);
            cb(new SystemError('ERR_AVRO_AMBIGUOUS_SERVICE'));
            return;
          }
          downstream = candidate;
        }
      }
      if (!downstream) {
        cb(serviceNotFoundError(preq.service));
        return;
      }
      downstream.channel.call(trace, preq, cb);
    });
    const downstreamRouters = Array.from(routerMap.values());
    upstream = new DispatchingRouter(svcs, chan, downstreamRouters);
    return upstream;

    function onClose() {
      upstream.close();
      for (const downstream of routerMap.values()) {
        downstream.removeListener('close', onClose);
      }
    }
  }

  // TODO: Add `queueBackoff` option.
  static selfRefreshing(provider, opts, cb) {
    if (!cb && typeof opts == 'function') {
      cb = opts;
      opts = undefined;
    }
    ((opts && opts.refreshBackoff) || backoff.fibonacci())
      .on('ready', function () {
        provider((err, router, ...args) => {
          if (err) {
            d('Error opening router: %s', err);
            process.nextTick(() => { this.backoff(); });
            return;
          }
          cb(null, new SelfRefreshingRouter(router, args, provider, opts));
        });
      })
      .on('fail', () => {
        cb(new Error('unable to open router'));
      })
      .backoff();
  }
}

class DispatchingRouter extends Router {
  constructor(svcs, chan, downstreamRouters) {
    super(svcs, chan);
    this.downstreamRouters = downstreamRouters;
  }
}

class SelfRefreshingRouter extends Router {
  constructor(router, args, provider, opts) {
    opts = opts || {};
    super(router.services, new Channel((trace, preq, cb) => {
      if (this._activeRouter) {
        this._activeRouter.channel.call(trace, preq, cb);
        return;
      }
      const id = preq.id;
      const cleanup = trace.onceInactive(() => {
        this._pendingCalls.delete(id);
      });
      const retry = (err) => {
        cleanup();
        this._pendingCalls.delete(id);
        if (err) {
          cb(err);
          return;
        }
        this.channel.call(trace, preq, cb); // Try again.
      };
      this._pendingCalls.set(id, retry);
      this.emit('queue', this._pendingCalls.size, retry);
    }));

    this._routerProvider = provider;
    this._activeRouter = null; // Activated below.
    this._pendingCalls = new Map();
    this._refreshAttempts = 0;
    this._refreshBackoff = (opts.refreshBackoff || backoff.fibonacci())
      .on('backoff', (num, delay) => {
        d('Scheduling refresh in %sms.', delay);
        this._refreshAttempts++;
      })
      .on('ready', () => {
        d('Starting refresh attempt #%s...', this._refreshAttempts);
        this._refreshRouter();
      })
      .on('fail', () => {
        d('Exhausted refresh attempts, giving up.');
        this.emit('error', new Error('exhausted refresh attempts'));
      });

    this.once('close', () => {
      if (this._activeRouter) {
        this._activeRouter.close();
      }
      for (const cb of this._pendingCalls.values()) {
        cb();
      }
    });
    this._activateRouter(router, args);
  }

  _refreshRouter() {
    if (this._activeRouter) {
      throw new Error('router already active');
    }
    this._routerProvider((err, router, ...args) => {
      if (err) {
        d('Error while opening router: %s', err);
        if (!this.closed) {
          this._refreshBackoff.backoff();
        }
        return;
      }
      if (this.closed) {
        router.close();
        return;
      }
      this._refreshAttempts = 0;
      this._refreshBackoff.reset();
      this._activateRouter(router, args);
    });
  }

  _activateRouter(router, args) {
    this._activeRouter = router
      .on('error', (err) => { this.emit('error', err); })
      .once('close', () => {
        this._activeRouter = null;
        this.emit('down', ...args);
        if (!this.closed) {
          this._refreshRouter();
        }
      });
    d('Self-refreshing router active.');
    this.emit('up', ...args);
    for (const cb of this._pendingCalls.values()) {
      cb();
    }
  }
}

function routerClosedError() {
  return new SystemError('ERR_AVRO_ROUTER_CLOSED');
}

function serviceNotFoundError(svc) {
  const cause = new Error(`no route for service ${svc.name}`);
  return new SystemError('ERR_AVRO_SERVICE_NOT_FOUND', cause);
}

function routingNames(svc) {
  const keys = [svc.name];
  const aliases = svc.protocol.aliases;
  if (aliases) {
    for (const alias in aliases) {
      keys.push(alias);
    }
  }
  return keys;
}

function isRoutable(clientSvc, svcNames) {
  for (const name of routingNames(clientSvc)) {
    if (svcNames.has(name)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  Router,
};