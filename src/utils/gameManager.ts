import { GameSession, MediaItem } from './gameSession';
import { DatabaseManager } from '../database/databaseManager';
import { AudioPlayerManager } from './audioPlayerManager';
import { TextChannel, ThreadChannel } from 'discord.js';

export class GameManager {
  private static instance: GameManager;
  private sessions: Map<string, GameSession>;
  private db: DatabaseManager;
  private skipVotesInProgress: Map<string, boolean>;
  private roundTransitionInProgress: Map<string, boolean> = new Map();
  private ROUND_TRANSITION_DELAY = 3000; // 3 second delay between rounds
  
  private constructor() {
    this.sessions = new Map();
    this.db = DatabaseManager.getInstance();
    this.skipVotesInProgress = new Map();
  }

  public static getInstance(): GameManager {
    if (!GameManager.instance) {
      GameManager.instance = new GameManager();
    }
    return GameManager.instance;
  }
  
  private getSessionKey(guildId: string, channelId: string, channel?: TextChannel | ThreadChannel): string {
    if (channel?.isThread()) {
      return `${guildId}-${channel.parentId}`;
    }
    return `${guildId}-${channelId}`;
  }
  
  public async createSession(
    guildId: string,
    channelId: string,
    rounds: number = 20,
    tags?: string[],
    yearStart?: number,
    yearEnd?: number,
    channel?: TextChannel | ThreadChannel,
    clipMode: boolean = false
  ): Promise<GameSession | null> {
    const key = this.getSessionKey(guildId, channelId, channel);
    
    // don't allow multiple games in same channel
    if (this.sessions.has(key)) {
      return null;
    }
    
    // reset corrupted media
    AudioPlayerManager.getInstance().resetCorruptedMediaList();
    
    // request 2x the tracks to make sure we have enough
    const maxAttempts = 3; // try up to 3 times
    let playlist: MediaItem[] = [];
    
    // loop until we have enough tracks or max attempts reached
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // get random media
      playlist = await this.db.getRandomMedia(tags, yearStart, yearEnd, rounds * 2);
      
      // if we got enough, break out
      if (playlist.length >= rounds) {
        console.log(`got ${playlist.length} tracks on attempt ${attempt+1}`);
        break;
      }
      
      console.log(`not enough tracks (${playlist.length}/${rounds}) on attempt ${attempt+1}, trying again`);
    }
    
    // still not enough tracks
    if (playlist.length < rounds) {
      console.log(`couldn't get enough tracks after ${maxAttempts} attempts (╯°□°）╯︵ ┻━┻`);
      
      // use what we have if at least 5 tracks
      if (playlist.length < 5) {
        return null;
      }
      
      // adjust rounds to match what we have
      rounds = playlist.length;
      console.log(`adjusted rounds to ${rounds} to match available tracks`);
    }
    
    // randomize for production, sort for tests
    if (process.env.NODE_ENV === 'test') {
      playlist.sort((a, b) => a.id - b.id);
    } else {
      this.shuffleArray(playlist);
    }
    
    // take only what we need
    const finalPlaylist = playlist.slice(0, rounds);
    console.log(`final playlist length: ${finalPlaylist.length}`);
    
    // create session in db
    const sessionId = await this.db.createGameSession(guildId, channelId, rounds);
    const session = new GameSession(sessionId, guildId, channelId, finalPlaylist, rounds, clipMode);
    
