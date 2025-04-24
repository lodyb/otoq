import { 
  Message, 
  AttachmentBuilder,
  ChannelType
} from 'discord.js'
import { DatabaseManager } from '../database/databaseManager'
import { GameManager } from './gameManager'
import { AudioPlayerManager } from './audioPlayerManager'
import path from 'path'
import fs from 'fs'
import { EffectsManager, CommandParams } from './effectsManager'
import { exec } from 'child_process'
import { promisify } from 'util'

// promisify exec for async/await
const execAsync = promisify(exec)

export class ChatCommandHandler {
  private static instance: ChatCommandHandler
  
  // command prefixes
  private PREFIX = '..o'           // general media search
  private PREFIX_PREV = '..op'     // previous media
  private PREFIX_CLIP = '..oc'     // random clip 
  private PREFIX_FRAME = '..of'    // random frame
  private PREFIX_AUDIO = '..oa'    // audio-only filters
  private PREFIX_VIDEO = '..ov'    // video-only filters
  
  // temp directory for processed media
  private TEMP_DIR = path.join(process.cwd(), 'temp')

  private constructor() {
    // make sure temp directory exists
    if (!fs.existsSync(this.TEMP_DIR)) {
      fs.mkdirSync(this.TEMP_DIR, { recursive: true })
    }
  }

  public static getInstance(): ChatCommandHandler {
    if (!ChatCommandHandler.instance) {
      ChatCommandHandler.instance = new ChatCommandHandler()
    }
    return ChatCommandHandler.instance
  }

  public async handleMessage(message: Message): Promise<void> {
    // ignore bot messages
    if (message.author.bot) return
    
    // check for FFmpeg errors that need to be sent to the user
    await this.checkForFFmpegErrors(message)

    // handle various command prefixes
    if (message.content.startsWith(this.PREFIX_PREV)) {
      await this.handlePreviousMediaCommand(message)
      return
    }
    
    if (message.content.startsWith(this.PREFIX_FRAME)) {
      await this.handleRandomFrameCommand(message)
      return
    }
    
    if (message.content.startsWith(this.PREFIX_CLIP)) {
      await this.handleRandomClipCommand(message)
      return
    }
    
    if (message.content.startsWith(this.PREFIX_AUDIO) || 
        message.content.startsWith(this.PREFIX_VIDEO) ||
        message.content.startsWith(this.PREFIX)) {
      await this.handleSearchMediaCommand(message)
      return
    }
  }
  
  /**
   * check if user has pending FFmpeg errors and send them via DM
   */
  private async checkForFFmpegErrors(message: Message): Promise<void> {
    try {
      const effectsManager = EffectsManager.getInstance()
      const userId = message.author.id
      
      if (effectsManager.hasFFmpegError(userId)) {
        const error = effectsManager.getAndClearFFmpegError(userId)
        if (error) {
          try {
            await message.author.send(`ffmpeg error from your last command:\n\`\`\`\n${error}\n\`\`\`\n(੭ ˃̣̣̥ ㅂ˂̣̣̥)੭ u can fix and try again`)
          } catch (err) {
            // user might have DMs disabled, try to reply in channel
            console.log(`failed to DM user ${userId} with ffmpeg error: ${err}`)
          }
        }
      }
    } catch (err) {
      console.error('error checking ffmpeg errors:', err)
    }
  }

