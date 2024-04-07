'use strict'

/**
 * Module dependencies.
 */

const util = require('util')
const createError = require('http-errors')
const httpAssert = require('http-assert')
const delegate = require('delegates')
const statuses = require('statuses')
const Cookies = require('cookies')

const COOKIES = Symbol('context#cookies')

/**
 * Context prototype.
 */

const proto = module.exports = {

  /**
   * util.inspect() implementation, which
   * just returns the JSON output.
   *
   * @return {Object}
   * @api public
   */

  inspect () {
    if (this === proto) return this
    return this.toJSON()
  },

  /**
   * Return JSON representation.
   *
   * Here we explicitly invoke .toJSON() on each
   * object, as iteration will otherwise fail due
   * to the getters and cause utilities such as
   * clone() to fail.
   *
   * @return {Object}
   * @api public
   */

  toJSON () {
    return {
      request: this.request.toJSON(),
      response: this.response.toJSON(),
      app: this.app.toJSON(),
      originalUrl: this.originalUrl,
      req: '<original node req>',
      res: '<original node res>',
      socket: '<original node socket>'
    }
  },

  /**
   * Similar to .throw(), adds assertion.
   *
   *    this.assert(this.user, 401, 'Please login!');
   *
   * See: https://github.com/jshttp/http-assert
   *
   * @param {Mixed} test
   * @param {Number} status
   * @param {String} message
   * @api public
   */

  assert: httpAssert,

  /**
   * Throw an error with `status` (default 500) and
   * `msg`. Note that these are user-level
   * errors, and the message may be exposed to the client.
   *
   *    this.throw(403)
   *    this.throw(400, 'name required')
   *    this.throw('something exploded')
   *    this.throw(new Error('invalid'))
   *    this.throw(400, new Error('invalid'))
   *
   * See: https://github.com/jshttp/http-errors
   *
   * Note: `status` should only be passed as the first parameter.
   *
   * @param {String|Number|Error} err, msg or status
   * @param {String|Number|Error} [err, msg or status]
   * @param {Object} [props]
   * @api public
   */

  throw (...args) {
    throw createError(...args)
  },

  /**
   * Default error handling.
   *
   * @param {Error} err
   * @api private
   */

  onerror (err) {
    // don't do anything if there is no error.
    // this allows you to pass `this.onerror`
    // to node-style callbacks.
    if (err == null) return

    // When dealing with cross-globals a normal `instanceof` check doesn't work properly.
    // See https://github.com/koajs/koa/issues/1466
    // We can probably remove it once jest fixes https://github.com/facebook/jest/issues/2549.
    // 判断是否为原生错误
    const isNativeError =
      Object.prototype.toString.call(err) === '[object Error]' ||
      err instanceof Error
    if (!isNativeError) err = new Error(util.format('non-error thrown: %j', err))

    let headerSent = false
    // 检查是否已经发送了一个响应头
    if (this.headerSent || !this.writable) {
      headerSent = err.headerSent = true
    }

    // delegate
    // emit 这个错误，而刚刚我们看到application上有监听器。app.on('error',onerror) ，
    // 转交给application的onerror处理。
    // 这里可以做到emit、on来发布订阅错误就是因为application继承了Emitter模块。
    this.app.emit('error', err, this)

    // nothing we can do here other
    // than delegate to the app-level
    // handler and log.
    // 已经发送了一个响应头，return掉
    if (headerSent) {
      return
    }

    const { res } = this

    // first unset all headers
    /* istanbul ignore else */
    // HeaderNames为function，删除所有Header
    if (typeof res.getHeaderNames === 'function') {
      res.getHeaderNames().forEach(name => res.removeHeader(name))
    } else {
      res._headers = {} // Node < 7.7
    }

    // then set those specified
    // 下面的就是对这个错误的ctx进行修改。如header设置成err.headers、statusCode设置成err.status ，
    // msg设置为如err.message等等
    this.set(err.headers)

    // force text/plain
    this.type = 'text'

    let statusCode = err.status || err.statusCode

    // ENOENT support
    if (err.code === 'ENOENT') statusCode = 404

    // default to 500
    if (typeof statusCode !== 'number' || !statuses[statusCode]) statusCode = 500

    // respond
    const code = statuses[statusCode]
    const msg = err.expose ? err.message : code
    this.status = err.status = statusCode
    this.length = Buffer.byteLength(msg)
    res.end(msg)
  },

  get cookies () {
    if (!this[COOKIES]) {
      this[COOKIES] = new Cookies(this.req, this.res, {
        keys: this.app.keys,
        secure: this.request.secure
      })
    }
    return this[COOKIES]
  },

  set cookies (_cookies) {
    this[COOKIES] = _cookies
  }
}

/**
 * Custom inspection implementation for newer Node.js versions.
 *
 * @return {Object}
 * @api public
 */

/* istanbul ignore else */
if (util.inspect.custom) {
  module.exports[util.inspect.custom] = module.exports.inspect
}

/**
 * Response delegation.
 */

//  在application.createContext函数中，
//  被创建的context对象会挂载基于request.js实现的request对象和基于response.js实现的response对象。
//  下面2个delegate的作用是让context对象代理request和response的部分属性和方法
delegate(proto, 'response')
  .method('attachment')
  .method('redirect')
  .method('remove')
  .method('vary')
  .method('has')
  .method('set')
  .method('append')
  .method('flushHeaders')
  .access('status')
  .access('message')
  .access('body')
  .access('length')
  .access('type')
  .access('lastModified')
  .access('etag')
  .getter('headerSent')
  .getter('writable')

/**
 * Request delegation.
 */

delegate(proto, 'request')
  .method('acceptsLanguages')
  .method('acceptsEncodings')
  .method('acceptsCharsets')
  .method('accepts')
  .method('get')
  .method('is')
  .access('querystring')
  .access('idempotent')
  .access('socket')
  .access('search')
  .access('method')
  .access('query')
  .access('path')
  .access('url')
  .access('accept')
  .getter('origin')
  .getter('href')
  .getter('subdomains')
  .getter('protocol')
  .getter('host')
  .getter('hostname')
  .getter('URL')
  .getter('header')
  .getter('headers')
  .getter('secure')
  .getter('stale')
  .getter('fresh')
  .getter('ips')
  .getter('ip')