    this.sessions.set(key, session);
    return session;
  }
  
  private shuffleArray(array: any[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
  
  public getSession(guildId: string, channelId: string, channel?: TextChannel | ThreadChannel): GameSession | undefined {
    const key = this.getSessionKey(guildId, channelId, channel);
    return this.sessions.get(key);
  }
  
  public async endSession(guildId: string, channelId: string, channel?: TextChannel | ThreadChannel): Promise<boolean> {
    const key = this.getSessionKey(guildId, channelId, channel);
    const session = this.sessions.get(key);
    
    if (!session) {
      return false;
    }
    
    // update db
    await this.db.updateGameSession(session.getId(), session.getCurrentRound(), true);
    
    // update players
    for (const player of session.getPlayers()) {
      await this.db.updateUser(player.id, player.username, player.score > 0);
    }
    
    // remove session
    this.sessions.delete(key);
    return true;
  }
  
  public async advanceRound(guildId: string, channelId: string, textChannel: TextChannel | ThreadChannel, userId?: string, username?: string): Promise<boolean> {
    const key = this.getSessionKey(guildId, channelId, textChannel);
    const session = this.getSession(guildId, channelId, textChannel);
    
    if (!session) return false;
    
    // prevent multiple simultaneous round advances
    if (this.roundTransitionInProgress.get(key)) {
      console.log(`round transition already in progress for ${key}`);
      return false;
    }
    
    this.roundTransitionInProgress.set(key, true);
    
    // handle correct guess case  
    if (userId && username) {
      session.addPlayer(userId, username);
      session.addPointToPlayer(userId);
      
      // mark current media as guessed
      const currentMedia = session.getCurrentMedia();
      if (currentMedia) {
        session.markAnswerAsGuessed(currentMedia.id);
      }
      
      await this.db.updateUser(userId, username, true);
    }
    
    // reset skip votes
    session.resetSkipVotes();
    
    // update db
    await this.db.updateGameSession(session.getId(), session.getCurrentRound());
    
    // check if last round using the fixed isLastRound method
    if (session.isLastRound()) {
      console.log(`advanceRound: this is the last round (${session.getCurrentRound()} of ${session.getTotalRounds()})`);
    }
    
    // get next media - this also advances the round counter
    const nextMedia = session.nextRound();
    
    if (!nextMedia) {
      console.log(`advanceRound: no next media available, ending game after round ${session.getCurrentRound()-1}`);
      this.roundTransitionInProgress.set(key, false);
      return false;
    }
    
    // introduce a delay between rounds
    console.log(`waiting ${this.ROUND_TRANSITION_DELAY}ms before starting next round ${session.getCurrentRound()}`);
    return new Promise((resolve) => {
      setTimeout(async () => {
        try {
          // get audio player before timeout
          const audioPlayer = AudioPlayerManager.getInstance();
          
          // ensure player is stopped from previous round
          audioPlayer.stopPlaying(guildId);
          
          // play new media - with a small delay to ensure previous playback is fully stopped
          setTimeout(async () => {
            try {
              // play new media
              const success = await audioPlayer.playMedia(guildId, nextMedia, session.isClipMode());
              
              // resolve promise regardless to prevent hanging
              this.roundTransitionInProgress.set(key, false);
              resolve(success);
            } catch (err) {
              console.error('error playing media during round advance:', err);
              this.roundTransitionInProgress.set(key, false);
              resolve(false);
            }
          }, 500); // small additional delay to ensure clean state
        } catch (err) {
          console.error('error during round transition:', err);
          this.roundTransitionInProgress.set(key, false);
          resolve(false);
        }
      }, this.ROUND_TRANSITION_DELAY);
    });
  }
  
  public async processGuess(guildId: string, channelId: string, userId: string, username: string, guess: string, channel?: TextChannel | ThreadChannel): Promise<{correct: boolean, close: boolean}> {
    const session = this.getSession(guildId, channelId, channel);
    
    if (!session || !session.getCurrentMedia()) {
      return {correct: false, close: false};
    }
    
    // add player
    session.addPlayer(userId, username);
    
    const currentMedia = session.getCurrentMedia()!;
    const normalizedGuess = this.normalizeString(guess);
    
    // don't allow points if already guessed
    if (session.isAnswerAlreadyGuessed(currentMedia.id)) {
      return {correct: false, close: false};
    }
    
    // check answer
    const result = await this.db.checkAnswer(currentMedia.id, normalizedGuess);
    
    if (result.correct) {
      // mark as guessed
      session.markAnswerAsGuessed(currentMedia.id);
      session.addPointToPlayer(userId);
      
      // reset skip votes
      session.resetSkipVotes();
      
      // update db
      await this.db.updateUser(userId, username, true);
      await this.db.updateGameSession(session.getId(), session.getCurrentRound());
    }
    
    return result;
  }
  
  public async processSkip(guildId: string, channelId: string, userId: string, channel?: TextChannel | ThreadChannel): Promise<{skipped: boolean, votes: number, required: number}> {
    const key = this.getSessionKey(guildId, channelId, channel);
    
    // don't allow rapid skip votes
    if (this.skipVotesInProgress.get(key)) {
      return {skipped: false, votes: 0, required: 2};
    }
    
    const session = this.getSession(guildId, channelId, channel);
    
    if (!session) {
      return {skipped: false, votes: 0, required: 2};
    }
    
    // don't allow skipping already guessed media
    const currentMedia = session.getCurrentMedia();
    if (currentMedia && session.isAnswerAlreadyGuessed(currentMedia.id)) {
      return {skipped: false, votes: 0, required: 2};
    }
    
    // add vote
    const votes = session.addSkipVote(userId);
    const playersCount = session.getPlayers().length;
    const requiredVotes = Math.max(2, Math.ceil(playersCount / 3));
    
    // check if enough votes
    if (votes >= requiredVotes) {
      // skip protection
      this.skipVotesInProgress.set(key, true);
      
      // update db
      await this.db.updateGameSession(session.getId(), session.getCurrentRound());
      
      // wait before continuing to avoid race conditions
      if (this.ROUND_TRANSITION_DELAY > 0) {
        await new Promise(resolve => setTimeout(resolve, this.ROUND_TRANSITION_DELAY));
      }
      
      this.skipVotesInProgress.set(key, false);
      return {skipped: true, votes, required: requiredVotes};
    }
    
    return {skipped: false, votes, required: requiredVotes};
  }
  
  private normalizeString(str: string): string {
    return str.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, '');
  }
}