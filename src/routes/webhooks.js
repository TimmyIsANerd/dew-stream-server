import { Hono } from 'hono'
import { Stream } from '../models/Stream.js'

const webhooks = new Hono()

function isAuthorizedHook(c) {
  const configured = process.env.RTMP_HOOK_SECRET
  if (!configured) return true
  const provided = c.req.query('secret') || c.req.header('x-hook-secret')
  return provided && provided === configured
}

// Nginx-RTMP on_publish webhook
webhooks.post('/publish', async (c) => {
  try {
    if (!isAuthorizedHook(c)) {
      return c.text('Forbidden', 403)
    }

    const body = await c.req.parseBody()
    const name = (body.name || body.stream || body.key || '').toString()
    const app = (body.app || 'live').toString()
    const addr = (body.addr || '').toString()

    if (!name) return c.text('Missing stream name', 400)

// Only allow if stream exists and is not already live
    const stream = await Stream.findOneAndUpdate(
      { streamKey: name, isLive: { $ne: true } },
      {
        isLive: true,
        startTime: new Date(),
        endTime: null,
        viewerCount: 0,
        app,
        lastClientAddr: addr || null,
      },
      { new: true }
    )

    if (!stream) return c.text('Forbidden', 403)

    return c.redirect(`/live/${encodeURIComponent(stream.publicStreamName)}`, 302)
  } catch (err) {
    console.error('on_publish error:', err)
    return c.text('Server error', 500)
  }
})

// Nginx-RTMP on_publish_done webhook
webhooks.post('/publish_done', async (c) => {
  try {
    if (!isAuthorizedHook(c)) {
      return c.text('Forbidden', 403)
    }

    const body = await c.req.parseBody()
    const name = (body.name || body.stream || body.key || '').toString()

    if (!name) return c.text('Missing stream name', 400)

    await Stream.findOneAndUpdate(
      { streamKey: name },
      {
        isLive: false,
        endTime: new Date(),
      }
    )

    return c.text('OK', 200)
  } catch (err) {
    console.error('on_publish_done error:', err)
    return c.text('Server error', 500)
  }
})

export default webhooks
