#!/usr/bin/env node
// filepath: /home/lody/otoq/scripts/normalize-media.ts
import { DatabaseManager } from '../src/database/databaseManager'
import { MediaProcessor } from '../src/utils/mediaProcessor'
import { AudioPlayerManager } from '../src/utils/audioPlayerManager'
import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'
import ffmpeg from 'fluent-ffmpeg'

dotenv.config()

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), 'src/media')
const CORRUPT_DIR = path.join(MEDIA_DIR, 'corrupt')

interface MediaItemToProcess {
  id: number
  file_path: string
  processed_path?: string
  duration?: number
}

// quick validation check without full processing
async function isFileCorrupt(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return true
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`validation timed out for: ${filePath}`)
      resolve(true) // timeout = corrupt
    }, 10000)
    
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      clearTimeout(timeout)
      if (err) {
        console.log(`validation error for ${filePath}: ${err.message}`)
        resolve(true) // has error = corrupt
        return
      }
      
      if (!metadata?.format?.duration) {
        console.log(`no duration data for ${filePath}`)
        resolve(true) // no duration = corrupt
        return
      }
      
      resolve(false) // passed validation
    })
  })
}

// move corrupt file to corrupt dir and remove from db
async function handleCorruptFile(dbManager: DatabaseManager, mediaId: number, filePath: string): Promise<void> {
  try {
    // make sure file actually exists
    if (!fs.existsSync(filePath)) {
      // file is already gone, just remove from db
      console.log(`file doesn't exist on disk: ${filePath}, removing from db only`)
      await deleteMediaFromDb(dbManager, mediaId)
      console.log(`corrupt file #${mediaId} removed from database`)
      return
    }
    
    // create corrupt dir if it doesn't exist
    if (!fs.existsSync(CORRUPT_DIR)) {
      fs.mkdirSync(CORRUPT_DIR, { recursive: true })
    }
    
    // move file to corrupt dir
    const fileName = path.basename(filePath)
    const corruptPath = path.join(CORRUPT_DIR, fileName)
    
    console.log(`moving corrupt file #${mediaId} to ${corruptPath}`)
    fs.renameSync(filePath, corruptPath)
    
    // remove from database
    console.log(`removing corrupt file #${mediaId} from database`)
    await deleteMediaFromDb(dbManager, mediaId)
    
    console.log(`corrupt file #${mediaId} handled`)
  } catch (err) {
    console.error(`failed to handle corrupt file #${mediaId}: ${err}`)
  }
}

// delete media entry from database
async function deleteMediaFromDb(db: DatabaseManager, mediaId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // delete from media_answers first (foreign key constraint)
    db['db'].run('DELETE FROM media_answers WHERE media_id = ?', [mediaId], (err) => {
      if (err) {
        reject(err)
        return
      }
      
      // then delete from media table
      db['db'].run('DELETE FROM media WHERE id = ?', [mediaId], (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  })
}

async function normalizeAllMedia() {
  console.log('starting media normalization and conversion script... (⌐■_■)')
  
  // initialize database
  const dbManager = DatabaseManager.getInstance()
  await dbManager.init()
  
  // get all media entries
  const allMedia = await getAllMedia(dbManager)
  console.log(`found ${allMedia.length} media entries in database`)
  
  // directory for normalized files
  const normalizedDir = path.join(MEDIA_DIR, 'normalized')
  if (!fs.existsSync(normalizedDir)) {
    fs.mkdirSync(normalizedDir, { recursive: true })
  }
  
  // for storing durations 
  const audioPlayer = AudioPlayerManager.getInstance()
  const mediaProcessor = MediaProcessor.getInstance()
  
  // handle corrupt files option
  const cleanupCorrupt = process.argv.includes('--cleanup-corrupt')
  
  if (cleanupCorrupt) {
    console.log('checking for corrupt files...')
    let corruptCount = 0
    
    for (const media of allMedia) {
      if (await isFileCorrupt(media.file_path)) {
        await handleCorruptFile(dbManager, media.id, media.file_path)
        corruptCount++
      }
    }
    
    if (corruptCount > 0) {
      console.log(`cleaned up ${corruptCount} corrupt files (ノ｀Д´)ノ︵`)
      // reload media list after cleanup
      allMedia.splice(0, allMedia.length, ...await getAllMedia(dbManager))
    } else {
      console.log('no corrupt files found (・ω・)b')
    }
  }
  
  // prepare media items for batch processing
  const mediaToProcess: MediaItemToProcess[] = allMedia
    .filter(media => {
      // if we're re-processing, we need to handle existing normalized files
      const forceReprocess = process.argv.includes('--force')
      
      if (media.normalized_path && fs.existsSync(media.normalized_path) && !forceReprocess) {
        // check if we need to convert specific formats anyway
        const ext = path.extname(media.normalized_path).toLowerCase()
        
        // we now want to convert any non-standard format (not mp4/mp3)
        if (!['.mp4', '.mp3'].includes(ext)) {
          console.log(`media #${media.id} needs format conversion from ${ext} to mp4/mp3`)
          return true
        }
        
        console.log(`skipping already normalized media #${media.id}`)
        return false
      }
      
      // skip if original file doesn't exist
      if (!fs.existsSync(media.file_path)) {
        console.error(`media #${media.id} file not found: ${media.file_path}`)
        return false
      }
      
      return true
    })
    .map(media => ({
      id: media.id,
      file_path: media.file_path,
      processed_path: undefined,
      duration: undefined
    }))
  
  console.log(`processing ${mediaToProcess.length} media files... (｡•̀ᴗ-)✧`)
  
  // batch process all media files
  if (mediaToProcess.length > 0) {
    const result = await mediaProcessor.batchProcessMedia(mediaToProcess, normalizedDir)
    
    // update database with normalized paths
    for (const media of mediaToProcess) {
      if (media.processed_path) {
        await dbManager.updateNormalizedPath(media.id, media.processed_path)
        
        // store the duration
        if (media.duration) {
          audioPlayer.storeMediaDuration(media.id, media.duration)
        }
      }
    }
    
    console.log(`media processing complete:`)
    console.log(`- processed: ${result.processed}`)
    console.log(`- skipped: ${result.skipped}`)
    console.log(`- errors: ${result.errors.length}`)
    
    // log any errors
    if (result.errors.length > 0) {
      console.log('errors:')
      result.errors.forEach(err => {
        console.error(`  media #${err.id}: ${err.error}`)
      })
    }
  } else {
    console.log('no media files need processing (≧ω≦)')
  }
  
  console.log('normalization complete (⌐■_■)')
  process.exit(0)
}

async function getAllMedia(db: DatabaseManager): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db['db'].all('SELECT * FROM media', (err: Error | null, rows: any[]) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

// run the script
normalizeAllMedia().catch(error => {
  console.error('media normalization failed:', error)
  process.exit(1)
})