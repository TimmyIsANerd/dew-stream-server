import { Hono } from 'hono'
import { Stream } from '../models/Stream.js'

const status = new Hono()

// GET /api/status/:publicStreamName
status.get('/:publicStreamName', async (c) => {
  try {
    const { publicStreamName } = c.req.param()
    if (!publicStreamName) return c.text('Missing stream name', 400)

    const stream = await Stream.findOne({ publicStreamName }).lean()
    if (!stream) return c.text('Not found', 404)

    return c.json({
      userId: stream.userId,
      publicStreamName: stream.publicStreamName,
      title: stream.title,
      isLive: stream.isLive,
      startTime: stream.startTime,
      endTime: stream.endTime,
      viewerCount: stream.viewerCount,
      updatedAt: stream.updatedAt,
    })
  } catch (err) {
    console.error('status error:', err)
    return c.text('Server error', 500)
  }
})

export default status