  /**
   * handle ..op command to post previous media
   */
  private async handlePreviousMediaCommand(message: Message): Promise<void> {
    if (!message.guildId) return
    
    try {
      await message.channel.sendTyping()
      
      const gameManager = GameManager.getInstance()
      const session = gameManager.getSession(message.guildId, message.channelId)
      
      if (!session) {
        await message.reply('no active game session found (￣ヘ￣)')
        return
      }
      
      const previousMediaId = session.getCurrentRound() > 1 ? session.getPreviousMediaId() : null
      
      if (!previousMediaId) {
        await message.reply('no previous media to post yet (￣ー￣;)')
        return
      }
      
      const db = DatabaseManager.getInstance()
      const mediaItems = await db.getMediaById(previousMediaId)
      
      if (!mediaItems?.length) {
        await message.reply('couldnt find that media (╯°□°）╯︵ ┻━┻')
        return
      }
      
      const media = mediaItems[0]
      
      // parse params but reject if effects are specified
      const effectsManager = EffectsManager.getInstance()
      const params = effectsManager.parseCommandString(message.content)
      params.userId = message.author.id
      
      if (params.searchTerm || params.effects.length > 0 || params.rawFilters) {
        await message.reply('for previous media command, you cant use search or effects (￣ε￣)')
        return
      }
      
      // get normalized path if available
      const filePath = media.normalized_path || media.file_path
      
      if (!fs.existsSync(filePath)) {
        await message.reply('media file not found on disk (￣ヘ￣)')
        return
      }
      
      // create attachment and post
      const attachment = new AttachmentBuilder(filePath)
        .setName(path.basename(filePath))
      
      await message.reply({
        content: `heres the media from the previous round: **${media.title}** (#${media.id})`,
        files: [attachment]
      })
      
    } catch (err) {
      console.error('error handling previous media command:', err)
      await message.reply('error processing command (╯°□°）╯︵ ┻━┻')
    }
  }

