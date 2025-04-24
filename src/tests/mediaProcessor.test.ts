import { MediaProcessor } from '../utils/mediaProcessor'
import path from 'path'
import fs from 'fs'

// Define the interface to match what the MediaProcessor expects
interface MediaItemToProcess {
  id: number
  file_path: string
  processed_path?: string 
  duration?: number
}

// mock dependencies
jest.mock('fluent-ffmpeg', () => {
  // simpler mock implementation to avoid memory issues
  const mockFfmpegInstance = {
    audioFilters: jest.fn().mockReturnThis(),
    format: jest.fn().mockReturnThis(),
    output: jest.fn().mockReturnThis(),
    outputOptions: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation(function(this: any, event: string, callback: any) {
      if (event === 'end') setTimeout(() => callback(null, 'max_volume: -10.0 dB'), 0)
      return this
    }),
    run: jest.fn().mockImplementation(function(this: any) {
      const endCallback = this.on.mock.calls.find((call: any[]) => call[0] === 'end')?.[1]
      if (endCallback) setTimeout(() => endCallback(), 0)
    })
  }
  
  const ffmpegMock = jest.fn().mockReturnValue(mockFfmpegInstance)
  
  // simplified ffprobe mock
  ;(ffmpegMock as any).ffprobe = jest.fn().mockImplementation((filePath: string, callback: any) => {
    const ext = path.extname(filePath).toLowerCase()
    const duration = ext === '.webm' || ext === '.mkv' || ext === '.m4a' ? 45.5 : 30.5
    
    setTimeout(() => {
      callback(null, {
        format: { duration },
        streams: [
          { codec_type: ext === '.mp3' ? 'audio' : 'video' }
        ]
      })
    }, 0)
  })
  
  return ffmpegMock
})

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue('{}'),
  unlinkSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ size: 1024 * 1024 }) // mock 1MB file size
}))

describe('MediaProcessor', () => {
  let mediaProcessor: MediaProcessor
  
  beforeEach(() => {
    jest.clearAllMocks()
    ;(MediaProcessor as any).instance = undefined
    mediaProcessor = MediaProcessor.getInstance()
  })
  
  test('should be a singleton', () => {
    const instance1 = MediaProcessor.getInstance()
    const instance2 = MediaProcessor.getInstance()
    expect(instance1).toBe(instance2)
  })
  
  test('should normalize and convert webm to mp4', async () => {
    const inputPath = '/path/to/file.webm'
    const outputDir = '/output/dir'
    
    const result = await mediaProcessor.normalizeAndConvert(inputPath, outputDir)
    
    // should have correct extension
    expect(result.outputPath.endsWith('.mp4')).toBe(true)
    
    // duration should match the mock
    expect(result.duration).toBe(45500) // 45.5 seconds in ms
    
    // ffmpeg should be called with correct options for video conversion
    const ffmpeg = require('fluent-ffmpeg')
    const mockFfmpeg = jest.mocked(ffmpeg)
    expect(mockFfmpeg).toHaveBeenCalledWith(inputPath)
    
    // check if video outputOptions were called
    const mockInstance = mockFfmpeg.mock.results[0].value
    expect(mockInstance.outputOptions).toHaveBeenCalledWith('-c:v libx264')
    expect(mockInstance.outputOptions).toHaveBeenCalledWith('-c:a libopus') // now using opus
    expect(mockInstance.outputOptions).toHaveBeenCalledWith('-vbr on') // using vbr mode
  })
  
  test('should normalize mp3 and keep mp3 format', async () => {
    const inputPath = '/path/to/file.mp3'
    const outputDir = '/output/dir'
    
    const result = await mediaProcessor.normalizeAndConvert(inputPath, outputDir)
    
    // should keep mp3 extension for audio files
    expect(result.outputPath.endsWith('.mp3')).toBe(true)
    
    // duration should match the mock
    expect(result.duration).toBe(30500) // 30.5 seconds in ms
    
    // ffmpeg should be called with correct options for audio
    const ffmpeg = require('fluent-ffmpeg')
    const mockFfmpeg = jest.mocked(ffmpeg)
    expect(mockFfmpeg).toHaveBeenCalledWith(inputPath)
    
    // check that audio-specific output options were used
    const mockInstance = mockFfmpeg.mock.results[0].value
    expect(mockInstance.outputOptions).toHaveBeenCalledWith('-c:a libmp3lame')
    expect(mockInstance.outputOptions).toHaveBeenCalledWith('-q:a 2') // now using VBR quality instead of bitrate
  })
  
  test('should use mediaId in filename when provided', async () => {
    const inputPath = '/path/to/file.mp3'
    const outputDir = '/output/dir'
    const mediaId = 42
    
    const result = await mediaProcessor.normalizeAndConvert(inputPath, outputDir, mediaId)
    
    // should include mediaId in filename
    expect(result.outputPath).toContain(`norm_${mediaId}`)
  })
  
  test('should batch process media files', async () => {
    const mediaItems: MediaItemToProcess[] = [
      { id: 1, file_path: '/path/to/file1.mp3' },
      { id: 2, file_path: '/path/to/file2.webm' },
      { id: 3, file_path: '/path/to/file3.mkv' }
    ]
    
    const result = await mediaProcessor.batchProcessMedia(mediaItems, '/output/dir')
    
    expect(result.processed).toBe(3)
    expect(result.errors.length).toBe(0)
    
    // check that each file was processed
    expect(mediaItems[0].processed_path).toBeDefined()
    expect(mediaItems[1].processed_path).toBeDefined()
    expect(mediaItems[2].processed_path).toBeDefined()
    
    // check format conversion
    expect(mediaItems[0].processed_path!.endsWith('.mp3')).toBe(true)
    expect(mediaItems[1].processed_path!.endsWith('.mp4')).toBe(true)
    expect(mediaItems[2].processed_path!.endsWith('.mp4')).toBe(true)
  })
})