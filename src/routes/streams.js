import { Hono } from 'hono'
import crypto from 'crypto'
import { Stream } from '../models/Stream.js'

const streams = new Hono()

// Create a stream and issue a streamKey
streams.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { userId, publicStreamName, title } = body || {}

    console.log('📺 [Streams] POST /api/streams:', { userId, publicStreamName, title })

    if (!userId || !publicStreamName) {
      console.log('📺 [Streams] Missing required fields')
      return c.json({ error: 'userId and publicStreamName are required' }, 400)
    }

    // Ensure uniqueness for publicStreamName
    const exists = await Stream.findOne({ publicStreamName })
    if (exists) {
      console.log('📺 [Streams] Stream already exists:', exists._id)
      return c.json({ error: 'publicStreamName already exists' }, 409)
    }

    const streamKey = crypto.randomBytes(24).toString('hex')

    const doc = await Stream.create({
      userId,
      publicStreamName,
      title: title || '',
      streamKey,
      isLive: false,
    })

    console.log('📺 [Streams] Stream created:', { id: doc._id, userId: doc.userId, publicStreamName: doc.publicStreamName })

    return c.json({
      id: doc._id,
      userId: doc.userId,
      publicStreamName: doc.publicStreamName,
      title: doc.title,
      createdAt: doc.createdAt,
      // Return masked key and RTMP hints
      streamKey: `${doc.streamKey.slice(0, 4)}********${doc.streamKey.slice(-4)}`,
      rtmp: {
        url: process.env.RTMP_INGEST_URL || 'rtmp://localhost/live',
        streamKey: doc.streamKey,
      }
    }, 201)
  } catch (err) {
    console.error('📺 [Streams] create stream error:', err)
    return c.text('Server error', 500)
  }
})

// Get stream (by public name)
streams.get('/:publicStreamName', async (c) => {
  try {
    const { publicStreamName } = c.req.param()
    console.log('📺 [Streams] GET /api/streams/:publicStreamName:', publicStreamName)
    
    const doc = await Stream.findOne({ publicStreamName }).lean()
    if (!doc) {
      console.log('📺 [Streams] Stream not found')
      return c.text('Not found', 404)
    }
    
    console.log('📺 [Streams] Stream found:', { userId: doc.userId, isLive: doc.isLive })
    return c.json({
      userId: doc.userId,
      publicStreamName: doc.publicStreamName,
      title: doc.title,
      isLive: doc.isLive,
      startTime: doc.startTime,
      endTime: doc.endTime,
      viewerCount: doc.viewerCount,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    })
  } catch (err) {
    console.error('📺 [Streams] get stream error:', err)
    return c.text('Server error', 500)
  }
})

export default streams
