import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// paths
const TEMP_DIR = path.join(process.cwd(), 'temp');

// setup
const ONE_DAY = 24 * 60 * 60 * 1000; // ms
const cleanup = async () => {
  console.log('starting temp file cleanup (≧▽≦)');
  
  if (!fs.existsSync(TEMP_DIR)) {
    console.log('no temp directory found, nothing to clean');
    return;
  }
  
  const now = Date.now();
  const files = fs.readdirSync(TEMP_DIR);
  console.log(`found ${files.length} files in temp directory`);
  
  let removed = 0;
  let errors = 0;
  
  for (const file of files) {
    const filePath = path.join(TEMP_DIR, file);
    
    try {
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtimeMs;
      
      // remove files older than 1 day
      if (fileAge > ONE_DAY) {
        fs.unlinkSync(filePath);
        removed++;
        console.log(`removed old temp file: ${file}`);
      }
    } catch (err) {
      console.error(`error processing ${file}: ${err}`);
      errors++;
    }
  }
  
  console.log(`cleanup complete: removed ${removed} files, ${errors} errors`);
};

// run it
cleanup().catch(err => {
  console.error('cleanup failed:', err);
  process.exit(1);
});