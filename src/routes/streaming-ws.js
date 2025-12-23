import { Hono } from 'hono'
import { WebSocketServer } from 'ws'
import { Stream } from '../models/Stream.js'

// Rooms: tokenAddress => { publisher: WebSocket | null, viewers: Map<viewerId, WebSocket> }
const rooms = new Map()

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const params = Object.fromEntries(url.searchParams.entries())
  return { pathname: url.pathname, params }
}

let wss = null

function initializeStreamingWebSocketServer(server) {
  wss = new WebSocketServer({ server, path: '/ws/stream' })

  wss.on('connection', async (ws, req) => {
    const { params } = parseUrl(req)
    const tokenAddress = (params.tokenAddress || '').toLowerCase()
    const isCreator = params.isCreator === 'true' || params.role === 'publisher'
    const userAddress = (params.userAddress || '').toLowerCase()

    console.log('🔌 [WS] New connection:', { tokenAddress, isCreator, userAddress })

    if (!tokenAddress) {
      console.log('🔌 [WS] Closing: Missing tokenAddress')
      ws.close(1008, 'Missing tokenAddress')
      return
    }

    // Gate: Only allow publisher if userAddress matches stream.userId
    if (isCreator) {
      if (!userAddress) {
        console.log('🔌 [WS] Closing: Missing userAddress for creator')
        ws.close(1008, 'Missing userAddress')
        return
      }
      try {
        const stream = await Stream.findOne({ publicStreamName: tokenAddress }).lean()
        console.log('🔌 [WS] Stream lookup result:', stream ? { userId: stream.userId, publicStreamName: stream.publicStreamName } : 'not found')
        
        if (!stream) {
          console.log('🔌 [WS] Closing: Stream not registered')
          ws.close(1008, 'Stream not registered')
          return
        }
        if ((stream.userId || '').toLowerCase() !== userAddress) {
          console.log('🔌 [WS] Closing: Not authorized publisher', { streamUserId: stream.userId, userAddress })
          ws.close(1008, 'Not authorized publisher')
          return
        }
        console.log('🔌 [WS] Publisher authorized successfully')
      } catch (e) {
        console.error('🔌 [WS] Auth check failed:', e)
        ws.close(1011, 'Auth check failed')
        return
      }
    }

    // Attach metadata on socket
    ws.meta = { tokenAddress, role: isCreator ? 'publisher' : 'viewer', viewerId: null }

    // Ensure room exists
    if (!rooms.has(tokenAddress)) {
      rooms.set(tokenAddress, { publisher: null, viewers: new Map() })
    }
    const room = rooms.get(tokenAddress)

    if (isCreator) {
      if (room.publisher && room.publisher.readyState === 1) {
        ws.close(1013, 'Publisher already connected')
        return
      }
      room.publisher = ws
      
      // Update stream to isLive: true in database
      try {
        await Stream.findOneAndUpdate(
          { publicStreamName: tokenAddress },
          { isLive: true, startTime: new Date(), viewerCount: room.viewers.size }
        )
        console.log('🔌 [WS] Stream set to LIVE:', tokenAddress)
      } catch (e) {
        console.error('🔌 [WS] Failed to update stream status:', e)
      }
      
      // Send initial viewer count to publisher
      try { ws.send(JSON.stringify({ type: 'viewer-count', count: room.viewers.size })) } catch {}
      
      // If there are existing viewers waiting, request offers for them
      for (const [existingViewerId, viewerWs] of room.viewers.entries()) {
        if (viewerWs.readyState === 1) {
          console.log('🔌 [WS] Requesting offer for waiting viewer:', existingViewerId)
          try { ws.send(JSON.stringify({ type: 'request-offer', viewerId: existingViewerId })) } catch {}
        }
      }
    } else {
      // Assign a viewerId and notify both sides
      const viewerId = genId()
      ws.meta.viewerId = viewerId
      room.viewers.set(viewerId, ws)

      // Update viewer count in database
      const currentViewerCount = room.viewers.size
      try {
        await Stream.findOneAndUpdate(
          { publicStreamName: tokenAddress },
          { viewerCount: currentViewerCount }
        )
      } catch (e) {
        console.error('🔌 [WS] Failed to update viewer count:', e)
      }

      // Tell viewer their id AND the current viewer count
      try { 
        ws.send(JSON.stringify({ type: 'viewer-id', viewerId }))
        ws.send(JSON.stringify({ type: 'viewer-count', count: currentViewerCount }))
      } catch {}
      
      // Broadcast updated viewer count to publisher and other viewers
      const countMsg = JSON.stringify({ type: 'viewer-count', count: currentViewerCount })
      try {
        if (room.publisher && room.publisher.readyState === 1) {
          room.publisher.send(countMsg)
        }
      } catch {}
      for (const v of room.viewers.values()) {
        if (v !== ws && v.readyState === 1) {
          try { v.send(countMsg) } catch {}
        }
      }
      
      // Ask publisher to create offer for this viewer (with retry mechanism)
      const requestOfferFromPublisher = (attempt = 1) => {
        if (room.publisher && room.publisher.readyState === 1) {
          console.log('🔌 [WS] Requesting offer for viewer:', viewerId, 'attempt:', attempt)
          try {
            room.publisher.send(JSON.stringify({ type: 'request-offer', viewerId }))
          } catch (e) {
            console.error('🔌 [WS] Failed to send request-offer:', e)
          }
        } else if (attempt < 3) {
          // Retry after a short delay (publisher might be connecting)
          console.log('🔌 [WS] Publisher not ready, retrying in 1s... attempt:', attempt)
          setTimeout(() => requestOfferFromPublisher(attempt + 1), 1000)
        } else {
          // No publisher after retries
          console.log('🔌 [WS] No publisher available after retries')
          try {
            ws.send(JSON.stringify({ type: 'error', message: 'Publisher not available' }))
            ws.send(JSON.stringify({ type: 'publisher-not-live' }))
          } catch {}
        }
      }
      
      requestOfferFromPublisher()
    }

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      const { type } = msg
      const currentRoom = rooms.get(tokenAddress)
      if (!currentRoom) return

      // Route signaling by type
      switch (type) {
        case 'offer': {
          // from publisher -> specific viewer
          const { viewerId, offer } = msg
          const viewer = currentRoom.viewers.get(viewerId)
          if (viewer && viewer.readyState === 1) {
            viewer.send(JSON.stringify({ type: 'offer', offer, viewerId }))
          }
          break
        }
        case 'answer': {
          // from viewer -> publisher
          const { viewerId, answer } = msg
          const pub = currentRoom.publisher
          if (pub && pub.readyState === 1) {
            pub.send(JSON.stringify({ type: 'answer', answer, viewerId }))
          }
          break
        }
        case 'ice-candidate': {
          const { viewerId, candidate, from } = msg // from: 'viewer' | 'publisher'
          if (from === 'viewer') {
            const pub = currentRoom.publisher
            if (pub && pub.readyState === 1) {
              pub.send(JSON.stringify({ type: 'ice-candidate', viewerId, candidate }))
            }
          } else {
            const viewer = currentRoom.viewers.get(viewerId)
            if (viewer && viewer.readyState === 1) {
              viewer.send(JSON.stringify({ type: 'ice-candidate', viewerId, candidate }))
            }
          }
          break
        }
      }
    })

    ws.on('close', async () => {
      const room = rooms.get(tokenAddress)
      if (!room) return

      if (ws.meta.role === 'publisher') {
        // Update stream to isLive: false in database
        try {
          await Stream.findOneAndUpdate(
            { publicStreamName: tokenAddress },
            { isLive: false, endTime: new Date(), viewerCount: 0 }
          )
          console.log('🔌 [WS] Stream set to OFFLINE:', tokenAddress)
        } catch (e) {
          console.error('🔌 [WS] Failed to update stream status:', e)
        }
        
        // End all viewers
        for (const [vid, vws] of room.viewers.entries()) {
          try { vws.send(JSON.stringify({ type: 'publisher-ended' })) } catch {}
          try { vws.close(1001, 'Publisher disconnected') } catch {}
        }
        room.viewers.clear()
        room.publisher = null
      } else {
        // Remove viewer and notify publisher
        const viewerId = ws.meta.viewerId
        if (viewerId) room.viewers.delete(viewerId)
        if (room.publisher && room.publisher.readyState === 1 && viewerId) {
          try { room.publisher.send(JSON.stringify({ type: 'viewer-left', viewerId })) } catch {}
        }
        // Broadcast updated viewer count
        const countMsg = JSON.stringify({ type: 'viewer-count', count: room.viewers.size })
        try {
          if (room.publisher && room.publisher.readyState === 1) room.publisher.send(countMsg)
        } catch {}
        for (const v of room.viewers.values()) {
          if (v.readyState === 1) {
            try { v.send(countMsg) } catch {}
          }
        }
        
        // Update viewer count in database
        try {
          await Stream.findOneAndUpdate(
            { publicStreamName: tokenAddress },
            { viewerCount: room.viewers.size }
          )
        } catch (e) {
          console.error('🔌 [WS] Failed to update viewer count:', e)
        }
      }

      // Cleanup room if empty
      if (!room.publisher && room.viewers.size === 0) {
        rooms.delete(tokenAddress)
      }
    })

    ws.on('error', () => {})
  })
}

export { initializeStreamingWebSocketServer }
