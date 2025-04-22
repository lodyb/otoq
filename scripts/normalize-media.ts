#!/usr/bin/env node
// filepath: /home/lody/otoq/scripts/normalize-media.ts
import { DatabaseManager } from '../src/database/databaseManager'
import { MediaProcessor } from '../src/utils/mediaProcessor'
import { AudioPlayerManager } from '../src/utils/audioPlayerManager'
import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'

dotenv.config()

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), 'src/media')

async function normalizeAllMedia() {
  console.log('starting media normalization and conversion script...')
  
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
  
  // prepare media items for batch processing
  const mediaToProcess = allMedia
    .filter(media => {
      // if we're re-processing, we need to handle existing normalized files
      const forceReprocess = process.argv.includes('--force')
      
      if (media.normalized_path && fs.existsSync(media.normalized_path) && !forceReprocess) {
        // check if we need to convert the format even though it's already normalized
        const ext = path.extname(media.normalized_path).toLowerCase()
        if (['.webm', '.mkv', '.m4a'].includes(ext)) {
          console.log(`media #${media.id} needs format conversion from ${ext} to mp4`)
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
      file_path: media.file_path
    }))
  
  console.log(`processing ${mediaToProcess.length} media files...`)
  
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
    console.log('no media files need processing')
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