#!/usr/bin/env node
import * as cron from 'node-cron';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// add node-cron to manage scheduled tasks
// to install: npm install node-cron @types/node-cron

const ROOT_DIR = process.cwd();
const LOG_DIR = path.join(ROOT_DIR, 'logs');

// create logs dir if needed
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logMessage(message: string): void {
  const now = new Date();
  const timestamp = now.toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  
  // console log
  console.log(message);
  
  // also write to file
  const logFile = path.join(LOG_DIR, `scheduler-${now.toISOString().split('T')[0]}.log`);
  fs.appendFileSync(logFile, logLine);
}

// daily cleanup at 3am
cron.schedule('0 3 * * *', () => {
  logMessage('running scheduled cleanup task...');
  try {
    execSync('npm run cleanup', { stdio: 'inherit' });
    logMessage('cleanup completed');
  } catch (err) {
    const error = err as Error;
    logMessage(`cleanup failed: ${error.message}`);
  }
});

logMessage('scheduler started (～￣▽￣)～ will run tasks at scheduled times');

// keep process alive
process.stdin.resume();