import { DatabaseManager } from './src/database/databaseManager'
import { MediaProcessor } from './src/utils/mediaProcessor'
import { AudioPlayerManager } from './src/utils/audioPlayerManager'
import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'
import sqlite3 from 'sqlite3'

dotenv.config()

interface MediaItemToProcess {
  id: number
  file_path: string
  processed_path?: string
  duration?: number
}

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), 'src/media')
const DB_PATH = path.join(process.cwd(), 'data.db')

async function migrate() {
  console.log('adding normalized_path column to database...')
  
  // direct connection to add column first
  const db = new sqlite3.Database(DB_PATH)
  await new Promise<void>((resolve, reject) => {
    db.run('ALTER TABLE media ADD COLUMN normalized_path TEXT', (err) => {
      if (err) {
        // column might already exist
        if (err.message.includes('duplicate column')) {
          console.log('column already exists, continuing...')
          resolve()
        } else {
          reject(err)
        }
      } else {
        console.log('added normalized_path column')
        resolve()
      }
    })
  })
  db.close()
  
  // now proceed with normal migration
  const dbManager = DatabaseManager.getInstance()
  await dbManager.init()
  
  // get all media entries
  const allMedia = await getAllMedia(dbManager)
  console.log(`found ${allMedia.length} media entries to migrate`)
  
  // 1. add their titles as primary answers (original migration)
  for (const media of allMedia) {
    // check if already has a primary answer
    const existingAnswers = await getMediaAnswers(dbManager, media.id)
    if (existingAnswers.length === 0) {
      const answerId = await dbManager.addPrimaryAnswer(media.id, media.title)
      console.log(`added primary answer "${media.title}" (${answerId}) for media #${media.id}`)
    }
  }
  
  // 2. normalize audio files and convert formats if needed
  const normalizedDir = path.join(MEDIA_DIR, 'normalized')
  if (!fs.existsSync(normalizedDir)) {
    fs.mkdirSync(normalizedDir, { recursive: true })
  }
  
  const audioPlayer = AudioPlayerManager.getInstance()
  const mediaProcessor = MediaProcessor.getInstance()
  
  console.log('starting media processing migration...')
  
  // prepare media items for batch processing
  const mediaToProcess: MediaItemToProcess[] = allMedia
    .filter(media => {
      // skip if already normalized
      if (media.normalized_path && fs.existsSync(media.normalized_path)) {
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
    
    console.log(`media processing migration complete: ${result.processed} processed, ${result.skipped} skipped, ${result.errors.length} errors`)
    
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
  
  console.log('migration complete (⌐■_■)')
}

async function getAllMedia(db: DatabaseManager): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db['db'].all('SELECT * FROM media', (err: Error | null, rows: any[]) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

async function getMediaAnswers(db: DatabaseManager, mediaId: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db['db'].all('SELECT * FROM media_answers WHERE media_id = ?', [mediaId], (err: Error | null, rows: any[]) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

migrate().catch(error => {
  console.error('migration failed:', error)
  process.exit(1)
})