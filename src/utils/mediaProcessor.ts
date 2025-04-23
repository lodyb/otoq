import path from 'path'
import fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'

interface MediaItemToProcess {
  id: number
  file_path: string
  processed_path?: string 
  duration?: number
}

interface MediaMetadata {
  hasVideo: boolean
  duration: number
  width?: number
  height?: number
}

export class MediaProcessor {
  private static instance: MediaProcessor
  private TARGET_VOLUME = -3 // target peak volume in dB
  private AUDIO_BITRATE = '192k'
  private VIDEO_CRF = '22'
  private MAX_WIDTH = 1280
  private MAX_HEIGHT = 720

  private constructor() {}

  public static getInstance(): MediaProcessor {
    if (!MediaProcessor.instance) {
      MediaProcessor.instance = new MediaProcessor()
    }
    return MediaProcessor.instance
  }

  private async isValidMediaFile(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error(`validation timed out for: ${filePath}`)
        resolve(false)
      }, 15000)
      
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        clearTimeout(timeout)
        
        if (err) {
          console.error(`file validation failed: ${filePath} - ${err.message}`)
          resolve(false)
          return
        }
        
        if (!metadata?.format?.duration) {
          console.error(`file has no duration metadata: ${filePath}`)
          resolve(false)
          return
        }

        resolve(true)
      })
    })
  }

  private async getMediaMetadata(filePath: string): Promise<MediaMetadata> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`metadata analysis timed out for: ${filePath}`))
      }, 15000)
      
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        clearTimeout(timeout)
        
        if (err) {
          reject(new Error(`failed to analyze metadata: ${err.message}`))
          return
        }
        
        const duration = Math.floor((metadata?.format?.duration || 0) * 1000)
        
        // check if there's a video stream
        const videoStream = metadata?.streams?.find(stream => stream.codec_type === 'video' && 
          !stream.disposition?.attached_pic) // exclude cover art
        
        if (videoStream) {
          resolve({
            hasVideo: true,
            duration,
            width: videoStream.width,
            height: videoStream.height
          })
        } else {
          resolve({
            hasVideo: false,
            duration
          })
        }
      })
    })
  }

  public async normalizeAndConvert(inputPath: string, outputDir: string, mediaId?: number): Promise<{
    outputPath: string
    duration: number
  }> {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // check file is valid before proceeding
    const isValid = await this.isValidMediaFile(inputPath)
    if (!isValid) {
      throw new Error(`corrupt or invalid media file: ${inputPath}`)
    }

    // get detailed metadata about the media
    const metadata = await this.getMediaMetadata(inputPath)
    
    // determine output format based on content (mp4 for video, mp3 for audio-only)
    const outputExt = metadata.hasVideo ? '.mp4' : '.mp3'
    const baseName = path.basename(inputPath, path.extname(inputPath))
    const outputFileName = mediaId ? `norm_${mediaId}${outputExt}` : `norm_${Date.now()}_${baseName}${outputExt}`
    const outputPath = path.join(outputDir, outputFileName)

    try {
      // analyze volume
      const { maxVolume } = await this.analyzeVolume(inputPath)
      const adjustment = this.TARGET_VOLUME - maxVolume

      // process media with all our parameters
      await this.processMedia(inputPath, outputPath, adjustment, metadata)

      return { outputPath, duration: metadata.duration }
    } catch (err) {
      console.error(`failed processing media: ${err}`)
      throw err
    }
  }

  private async analyzeVolume(filePath: string): Promise<{ maxVolume: number }> {
    return new Promise((resolve, reject) => {
      const volumeTimeout = setTimeout(() => {
        reject(new Error(`volume analysis timed out for: ${filePath}`))
      }, 20000)
      
      ffmpeg(filePath)
        .audioFilters('volumedetect')
        .format('null')
        .output('/dev/null')
        .on('error', (err) => {
          clearTimeout(volumeTimeout)
          reject(new Error(`volume analysis failed: ${err.message}`))
        })
        .on('end', (stdout, stderr) => {
          clearTimeout(volumeTimeout)
          
          if (!stderr) {
            console.error('no stderr output from ffmpeg volume analysis, using default volume')
            resolve({ maxVolume: this.TARGET_VOLUME })
            return
          }

          const match = stderr.match(/max_volume: ([-\d.]+) dB/)
          if (!match || !match[1]) {
            console.error(`could not detect volume level for ${filePath}, using default volume`)
            resolve({ maxVolume: this.TARGET_VOLUME })
            return
          }

          const maxVolume = parseFloat(match[1])
          resolve({ maxVolume })
        })
        .run()
    })
  }

  private async processMedia(
    inputPath: string, 
    outputPath: string, 
    volAdjustment: number, 
    metadata: MediaMetadata
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const processTimeout = setTimeout(() => {
        reject(new Error(`processing timed out for: ${inputPath}`))
      }, 300000) // 5 minutes timeout
      
      let command = ffmpeg(inputPath)
        .audioFilters(`volume=${volAdjustment}dB`)
      
      if (metadata.hasVideo) {
        // video output (mp4)
        command = command
          .outputOptions('-c:v libx264')        // video codec (h264)
          .outputOptions(`-crf ${this.VIDEO_CRF}`)  // quality (lower = better)
          .outputOptions('-preset fast')        // encoding speed vs compression
          .outputOptions('-pix_fmt yuv420p')    // pixel format for compatibility
          .outputOptions(`-b:a ${this.AUDIO_BITRATE}`) // audio bitrate
          .outputOptions('-c:a aac')            // audio codec
          
        // scale video if needed while maintaining aspect ratio
        if (metadata.width && metadata.height) {
          if (metadata.width > this.MAX_WIDTH || metadata.height > this.MAX_HEIGHT) {
            command = command.outputOptions(
              `-vf scale=w='min(${this.MAX_WIDTH},iw)':h='min(${this.MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease`
            )
          }
        }
      } else {
        // audio-only output (mp3)
        command = command
          .outputOptions('-c:a libmp3lame')     // mp3 codec
          .outputOptions(`-b:a ${this.AUDIO_BITRATE}`) // audio bitrate
      }

      command
        .output(outputPath)
        .on('error', (err) => {
          clearTimeout(processTimeout)
          reject(new Error(`processing failed: ${err.message}`))
        })
        .on('end', () => {
          clearTimeout(processTimeout)
          resolve()
        })
        .run()
    })
  }

  public async batchProcessMedia(mediaItems: MediaItemToProcess[], outputDir: string): Promise<{
    processed: number
    skipped: number  
    errors: { id: number, error: string }[]
  }> {
    let processed = 0
    let skipped = 0
    let errors: { id: number, error: string }[] = []

    const total = mediaItems.length
    const progressInterval = 5 // report every 5 files
    
    for (let i = 0; i < mediaItems.length; i++) {
      const media = mediaItems[i]
      
      try {
        // show progress
        if (i % progressInterval === 0 || i === mediaItems.length - 1) {
          console.log(`processing ${i+1}/${total}: media #${media.id} (${Math.floor((i+1)/total*100)}%)`)
        }
        
        // skip if file doesn't exist
        if (!fs.existsSync(media.file_path)) {
          console.log(`  file not found: ${media.file_path}`)
          errors.push({ id: media.id, error: `file not found: ${media.file_path}` })
          continue
        }

        // process the media file
        const result = await this.normalizeAndConvert(media.file_path, outputDir, media.id)
        processed++
        
        // return full path for db update
        media.processed_path = result.outputPath
        media.duration = result.duration
        
        // show completion for this file
        console.log(`  ✓ processed #${media.id} - duration: ${Math.floor(result.duration/1000)}s`)
      } catch (err: any) {
        console.log(`  ✗ failed #${media.id}: ${err.message}`)
        errors.push({ id: media.id, error: err.message || 'unknown error' })
      }
    }

    return { processed, skipped, errors }
  }
}