  /**
   * handle ..of command to extract and post a random frame
   */
  private async handleRandomFrameCommand(message: Message): Promise<void> {
    if (!message.guildId) return
    
    try {
      // parsing message with effects manager
      const effectsManager = EffectsManager.getInstance()
      const params = effectsManager.parseCommandString(message.content)
      params.userId = message.author.id
            
      // search DB for media
      const db = DatabaseManager.getInstance()
      const mediaItems = await this.searchMedia(params.searchTerm)
      
      if (!mediaItems?.length) {
        await message.reply(`no matching media found for "${params.searchTerm || 'random'}" (￣ヘ￣)`)
        return
      }
      
      // pick a random media item
      const media = mediaItems[Math.floor(Math.random() * mediaItems.length)]
      const filePath = media.normalized_path || media.file_path
      
      // only process video files
      if (!this.isVideoFile(filePath)) {
        await message.reply('that media isnt a video file, cant extract frame (￣ε￣)')
        return
      }
      
      if (!fs.existsSync(filePath)) {
        await message.reply('media file not found on disk (￣ヘ￣)')
        return
      }
      
      await message.channel.sendTyping()
      
      const audioPlayer = AudioPlayerManager.getInstance()
      const duration = audioPlayer.getStoredMediaDuration(media.id) / 1000
      
      // use either provided start time or random position
      const startTime = params.startTime > 0 
        ? params.startTime 
        : Math.floor(Math.random() * (duration || 60))
        
      const outputPath = path.join(this.TEMP_DIR, `frame_${Date.now()}.jpg`)
      
      // construct ffmpeg command to extract frame
      let cmd = `ffmpeg -i "${filePath}" -ss ${startTime} -vframes 1`
      
      // apply any video effects if specified
      const videoEffects = effectsManager.buildVideoEffectsFilter(params.effects, params)
      if (videoEffects.length > 0) {
        cmd += ` -vf "${videoEffects.join(',')}"`
      }
      
      cmd += ` "${outputPath}"`
      
      try {
        const { stderr } = await execAsync(cmd)
        
        if (!fs.existsSync(outputPath)) {
          console.error('frame extraction failed:', stderr)
          effectsManager.storeFFmpegError(message.author.id, stderr)
          await message.reply('failed to extract frame (╯°□°）╯︵ ┻━┻')
          return
        }
        
        // create attachment and post
        const attachment = new AttachmentBuilder(outputPath)
          .setName(`frame_${media.id}.jpg`)
        
        await message.reply({
          content: `random frame from **${media.title}** (#${media.id}) at ${startTime}s`,
          files: [attachment]
        })
        
        // clean up temp file after 5s
        setTimeout(() => {
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
          } catch (err) {
            console.error('failed to clean up temp file:', err)
          }
        }, 5000)
        
      } catch (err) {
        console.error('frame extraction error:', err)
        effectsManager.storeFFmpegError(message.author.id, err.message || String(err))
        await message.reply('error extracting frame (╯°□°）╯︵ ┻━┻)')
      }
      
    } catch (err) {
      console.error('error handling random frame command:', err)
      await message.reply('error processing command (╯°□°）╯︵ ┻━┻')
    }
  }

  /**
   * handle ..oc command to create and post a random clip
   */
  private async handleRandomClipCommand(message: Message): Promise<void> {
    if (!message.guildId) return
    
    try {
      // parsing message with effects manager
      const effectsManager = EffectsManager.getInstance()
      const params = effectsManager.parseCommandString(message.content)
      params.userId = message.author.id
      
      // ensure clip length is reasonable (default 10s in params)
      if (params.clipLength <= 0 || params.clipLength > 30) params.clipLength = 10
            
      // search DB for media
      const mediaItems = await this.searchMedia(params.searchTerm)
      
      if (!mediaItems?.length) {
        await message.reply(`no matching media found for "${params.searchTerm || 'random'}" (￣ヘ￣)`)
        return
      }
      
      // pick a random media item and get path
      const media = mediaItems[Math.floor(Math.random() * mediaItems.length)]
      const filePath = media.normalized_path || media.file_path
      
      if (!fs.existsSync(filePath)) {
        await message.reply('media file not found on disk (￣ヘ￣)')
        return
      }
      
      await message.channel.sendTyping()
      
      // determine start time
      const audioPlayer = AudioPlayerManager.getInstance()
      const duration = audioPlayer.getStoredMediaDuration(media.id) / 1000
      
      // use either provided start time or random position that leaves room for the clip
      const maxStart = Math.max(0, (duration || 60) - params.clipLength)
      const startTime = params.startTime > 0 
        ? Math.min(params.startTime, maxStart) 
        : Math.floor(Math.random() * (maxStart + 1))
      
      // create output path with appropriate extension
      const isVideo = this.isVideoFile(filePath)
      const outputExt = isVideo ? '.mp4' : '.mp3'
      const outputPath = path.join(this.TEMP_DIR, `clip_${Date.now()}${outputExt}`)
      
      // get ffmpeg command with effects
      const cmd = effectsManager.getFFmpegCommand(filePath, outputPath, {
        ...params,
        startTime,
        clipLength: params.clipLength
      })
      
      try {
        const { stderr } = await execAsync(cmd)
        
        if (!fs.existsSync(outputPath)) {
          console.error('clip creation failed:', stderr)
          effectsManager.storeFFmpegError(message.author.id, stderr)
          await message.reply('failed to create clip (╯°□°）╯︵ ┻━┻')
          return
        }
        
        // create attachment
        const attachment = new AttachmentBuilder(outputPath)
          .setName(`clip_${media.id}${outputExt}`)
        
        // prepare message with effects info
        const effectsText = params.effects.length > 0 
          ? ` with effects: ${params.effects.join(', ')}`
          : ''
        
        const filtersText = params.rawFilters
          ? ` with custom filters`
          : ''
        
        await message.reply({
          content: `${params.clipLength}s clip from **${media.title}** (#${media.id}) at ${startTime}s${effectsText}${filtersText}`,
          files: [attachment]
        })
        
        // clean up temp file after 10s
        setTimeout(() => {
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
          } catch (err) {
            console.error('failed to clean up temp file:', err)
          }
        }, 10000)
        
      } catch (err) {
        console.error('clip creation error:', err)
        effectsManager.storeFFmpegError(message.author.id, err.message || String(err))
        await message.reply('error creating clip (╯°□°）╯︵ ┻━┻')
      }
      
    } catch (err) {
      console.error('error handling random clip command:', err)
      await message.reply('error processing command (╯°□°）╯︵ ┻━┻')
    }
  }

  /**
   * handle ..o command to search and post media
   */
  private async handleSearchMediaCommand(message: Message): Promise<void> {
    if (!message.guildId) return
    
    try {
      // parsing message with effects manager
      const effectsManager = EffectsManager.getInstance()
      const params = effectsManager.parseCommandString(message.content)
      params.userId = message.author.id
            
      // search DB for media
      const mediaItems = await this.searchMedia(params.searchTerm)
      
      if (!mediaItems?.length) {
        await message.reply(`no matching media found for "${params.searchTerm || 'random'}" (￣ヘ￣)`)
        return
      }
      
      // pick a random media item
      const media = mediaItems[Math.floor(Math.random() * mediaItems.length)]
      const filePath = media.normalized_path || media.file_path
      
      if (!fs.existsSync(filePath)) {
        await message.reply('media file not found on disk (￣ヘ￣)')
        return
      }
      
      await message.channel.sendTyping()
      
      // check if we need to apply effects
      if (!params.effects.length && !params.rawFilters) {
        // just post the original file
        const attachment = new AttachmentBuilder(filePath)
          .setName(path.basename(filePath))
        
        await message.reply({
          content: `heres **${media.title}** (#${media.id})`,
          files: [attachment]
        })
        return
      }
      
      // we need to process with effects
      const isVideo = this.isVideoFile(filePath)
      const outputExt = isVideo ? '.mp4' : '.mp3'
      const outputPath = path.join(this.TEMP_DIR, `effect_${Date.now()}${outputExt}`)
      
      // get ffmpeg command with effects
      const cmd = effectsManager.getFFmpegCommand(filePath, outputPath, params)
      
      try {
        const { stderr } = await execAsync(cmd)
        
        if (!fs.existsSync(outputPath)) {
          console.error('effect processing failed:', stderr)
          effectsManager.storeFFmpegError(message.author.id, stderr)
          await message.reply('failed to process effects (╯°□°）╯︵ ┻━┻')
          return
        }
        
        // create attachment
        const attachment = new AttachmentBuilder(outputPath)
          .setName(`effect_${media.id}${outputExt}`)
        
        // effects info for message
        const effectsText = params.effects.length > 0 
          ? ` with effects: ${params.effects.join(', ')}`
          : ''
        
        const filtersText = params.rawFilters
          ? ` with custom filters`
          : ''
        
        await message.reply({
          content: `heres **${media.title}** (#${media.id})${effectsText}${filtersText}`,
          files: [attachment]
        })
        
        // clean up temp file after 10s
        setTimeout(() => {
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
          } catch (err) {
            console.error('failed to clean up temp file:', err)
          }
        }, 10000)
        
      } catch (err) {
        console.error('effect processing error:', err)
        effectsManager.storeFFmpegError(message.author.id, err.message || String(err))
        await message.reply('error processing effects (╯°□°）╯︵ ┻━┻')
      }
      
    } catch (err) {
      console.error('error handling search media command:', err)
      await message.reply('error processing command (╯°□°）╯︵ ┻━┻')
    }
  }

  /**
   * search for media in the database
   */
  private async searchMedia(searchTerm: string): Promise<any[]> {
    const db = DatabaseManager.getInstance()
    
    if (!searchTerm) {
      // get random media
      return await db.getRandomMedia(1)
    }
    
    // search by term
    return await db.searchMedia(searchTerm)
  }

  /**
   * check if file is a video based on extension
   */
  private isVideoFile(filePath: string): boolean {
    const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.m4v']
    const ext = path.extname(filePath).toLowerCase()
    return videoExtensions.includes(ext)
  }
}