'use strict'

/**
 * Module dependencies.
 */

const debug = require('debug')('koa:application')
const assert = require('assert')
const onFinished = require('on-finished')
const response = require('./response')
const compose = require('koa-compose')
const context = require('./context')
const request = require('./request')
const statuses = require('statuses')
const Emitter = require('events')
const util = require('util')
const Stream = require('stream')
const http = require('http')
const only = require('only')
const { HttpError } = require('http-errors')

/** @typedef {typeof import ('./context') & {
 *  app: Application
 *  req: import('http').IncomingMessage
 *  res: import('http').ServerResponse
 *  request: KoaRequest
 *  response: KoaResponse
 *  state: any
 *  originalUrl: string
 * }} Context */

/** @typedef {typeof import('./request')} KoaRequest */

/** @typedef {typeof import('./response')} KoaResponse */

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 */

module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */

  /**
    *
    * @param {object} [options] Application options
    * @param {string} [options.env='development'] Environment
    * @param {string[]} [options.keys] Signed cookie keys
    * @param {boolean} [options.proxy] Trust proxy headers
    * @param {number} [options.subdomainOffset] Subdomain offset
    * @param {string} [options.proxyIpHeader] Proxy IP header, defaults to X-Forwarded-For
    * @param {number} [options.maxIpsCount] Max IPs read from proxy IP header, default to 0 (means infinity)
    *
    */

  constructor (options) {
    super()
    /** 配置 */
    options = options || {}
    /** 是否proxy模式 */
    this.proxy = options.proxy || false
    /** domain要忽略的偏移量 */
    this.subdomainOffset = options.subdomainOffset || 2
    /** proxy自定义头部 */
    this.proxyIpHeader = options.proxyIpHeader || 'X-Forwarded-For'
    /** 代理服务器数量 */
    this.maxIpsCount = options.maxIpsCount || 0
    /** 环境变量 */
    this.env = options.env || process.env.NODE_ENV || 'development'
    /** koa中间件洋葱模型的核心 */
    this.compose = options.compose || compose
    /** 自定义cookie 密钥 */
    if (options.keys) this.keys = options.keys
    /** 中间件数组 */
    this.middleware = []

    // 用Object.create是因为我们在同一个应用中可能会有多个new Koa的app，
    // 为了防止这些app相互污染，用拷贝的方法让其引用不指向同一个地址。

    /** 请求上下文, 对应 context.js */
    this.context = Object.create(context)
    /** 请求对象, 对应 request.js */
    this.request = Object.create(request)
    /** 响应对象, 对应 response.js */
    this.response = Object.create(response)
    // util.inspect.custom support for node 6+
    /* istanbul ignore else */
    /**
     * 自定义检查，这里的作用是get app时，去执行this.inspect 。
     * 感兴趣可见http://nodejs.cn/api/util.html#util_util_inspect_custom
     */
    if (util.inspect.custom) {
      this[util.inspect.custom] = this.inspect
    }
    if (options.asyncLocalStorage) {
      const { AsyncLocalStorage } = require('async_hooks')
      assert(AsyncLocalStorage, 'Requires node 12.17.0 or higher to enable asyncLocalStorage')
      this.ctxStorage = new AsyncLocalStorage()
    }
  }

  /**
   * Shorthand for:
   *
   *    http.createServer(app.callback()).listen(...)
   *
   * @param {Mixed} ...
   * @return {import('http').Server}
   * @api public
   */

  listen (...args) {
    debug('listen')
    const server = http.createServer(this.callback())
    return server.listen(...args)
  }

  /**
   * Return JSON representation.
   * We only bother showing settings.
   *
   * @return {Object}
   * @api public
   */

  toJSON () {
    return only(this, [
      'subdomainOffset',
      'proxy',
      'env'
    ])
  }

  /**
   * Inspect implementation.
   *
   * @return {Object}
   * @api public
   */

  inspect () {
    return this.toJSON()
  }

  /**
   * Use the given middleware `fn`.
   *
   * Old-style middleware will be converted.
   *
   * @param {(context: Context) => Promise<any | void>} fn
   * @return {Application} self
   * @api public
   */

  use (fn) {
    if (typeof fn !== 'function') throw new TypeError('middleware must be a function!')
    debug('use %s', fn._name || fn.name || '-')
    this.middleware.push(fn)
    return this
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * @return {Function}
   * @api public
   */

  callback () {
    const fn = this.compose(this.middleware)

    // koa错误处理，判断app上错误监听的数量，也就是判断是否我们的代码里有自己写监听，
    // 如果没有那么走koa的 this.onerror方法
    if (!this.listenerCount('error')) this.on('error', this.onerror)

    const handleRequest = (req, res) => {
      // 将req, res包装成一个ctx返回
      const ctx = this.createContext(req, res)
      if (!this.ctxStorage) {
        return this.handleRequest(ctx, fn)
      }
      return this.ctxStorage.run(ctx, async () => {
        return await this.handleRequest(ctx, fn)
      })
    }

    return handleRequest
  }

  /**
   * return current context from async local storage
   */
  get currentContext () {
    if (this.ctxStorage) return this.ctxStorage.getStore()
  }

  /**
   * Handle request in callback.
   *
   * @api private
   */

  handleRequest (ctx, fnMiddleware) {
    const res = ctx.res
    res.statusCode = 404
    const onerror = err => ctx.onerror(err)
    const handleResponse = () => respond(ctx)
    // 确保一个流在关闭、完成和报错时都会执行响应的回调函数
    onFinished(res, onerror)
    // 中间件执行、统一错误处理机制的关键
    return fnMiddleware(ctx).then(handleResponse).catch(onerror)
  }

  /**
   * Initialize a new context.
   *
   * 每次http请求都包装出一个全局唯一的context
   * @api private
   */

  createContext (req, res) {
    /** @type {Context} */
    const context = Object.create(this.context)
    /** @type {KoaRequest} */
    const request = context.request = Object.create(this.request)
    /** @type {KoaResponse} */
    const response = context.response = Object.create(this.response)
    context.app = request.app = response.app = this
    context.req = request.req = response.req = req
    context.res = request.res = response.res = res
    request.ctx = response.ctx = context
    request.response = response
    response.request = request
    context.originalUrl = request.originalUrl = req.url
    context.state = {}
    return context
  }

  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

  onerror (err) {
    // When dealing with cross-globals a normal `instanceof` check doesn't work properly.
    // See https://github.com/koajs/koa/issues/1466
    // We can probably remove it once jest fixes https://github.com/facebook/jest/issues/2549.
    const isNativeError =
      Object.prototype.toString.call(err) === '[object Error]' ||
      err instanceof Error
    if (!isNativeError) throw new TypeError(util.format('non-error thrown: %j', err))

    if (err.status === 404 || err.expose) return
    if (this.silent) return

    const msg = err.stack || err.toString()
    console.error(`\n${msg.replace(/^/gm, '  ')}\n`)

    // 对于中间件内的异步错误，koa是无法捕捉的(除非转同步)。
    // 我们的应用如果需要记录这个错误可以用node的process监听
    // process.on("unhandledRejection", (err) => {
    //   console.log(err);
    // });
  }

  /**
   * Help TS users comply to CommonJS, ESM, bundler mismatch.
   * @see https://github.com/koajs/koa/issues/1513
   */

  static get default () {
    return Application
  }

  createAsyncCtxStorageMiddleware () {
    const app = this
    return async function asyncCtxStorage (ctx, next) {
      await app.ctxStorage.run(ctx, async () => {
        return await next()
      })
    }
  }
}

