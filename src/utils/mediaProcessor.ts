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
  bitrate?: number
  size?: number
}

export class MediaProcessor {
  private static instance: MediaProcessor
  private TARGET_VOLUME = -3 
  private AUDIO_BITRATE = '192k'
  private VIDEO_CRF = '26' 
  private MAX_WIDTH = 640
  private MAX_HEIGHT = 480
  private MAX_FILE_SIZE_BYTES = 8.5 * 1024 * 1024 

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
        const size = metadata?.format?.size ? Number(metadata.format.size) : fs.statSync(filePath).size
        const bitrate = metadata?.format?.bit_rate ? Number(metadata.format.bit_rate) : 0
        
        // check if there's a video stream
        const videoStream = metadata?.streams?.find(stream => stream.codec_type === 'video' && 
          !stream.disposition?.attached_pic) // exclude cover art
        
        if (videoStream) {
          resolve({
            hasVideo: true,
            duration,
            width: videoStream.width,
            height: videoStream.height,
            bitrate,
            size
          })
        } else {
          resolve({
            hasVideo: false,
            duration,
            bitrate,
            size
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
    // calculate optimal encoding settings based on source media
    const { crf, audioBitrate } = this.calculateCompressionSettings(metadata);
    
    console.log(`processing ${path.basename(inputPath)} - ${metadata.hasVideo ? 'video' : 'audio'} file`);
    console.log(`source: ${metadata.size ? Math.round(metadata.size/1024/1024) + 'MB' : 'unknown size'}, ${metadata.duration}ms duration`);
    console.log(`settings: ${metadata.hasVideo ? `crf=${crf}, ` : ''}audioBitrate=${audioBitrate}`);
    
    // first try with calculated settings
    try {
      await this.runFfmpeg(inputPath, outputPath, volAdjustment, metadata, crf, audioBitrate);
      
      // verify file size
      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        console.log(`output size: ${Math.round(stats.size/1024/1024)}MB`);
        
        if (stats.size <= this.MAX_FILE_SIZE_BYTES) {
          return; // success!
        }
        
        console.log(`output still too large, using emergency compression`);
        
        // emergency compression with more aggressive settings
        if (metadata.hasVideo) {
          // use extreme settings for video
          await this.runFfmpeg(inputPath, outputPath, volAdjustment, metadata, 35, this.AUDIO_BITRATE);
        } else {
          // use minimum bitrate for audio
          await this.runFfmpeg(inputPath, outputPath, volAdjustment, metadata, 0, this.AUDIO_BITRATE);
        }
        
        // check size again
        if (fs.existsSync(outputPath)) {
          const finalStats = fs.statSync(outputPath);
          console.log(`final size: ${Math.round(finalStats.size/1024/1024)}MB`);
          
          if (finalStats.size <= this.MAX_FILE_SIZE_BYTES) {
            return; // success with emergency compression
          }
          
          throw new Error(`failed to compress file under ${Math.round(this.MAX_FILE_SIZE_BYTES/1024/1024)}MB limit even with emergency settings`);
        }
      }
    } catch (err) {
      // if file exists but encoding failed, remove it
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      throw err;
    }
  }
  
  private async runFfmpeg(
    inputPath: string,
    outputPath: string,
    volAdjustment: number,
    metadata: MediaMetadata,
    crf: number, 
    audioBitrate: string
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
          .outputOptions(`-crf ${crf}`)         // quality (higher = more compression)
          .outputOptions('-preset medium')        // encoding speed vs compression
          .outputOptions('-pix_fmt yuv420p')    // pixel format for compatibility
          .outputOptions(`-b:a ${audioBitrate}`) // audio bitrate
          .outputOptions('-c:a aac')            // audio codec
          
        // scale video to max resolution while maintaining aspect ratio
        command = command.outputOptions(
          `-vf scale=w='min(${this.MAX_WIDTH},iw)':h='min(${this.MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease`
        )
      } else {
        // audio-only output (mp3)
        command = command
          .outputOptions('-c:a libmp3lame')     // mp3 codec
          .outputOptions(`-b:a ${audioBitrate}`) // audio bitrate
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

  private calculateCompressionSettings(metadata: MediaMetadata): {
    crf: number;
    audioBitrate: string;
  } {
    // for audio-only files
    if (!metadata.hasVideo) {
      // calculate based on source size and target limit
      const targetBitrate = Math.min(
        // don't exceed 192kbps regardless of file size
        192,
        // aim for 75% of max file size to be safe
        Math.floor((this.MAX_FILE_SIZE_BYTES * 0.75 * 8) / metadata.duration)
      );
      
      // keep bitrate in reasonable range
      const audioBitrate = Math.max(96, Math.min(192, targetBitrate));
      return { crf: 23, audioBitrate: `${audioBitrate}k` };
    }
    
    // for video files
    let crf = Number(this.VIDEO_CRF);
    let audioBitrate = this.AUDIO_BITRATE;
    
    // if we can estimate size ratio based on source file
    if (metadata.size && metadata.size > 0) {
      const compressionRatio = this.MAX_FILE_SIZE_BYTES / metadata.size;
      
      // adjust crf based on compression ratio needed
      // the relationship isn't linear but this gives us a starting point
      if (compressionRatio < 0.2) {
        // need extreme compression
        crf = 32;
      } else if (compressionRatio < 0.4) {
        // need high compression
        crf = 30;
      } else if (compressionRatio < 0.6) {
        // need moderate compression
        crf = 28;
      } else if (compressionRatio < 0.8) {
        // need light compression
        crf = 26;
      } else {
        // need minimal compression
        crf = 23;
      }
    }
    
    return { crf, audioBitrate };
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