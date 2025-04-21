import { DatabaseManager } from './src/database/databaseManager';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { AudioPlayerManager } from './src/utils/audioPlayerManager';

dotenv.config();

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), 'src/media');
const DB_PATH = path.join(process.cwd(), 'data.db');

async function migrate() {
  console.log('adding normalized_path column to database...');
  
  // direct connection to add column first
  const db = new sqlite3.Database(DB_PATH);
  await new Promise<void>((resolve, reject) => {
    db.run('ALTER TABLE media ADD COLUMN normalized_path TEXT', (err) => {
      if (err) {
        // column might already exist
        if (err.message.includes('duplicate column')) {
          console.log('column already exists, continuing...');
          resolve();
        } else {
          reject(err);
        }
      } else {
        console.log('added normalized_path column');
        resolve();
      }
    });
  });
  db.close();
  
  // now proceed with normal migration
  const dbManager = DatabaseManager.getInstance();
  await dbManager.init();
  
  // get all media entries
  const allMedia = await getAllMedia(dbManager);
  console.log(`found ${allMedia.length} media entries to migrate`);
  
  // 1. add their titles as primary answers (original migration)
  for (const media of allMedia) {
    // check if already has a primary answer
    const existingAnswers = await getMediaAnswers(dbManager, media.id);
    if (existingAnswers.length === 0) {
      const answerId = await dbManager.addPrimaryAnswer(media.id, media.title);
      console.log(`added primary answer "${media.title}" (${answerId}) for media #${media.id}`);
    }
  }
  
  // 2. normalize audio files (new migration)
  const normalizedDir = path.join(MEDIA_DIR, 'normalized');
  if (!fs.existsSync(normalizedDir)) {
    fs.mkdirSync(normalizedDir, { recursive: true });
  }
  
  const audioPlayer = AudioPlayerManager.getInstance();
  const ffmpeg = require('fluent-ffmpeg');
  
  console.log('starting audio normalization migration...');
  
  let normalized = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const media of allMedia) {
    // skip if already normalized
    if (media.normalized_path && fs.existsSync(media.normalized_path)) {
      console.log(`skipping already normalized media #${media.id}`);
      skipped++;
      continue;
    }
    
    // check if original file exists
    if (!fs.existsSync(media.file_path)) {
      console.error(`media #${media.id} file not found: ${media.file_path}`);
      errors++;
      continue;
    }
    
    try {
      console.log(`normalizing media #${media.id}: ${media.title}`);
      
      // get extension and create normalized file path
      const ext = path.extname(media.file_path);
      const normalizedFileName = `norm_${media.id}${ext}`;
      const normalizedPath = path.join(normalizedDir, normalizedFileName);
      
      // normalize volume
      await new Promise<void>((resolve, reject) => {
        // analyze volume
        ffmpeg.ffprobe(media.file_path, (err: any, metadata: any) => {
          if (err) {
            reject(new Error(`Failed to analyze media #${media.id}: ${err.message}`));
            return;
          }
          
          // store duration
          const durationMs = Math.floor((metadata?.format?.duration || 0) * 1000);
          audioPlayer.storeMediaDuration(media.id, durationMs);
          
          // detect volume
          ffmpeg(media.file_path)
            .audioFilters('volumedetect')
            .format('null')
            .output('/dev/null')
            .on('error', (err: any) => {
              reject(new Error(`Volume analysis failed for media #${media.id}: ${err.message}`));
            })
            .on('end', (stdout: any, stderr: any) => {
              const match = stderr.match(/max_volume: ([-\d.]+) dB/);
              if (!match || !match[1]) {
                reject(new Error(`Could not detect volume level for media #${media.id}`));
                return;
              }
              
              const maxVolume = parseFloat(match[1]);
              const targetVolume = -3; // target peak volume in dB
              const adjustment = targetVolume - maxVolume;
              
              // normalize with calculated adjustment
              ffmpeg(media.file_path)
                .audioFilters(`volume=${adjustment}dB`)
                .output(normalizedPath)
                .on('error', (err: any) => {
                  reject(new Error(`Normalization failed for media #${media.id}: ${err.message}`));
                })
                .on('end', async () => {
                  // update database
                  await dbManager.updateNormalizedPath(media.id, normalizedPath);
                  normalized++;
                  resolve();
                })
                .run();
            })
            .run();
        });
      });
      
    } catch (error) {
      console.error(`Error normalizing media #${media.id}:`, error);
      errors++;
    }
  }
  
  console.log(`normalization migration complete: ${normalized} normalized, ${skipped} skipped, ${errors} errors`);
  console.log('migration complete (⌐■_■)');
}

async function getAllMedia(db: DatabaseManager): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db['db'].all('SELECT * FROM media', (err: Error | null, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function getMediaAnswers(db: DatabaseManager, mediaId: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db['db'].all('SELECT * FROM media_answers WHERE media_id = ?', [mediaId], (err: Error | null, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

migrate().catch(error => {
  console.error('migration failed:', error);
  process.exit(1);
});