/**
 * Response helper.
 */

function respond (ctx) {
  // allow bypassing koa
  if (ctx.respond === false) return

  if (!ctx.writable) return

  const res = ctx.res
  let body = ctx.body
  const code = ctx.status

  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null
    return res.end()
  }

  if (ctx.method === 'HEAD') {
    if (!res.headersSent && !ctx.response.has('Content-Length')) {
      const { length } = ctx.response
      if (Number.isInteger(length)) ctx.length = length
    }
    return res.end()
  }

  // status body
  if (body == null) {
    if (ctx.response._explicitNullBody) {
      ctx.response.remove('Content-Type')
      ctx.response.remove('Transfer-Encoding')
      ctx.length = 0
      return res.end()
    }
    if (ctx.req.httpVersionMajor >= 2) {
      body = String(code)
    } else {
      body = ctx.message || String(code)
    }
    if (!res.headersSent) {
      ctx.type = 'text'
      ctx.length = Buffer.byteLength(body)
    }
    return res.end(body)
  }

  // responses
  if (Buffer.isBuffer(body)) return res.end(body)
  if (typeof body === 'string') return res.end(body)
  if (body instanceof Stream) return body.pipe(res)

  // body: json
  body = JSON.stringify(body)
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body)
  }
  res.end(body)
}

/**
 * Make HttpError available to consumers of the library so that consumers don't
 * have a direct dependency upon `http-errors`
 */

module.exports.HttpError = HttpError
