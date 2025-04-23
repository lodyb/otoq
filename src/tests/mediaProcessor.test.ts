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
  const mockFfmpegInstance = {
    audioFilters: jest.fn().mockReturnThis(),
    format: jest.fn().mockReturnThis(),
    output: jest.fn().mockReturnThis(),
    outputOptions: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation(function(this: any, event: string, callback: any) {
      if (event === 'end') callback(null, 'max_volume: -10.0 dB')
      return this
    }),
    run: jest.fn()
  }
  
  const ffmpegMock = jest.fn().mockReturnValue(mockFfmpegInstance)
  
  // mock the ffprobe function to return different metadata for different file types
  ;(ffmpegMock as any).ffprobe = jest.fn().mockImplementation((filePath: string, callback: any) => {
    const ext = path.extname(filePath).toLowerCase()
    const duration = ext === '.webm' || ext === '.mkv' || ext === '.m4a' ? 45.5 : 30.5
    
    // return video stream data for video files, audio only for mp3
    if (ext === '.mp3') {
      callback(null, {
        format: { duration },
        streams: [
          { codec_type: 'audio' }
        ]
      })
    } else {
      callback(null, {
        format: { duration },
        streams: [
          { codec_type: 'video', width: 1920, height: 1080 },
          { codec_type: 'audio' }
        ]
      })
    }
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
    expect(mockInstance.outputOptions).toHaveBeenCalledWith('-c:a aac')
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
    expect(mockInstance.outputOptions).toHaveBeenCalledWith('-b:a 192k')
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