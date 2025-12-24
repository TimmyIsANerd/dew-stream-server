/**
 * WebSocket signaling for mediasoup SFU
 * Handles all WebRTC signaling between clients and the SFU
 */

import { WebSocketServer } from 'ws';
import { Stream } from '../models/Stream.js';
import { getOrCreateRoom, getRoom, deleteRoom } from '../sfu/room-manager.js';

function genId() {
  return Math.random().toString(36).slice(2, 12);
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const params = Object.fromEntries(url.searchParams.entries());
  return { pathname: url.pathname, params };
}

let wss = null;

function initializeStreamingWebSocketServer(server) {
  wss = new WebSocketServer({ server, path: '/ws/stream' });

  wss.on('connection', async (ws, req) => {
    const { params } = parseUrl(req);
    const tokenAddress = (params.tokenAddress || '').toLowerCase();
    const isCreator = params.isCreator === 'true' || params.role === 'publisher';
    const userAddress = (params.userAddress || '').toLowerCase();
    const peerId = genId();

    console.log('🔌 [WS] New connection:', { tokenAddress, isCreator, userAddress, peerId });

    if (!tokenAddress) {
      console.log('🔌 [WS] Closing: Missing tokenAddress');
      ws.close(1008, 'Missing tokenAddress');
      return;
    }

    // Gate: Only allow publisher if userAddress matches stream.userId
    if (isCreator) {
      if (!userAddress) {
        console.log('🔌 [WS] Closing: Missing userAddress for creator');
        ws.close(1008, 'Missing userAddress');
        return;
      }
      try {
        const stream = await Stream.findOne({ publicStreamName: tokenAddress }).lean();
        console.log('🔌 [WS] Stream lookup result:', stream ? { userId: stream.userId } : 'not found');
        
        if (!stream) {
          console.log('🔌 [WS] Closing: Stream not registered');
          ws.close(1008, 'Stream not registered');
          return;
        }
        if ((stream.userId || '').toLowerCase() !== userAddress) {
          console.log('🔌 [WS] Closing: Not authorized publisher');
          ws.close(1008, 'Not authorized publisher');
          return;
        }
        console.log('🔌 [WS] Publisher authorized successfully');
      } catch (e) {
        console.error('🔌 [WS] Auth check failed:', e);
        ws.close(1011, 'Auth check failed');
        return;
      }
    }

    // Attach metadata
    ws.meta = { tokenAddress, role: isCreator ? 'publisher' : 'viewer', peerId, userAddress };

    // Get or create room
    let room;
    try {
      room = await getOrCreateRoom(tokenAddress);
    } catch (e) {
      console.error('🔌 [WS] Failed to get/create room:', e);
      ws.close(1011, 'Failed to create room');
      return;
    }

    // Send initial connection info
    try {
      ws.send(JSON.stringify({
        type: 'connection-success',
        peerId,
        role: ws.meta.role,
        routerRtpCapabilities: room.getRouterRtpCapabilities(),
      }));
    } catch (e) {
      console.error('🔌 [WS] Failed to send connection-success:', e);
    }

    // Handle messages
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const currentRoom = getRoom(tokenAddress);
      if (!currentRoom) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }

      try {
        await handleMessage(ws, currentRoom, msg);
      } catch (e) {
        console.error('🔌 [WS] Error handling message:', e);
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
    });

    // Handle disconnect
    ws.on('close', async () => {
      console.log('🔌 [WS] Connection closed:', { peerId, role: ws.meta.role });
      
      const currentRoom = getRoom(tokenAddress);
      if (!currentRoom) return;

      if (ws.meta.role === 'publisher') {
        // Publisher left - end stream
        currentRoom.removePublisher();
        
        // Update database
        try {
          await Stream.findOneAndUpdate(
            { publicStreamName: tokenAddress },
            { isLive: false, endTime: new Date(), viewerCount: 0 }
          );
          console.log('🔌 [WS] Stream set to OFFLINE:', tokenAddress);
        } catch (e) {
          console.error('🔌 [WS] Failed to update stream status:', e);
        }

        // Notify all viewers
        for (const [viewerId, viewer] of currentRoom.viewers) {
          if (viewer.ws.readyState === 1) {
            try {
              viewer.ws.send(JSON.stringify({ type: 'publisher-ended' }));
            } catch {}
          }
        }

        // Clean up room if no viewers
        if (currentRoom.getViewerCount() === 0) {
          deleteRoom(tokenAddress);
        }
      } else {
        // Viewer left
        const remainingViewers = currentRoom.removeViewer(peerId);
        
        // Update viewer count in database
        try {
          await Stream.findOneAndUpdate(
            { publicStreamName: tokenAddress },
            { viewerCount: remainingViewers }
          );
        } catch (e) {
          console.error('🔌 [WS] Failed to update viewer count:', e);
        }

        // Broadcast updated viewer count
        broadcastViewerCount(currentRoom, remainingViewers);

        // Clean up room if empty
        if (!currentRoom.hasPublisher() && remainingViewers === 0) {
          deleteRoom(tokenAddress);
        }
      }
    });

    ws.on('error', (e) => {
      console.error('🔌 [WS] WebSocket error:', e);
    });
  });
}

