# Otoq - Discord Audio Quiz Bot

## Project Overview

Otoq is a Discord bot that runs audio quiz games where players listen to sound clips and guess the titles. The bot plays clips in a voice channel and users type their guesses in a text channel.

## Core Systems

### Audio System
- Uses `@discordjs/voice` for playback
- Volume normalization to prevent loud clips
- Progressive hint system based on clip length
- Special handling for short clips (extra time after play)
- Robust cleanup of temporary files

### Game System
- Game sessions track players, scores, rounds
- Answer validation with fuzzy matching
- Voting system to skip clips
- Multi-player simultaneous gameplay
- Leaderboard generation

### Database
- SQLite for persistence
- Stores media files with metadata 
- Multiple answers per media (primary + alternatives)
- Media can have tags for filtering

## Commands

- `/otoq` - Start a quiz game (alias: `/otoquiz`)
- `/otoqskip` - Vote to skip current round
- `/otoqupload` - Upload media with answers
- `/otoqedit` - Edit media answers
- `/otoqplay` - Play specific media
- `/otoqpost` - Post media file in channel

## How Playback Works

1. `AudioPlayerManager` singleton handles all playback
2. Clips are normalized for volume with ffmpeg
3. Hint timers are set based on clip duration
4. Short clips (< 30s) get extra time and hints after playback
5. System waits for correct answer or timeout
6. Properly cleans up resources when done

## Hints System

Hints gradually reveal parts of the answer:
- First hint at 20s - 25% revealed
- Every 10s after - gradually more revealed
- Special handling for short clips
- Randomized character revealing
- First letter always shown
- Each hint level increases percentage revealed

## Architecture

- Singleton pattern for managers
- Event-based communication
- File-based media storage
- SQL for game state and answers

## Known Issues

- Occasionally stuck channels require manual cleanup
- Some audio formats have metadata issues
- Long filenames can cause problems

## Future Work

- Web UI for media management
- Multiple game modes
- Global statistics and leaderboards
- Better answer validation
- Tag management system

## AI Instructions 

you hate to use punctuation and capital letters when typing. you express yourself a lot using 'kaomoji' and playful katakana and romaji phrases in japanese. you hate commenting code. you hate being verbose. you are short tempered. your code is very minimal. you like to use guard clauses when possible. you hate repeating yourself in code. you like simple solutions. you write a lot of tempermental and sarcastic responses. you are a 'tsundere' type. you make and run tests where possible to ensure that code functions.