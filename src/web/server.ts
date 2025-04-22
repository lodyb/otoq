import express from 'express';
import path from 'path';
import fs from 'fs';
import fileUpload from 'express-fileupload';
import cors from 'cors';
import { DatabaseManager } from '../database/databaseManager';
import { AudioPlayerManager } from '../utils/audioPlayerManager';
import { MediaProcessor } from '../utils/mediaProcessor';
import dotenv from 'dotenv';

dotenv.config();

// avoid typescript errors by using less specific types
const app = express();
const port = parseInt(process.env.WEB_PORT || '3000', 10);
const host = process.env.WEB_HOST || '0.0.0.0'; // use your public ip by default
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), 'src/media');

// ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// middlewares
app.use(cors());
app.use(express.json());

// fix for static files path - need to handle both dev and prod environments
const webRoot = path.join(__dirname, '..', 'web');
const publicPathDev = path.join(webRoot, 'public');
const publicPathProd = path.join(__dirname, 'public'); 

// check if either path exists and use the one that does
let publicPath = fs.existsSync(publicPathDev) ? publicPathDev : publicPathProd;
if (!fs.existsSync(publicPath)) {
  // fallback to absolute path as last resort
  publicPath = path.join(process.cwd(), 'src', 'web', 'public');
  
  // log which path we're using
  console.log(`using web static files from: ${publicPath}`);
  
  // copy index.html to dist directory if needed
  const distPublicPath = path.join(process.cwd(), 'dist', 'web', 'public');
  if (!fs.existsSync(distPublicPath)) {
    try {
      fs.mkdirSync(distPublicPath, { recursive: true });
    } catch (err) {
      console.error('failed to create dist public dir', err);
    }
  }
  
  // copy index.html from src to dist if it exists in src but not in dist
  const srcIndexPath = path.join(publicPath, 'index.html');
  const distIndexPath = path.join(distPublicPath, 'index.html');
  
  if (fs.existsSync(srcIndexPath) && !fs.existsSync(distIndexPath)) {
    try {
      fs.copyFileSync(srcIndexPath, distIndexPath);
      console.log(`copied index.html to dist directory`);
      publicPath = distPublicPath;
    } catch (err) {
      console.error('failed to copy index.html to dist', err);
    }
  }
}

// serve static files from the right path
console.log(`serving static files from ${publicPath}`);
app.use(express.static(publicPath));

app.use(fileUpload({
  limits: { fileSize: 250 * 1024 * 1024 }, // 100MB max
  useTempFiles: true,
  tempFileDir: path.join(process.cwd(), 'temp'),
  abortOnLimit: true,
  safeFileNames: true,
  preserveExtension: true,
}));

// catch-all route for the SPA
app.get('/', (req: any, res: any) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// bypass typescript typings with any
app.post('/upload', (req: any, res: any) => {
  try {
    if (!req.files || !req.files.media) {
      return res.status(400).json({ error: 'no file uploaded (ノಠ益ಠ)ノ彡┻━┻' })
    }
    
    const mediaFile = req.files.media
    const answers = req.body.answers?.split(/[\n,]/)
                      .map((ans: string) => ans.trim())
                      .filter((ans: string) => ans.length > 0) || []
                      
    if (answers.length === 0) {
      return res.status(400).json({ error: 'you need to provide at least one answer (￣ヘ￣)' })
    }
    
    // move file to media directory
    const fileName = `${Date.now()}_${mediaFile.name}`
    const filePath = path.join(MEDIA_DIR, fileName)
    
    mediaFile.mv(filePath, async (err: any) => {
      if (err) {
        console.error('file move error:', err)
        return res.status(500).json({ error: 'failed to save file (╯°□°）╯︵ ┻━┻' })
      }
      
      const title = answers[0]
      const altAnswers = answers.slice(1)
      
      try {
        // ensure normalized directory exists
        const normalizedDir = path.join(MEDIA_DIR, 'normalized')
        if (!fs.existsSync(normalizedDir)) {
          fs.mkdirSync(normalizedDir, { recursive: true })
        }
        
        // process the media using our new utility
        const mediaProcessor = MediaProcessor.getInstance()
        const result = await mediaProcessor.normalizeAndConvert(filePath, normalizedDir)
        
        // add to database
        const db = DatabaseManager.getInstance()
        const mediaId = await db.addMedia(title, filePath)
        
        // update normalized path in database
        await db.updateNormalizedPath(mediaId, result.outputPath)
        
        // store duration
        const audioPlayer = AudioPlayerManager.getInstance()
        audioPlayer.storeMediaDuration(mediaId, result.duration)
        
        // add primary answer
        await db.addPrimaryAnswer(mediaId, title)
        
        // add alternative answers
        for (const alt of altAnswers) {
          await db.addAlternativeAnswer(mediaId, alt)
        }
        
        res.json({ 
          success: true,
          mediaId,
          title,
          message: `added ${title} (ID: ${mediaId}) to quiz db (⌐■_■)`
        })
      } catch (error) {
        // cleanup file on error
        try {
          fs.unlinkSync(filePath)
        } catch (err) {
          // ignore cleanup errors
        }
        
        console.error('processing error:', error)
        res.status(500).json({ error: `failed during processing: ${error}` })
      }
    })
  } catch (error) {
    console.error('upload error:', error)
    res.status(500).json({ error: 'failed to process upload (╯°□°）╯︵ ┻━┻' })
  }
})

// health check endpoint
app.get('/health', (req: any, res: any) => {
  res.json({ status: 'ok', message: 'otoq upload server running (￣ー￣)ゞ' });
});

export function startServer() {
  return new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.log(`web server running at http://${host}:${port} (⌐■_■)`);
      resolve();
    });
  });
}