/**
 * Handle incoming WebSocket messages
 */
async function handleMessage(ws, room, msg) {
  const { type, requestId } = msg;
  const peerId = ws.meta.peerId;
  const isPublisher = ws.meta.role === 'publisher';

  // Helper to send response with requestId
  const respond = (data) => {
    ws.send(JSON.stringify({ ...data, requestId }));
  };

  switch (type) {
    // ===== Publisher messages =====
    
    case 'create-producer-transport': {
      if (!isPublisher) throw new Error('Only publisher can create producer transport');
      
      const transportParams = await room.setPublisher(peerId, ws);
      
      // Update stream to live
      try {
        await Stream.findOneAndUpdate(
          { publicStreamName: room.tokenAddress },
          { isLive: true, startTime: new Date(), viewerCount: room.getViewerCount() }
        );
        console.log('🔌 [WS] Stream set to LIVE:', room.tokenAddress);
      } catch (e) {
        console.error('🔌 [WS] Failed to update stream status:', e);
      }
      
      respond({
        type: 'producer-transport-created',
        params: transportParams,
      });
      break;
    }

    case 'connect-producer-transport': {
      if (!isPublisher) throw new Error('Only publisher can connect producer transport');
      
      await room.connectProducerTransport(msg.dtlsParameters);
      respond({ type: 'producer-transport-connected' });
      break;
    }

    case 'produce': {
      if (!isPublisher) throw new Error('Only publisher can produce');
      
      const { id } = await room.produce(msg.kind, msg.rtpParameters, msg.appData);
      respond({
        type: 'produced',
        id,
        kind: msg.kind,
      });
      
      // Send current viewer count to publisher (no requestId for this)
      ws.send(JSON.stringify({
        type: 'viewer-count',
        count: room.getViewerCount(),
      }));
      break;
    }

    // ===== Viewer messages =====

    case 'create-consumer-transport': {
      if (isPublisher) throw new Error('Publisher should not create consumer transport');
      
      const transportParams = await room.addViewer(peerId, ws);
      
      // Update viewer count
      const viewerCount = room.getViewerCount();
      try {
        await Stream.findOneAndUpdate(
          { publicStreamName: room.tokenAddress },
          { viewerCount }
        );
      } catch (e) {
        console.error('🔌 [WS] Failed to update viewer count:', e);
      }
      
      // Broadcast viewer count
      broadcastViewerCount(room, viewerCount);
      
      respond({
        type: 'consumer-transport-created',
        params: transportParams,
      });
      
      // Send available producers (no requestId - this is a push notification)
      const producers = room.getProducerIds();
      if (producers.length > 0) {
        ws.send(JSON.stringify({
          type: 'producers-available',
          producers,
        }));
      } else {
        ws.send(JSON.stringify({ type: 'publisher-not-live' }));
      }
      break;
    }

    case 'connect-consumer-transport': {
      if (isPublisher) throw new Error('Publisher should not connect consumer transport');
      
      await room.connectConsumerTransport(peerId, msg.dtlsParameters);
      respond({ type: 'consumer-transport-connected' });
      break;
    }

    case 'consume': {
      if (isPublisher) throw new Error('Publisher should not consume');
      
      const consumerParams = await room.consume(peerId, msg.producerId, msg.rtpCapabilities);
      respond({
        type: 'consumed',
        ...consumerParams,
      });
      break;
    }

    case 'resume-consumer': {
      if (isPublisher) throw new Error('Publisher should not resume consumer');
      
      await room.resumeConsumer(peerId, msg.consumerId);
      respond({ type: 'consumer-resumed', consumerId: msg.consumerId });
      break;
    }

    // ===== Common messages =====

    case 'get-producers': {
      const producers = room.getProducerIds();
      respond({
        type: 'producers-available',
        producers,
      });
      break;
    }

    case 'ping': {
      respond({ type: 'pong' });
      break;
    }

    default:
      console.log('🔌 [WS] Unknown message type:', type);
  }
}

/**
 * Broadcast viewer count to all connected clients in a room
 */
function broadcastViewerCount(room, count) {
  const msg = JSON.stringify({ type: 'viewer-count', count });
  
  // Send to publisher
  if (room.publisher && room.publisher.ws.readyState === 1) {
    try { room.publisher.ws.send(msg); } catch {}
  }
  
  // Send to all viewers
  for (const viewer of room.viewers.values()) {
    if (viewer.ws.readyState === 1) {
      try { viewer.ws.send(msg); } catch {}
    }
  }
}

export { initializeStreamingWebSocketServer };
