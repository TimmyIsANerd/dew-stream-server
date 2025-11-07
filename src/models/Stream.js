import mongoose from 'mongoose'

const streamSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  streamKey: { type: String, required: true, unique: true, index: true },
  publicStreamName: { type: String, required: true, unique: true, index: true },
  title: { type: String, default: '' },
  isLive: { type: Boolean, default: false },
  startTime: { type: Date, default: null },
  endTime: { type: Date, default: null },
  viewerCount: { type: Number, default: 0 },
  app: { type: String, default: 'live' },
  lastClientAddr: { type: String, default: null }
}, { timestamps: true })

streamSchema.index({ isLive: 1, updatedAt: -1 })

export const Stream = mongoose.model('Stream', streamSchema)
