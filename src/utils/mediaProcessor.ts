import path from 'path'
import fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'

interface MediaItemToProcess {
  id: number
  file_path: string
  processed_path?: string 
  duration?: number
}

export class MediaProcessor {
  private static instance: MediaProcessor
  private TARGET_VOLUME = -3 // target peak volume in dB
  private supportedOutputFormats = ['mp4']
  private formatsToConvert = ['.webm', '.mkv', '.m4a']

  private constructor() {}

  public static getInstance(): MediaProcessor {
    if (!MediaProcessor.instance) {
      MediaProcessor.instance = new MediaProcessor()
    }
    return MediaProcessor.instance
  }

  private async isValidMediaFile(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      // set a timeout to prevent hanging on corrupt files
      const timeout = setTimeout(() => {
        console.error(`validation timed out for: ${filePath}`)
        resolve(false)
      }, 15000) // 15 second timeout
      
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

    const originalExt = path.extname(inputPath).toLowerCase()
    const baseName = path.basename(inputPath, originalExt)
    const finalExt = this.shouldConvertFormat(originalExt) ? '.mp4' : originalExt
    const outputFileName = mediaId ? `norm_${mediaId}${finalExt}` : `norm_${Date.now()}_${baseName}${finalExt}`
    const outputPath = path.join(outputDir, outputFileName)

    try {
      // analyze volume
      const { maxVolume, duration } = await this.analyzeMedia(inputPath)
      const adjustment = this.TARGET_VOLUME - maxVolume

      // normalize volume and convert format if needed
      await this.processMedia(inputPath, outputPath, adjustment, this.shouldConvertFormat(originalExt))

      return { outputPath, duration }
    } catch (err) {
      console.error(`failed processing media: ${err}`)
      throw err
    }
  }

  private shouldConvertFormat(extension: string): boolean {
    return this.formatsToConvert.includes(extension.toLowerCase())
  }

  private async analyzeMedia(filePath: string): Promise<{ maxVolume: number, duration: number }> {
    return new Promise((resolve, reject) => {
      // timeout for getting duration
      const durationTimeout = setTimeout(() => {
        reject(new Error(`ffprobe duration analysis timed out for: ${filePath}`))
      }, 15000) // 15 second timeout
      
      // first get duration
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        clearTimeout(durationTimeout)
        
        if (err) {
          reject(new Error(`failed to analyze media: ${err.message}`))
          return
        }

        const duration = Math.floor((metadata?.format?.duration || 0) * 1000)

        // timeout for volume analysis
        const volumeTimeout = setTimeout(() => {
          reject(new Error(`volume analysis timed out for: ${filePath}`))
        }, 20000) // 20 second timeout
        
        // then analyze volume
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
              reject(new Error('no stderr output from ffmpeg volume analysis'))
              return
            }

            const match = stderr.match(/max_volume: ([-\d.]+) dB/)
            if (!match || !match[1]) {
              reject(new Error('could not detect volume level'))
              return
            }

            const maxVolume = parseFloat(match[1])
            resolve({ maxVolume, duration })
          })
          .run()
      })
    })
  }

  private async processMedia(inputPath: string, outputPath: string, volAdjustment: number, convertFormat: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      // timeout for processing - longer since conversion can take time
      const processTimeout = setTimeout(() => {
        reject(new Error(`processing timed out for: ${inputPath}`))
      }, 300000) // 5 minutes timeout
      
      let command = ffmpeg(inputPath).audioFilters(`volume=${volAdjustment}dB`)

      if (convertFormat) {
        // for format conversion, ensure we use good settings
        command = command
          .outputOptions('-c:v libx264') // video codec
          .outputOptions('-crf 23')      // quality
          .outputOptions('-preset fast') // encoding speed/compression balance
          .outputOptions('-c:a aac')     // audio codec
          .outputOptions('-b:a 128k')    // audio bitrate
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

    for (const media of mediaItems) {
      try {
        // skip if file doesn't exist
        if (!fs.existsSync(media.file_path)) {
          errors.push({ id: media.id, error: `file not found: ${media.file_path}` })
          continue
        }

        // process the media file
        const result = await this.normalizeAndConvert(media.file_path, outputDir, media.id)
        processed++
        
        // return full path for db update
        media.processed_path = result.outputPath
        media.duration = result.duration
      } catch (err: any) {
        errors.push({ id: media.id, error: err.message || 'unknown error' })
      }
    }

    return { processed, skipped, errors }
  }
}