'use strict'

const { test } = require('node:test')
const http = require('node:http')
const Fastify = require('fastify')
const { request, Agent } = require('undici')
const From = require('..')
const FakeTimers = require('@sinonjs/fake-timers')

test('http request timeout', async (t) => {
  const clock = FakeTimers.createClock()
  const target = Fastify()
  t.after(() => target.close())

  target.get('/', (_request, reply) => {
    t.assert.ok('request arrives')

    setTimeout(() => {
      reply.status(200).send('hello world')
    }, 200)

    clock.tick(200)
  })

  await target.listen({ port: 0 })

  const instance = Fastify()
  t.after(() => instance.close())

  instance.register(From, { http: { requestOptions: { timeout: 100 } } })

  instance.get('/', (_request, reply) => {
    reply.from(`http://localhost:${target.server.address().port}/`)
  })

  await instance.listen({ port: 0 })

  const result = await request(`http://localhost:${instance.server.address().port}/`, {
    dispatcher: new Agent({
      pipelining: 0
    })
  })

  t.assert.strictEqual(result.statusCode, 504)
  t.assert.match(result.headers['content-type'], /application\/json/)
  t.assert.deepStrictEqual(await result.body.json(), {
    statusCode: 504,
    code: 'FST_REPLY_FROM_GATEWAY_TIMEOUT',
    error: 'Gateway Timeout',
    message: 'Gateway Timeout'
  })
  clock.tick(200)
})

test('http request with specific timeout', async (t) => {
  const clock = FakeTimers.createClock()
  const target = Fastify()
  t.after(() => target.close())

  target.get('/', (_request, reply) => {
    t.assert.ok('request arrives')

    setTimeout(() => {
      reply.status(200).send('hello world')
    }, 200)

    clock.tick(200)
  })

  await target.listen({ port: 0 })

  const instance = Fastify()
  t.after(() => instance.close())

  instance.register(From, { http: { requestOptions: { timeout: 100 } } })

  instance.get('/success', (_request, reply) => {
    reply.from(`http://localhost:${target.server.address().port}/`, {
      timeout: 300
    })
  })
  instance.get('/fail', (_request, reply) => {
    reply.from(`http://localhost:${target.server.address().port}/`, {
      timeout: 50
    })
  })

  await instance.listen({ port: 0 })
  const result = await request(`http://localhost:${instance.server.address().port}/success`, {
    dispatcher: new Agent({
      pipelining: 0
    })
  })
  t.assert.strictEqual(result.statusCode, 200)

  const result2 = await request(`http://localhost:${instance.server.address().port}/fail`, {
    dispatcher: new Agent({
      pipelining: 0
    })
  })

  t.assert.strictEqual(result2.statusCode, 504)
  t.assert.match(result2.headers['content-type'], /application\/json/)
  t.assert.deepStrictEqual(await result2.body.json(), {
    statusCode: 504,
    code: 'FST_REPLY_FROM_GATEWAY_TIMEOUT',
    error: 'Gateway Timeout',
    message: 'Gateway Timeout'
  })
})

test('http sse removes timeout test', async (t) => {
  const target = Fastify()
  t.after(() => target.close())

  target.get('/', (_request, reply) => {
    t.assert.ok('request arrives')

    reply.header('content-type', 'text/event-stream').status(200).send('hello world')
  })

  await target.listen({ port: 0 })

  const instance = Fastify()
  t.after(() => instance.close())

  instance.register(From, { http: { requestOptions: { timeout: 100 } } })

  instance.get('/', (_request, reply) => {
    reply.from(`http://localhost:${target.server.address().port}/`)
  })

  await instance.listen({ port: 0 })

  const { statusCode } = await request(`http://localhost:${instance.server.address().port}/`, {
    dispatcher: new Agent({
      pipelining: 0
    })
  })
  t.assert.strictEqual(statusCode, 200)
})

test('http sse removes timeout when content-type has parameters', async (t) => {
  // A media type is case-insensitive and may carry parameters (RFC 9110 §8.3.1).
  // `text/event-stream; charset=utf-8` is what Starlette's EventSourceResponse
  // and Spring emit, and it must be treated as SSE just the same.
  const target = http.createServer((_req, res) => {
    t.assert.ok('request arrives')

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write('data: first\n\n')

    // An SSE stream is idle between events. Stay quiet for longer than the
    // proxy's socket timeout, which is exactly what the timeout must not cut.
    setTimeout(() => res.end('data: last\n\n'), 2000)
  })
  t.after(() => target.close())

  await new Promise(resolve => target.listen({ port: 0 }, resolve))

  const instance = Fastify()
  t.after(() => instance.close())

  // Same headroom as the http2 sibling: the timeout has to survive connecting
  // plus the first response on a loaded runner, and the quiet period above has
  // to outlast the timeout.
  instance.register(From, { http: { requestOptions: { timeout: 1000 } } })

  instance.get('/', (_request, reply) => {
    reply.from(`http://localhost:${target.address().port}/`)
  })

  await instance.listen({ port: 0 })

  const { statusCode, body } = await request(`http://localhost:${instance.server.address().port}/`, {
    dispatcher: new Agent({
      pipelining: 0
    })
  })
  t.assert.strictEqual(statusCode, 200)

  let received = ''
  let streamError = null
  try {
    for await (const chunk of body) {
      received += chunk
    }
  } catch (err) {
    streamError = err
  }

  t.assert.strictEqual(streamError, null, 'the proxied SSE stream must not be aborted')
  t.assert.strictEqual(received, 'data: first\n\ndata: last\n\n')
})
