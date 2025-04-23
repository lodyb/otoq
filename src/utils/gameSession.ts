import { Player } from './types';

export interface MediaItem {
  id: number;
  title: string;
  file_path: string;
  normalized_path?: string;
  metadata?: string;
  year?: number;
}

export class GameSession {
  private id: number;
  private guildId: string;
  private channelId: string;
  private players: Map<string, Player>;
  private skipVotes: Set<string>;
  private playlist: MediaItem[];
  private currentRound: number;
  private totalRounds: number;
  private guessedAnswers: Set<number>; // track which media ids have been guessed
  private clipMode: boolean;
  private lastPlayedMediaId: number | null = null;

  constructor(id: number, guildId: string, channelId: string, playlist: MediaItem[], totalRounds: number, clipMode: boolean = false) {
    this.id = id;
    this.guildId = guildId;
    this.channelId = channelId;
    this.players = new Map();
    this.skipVotes = new Set();
    this.playlist = playlist;
    this.currentRound = 0; // will increment to 1 on first nextRound() call
    this.totalRounds = totalRounds;
    this.guessedAnswers = new Set();
    this.clipMode = clipMode;
  }

  public getId(): number {
    return this.id;
  }

  public getGuildId(): string {
    return this.guildId;
  }

  public getChannelId(): string {
    return this.channelId;
  }

  public getCurrentRound(): number {
    return this.currentRound;
  }

  public getTotalRounds(): number {
    return this.totalRounds;
  }

  public getCurrentMedia(): MediaItem | undefined {
    if (this.currentRound <= 0 || this.currentRound > this.playlist.length) {
      return undefined;
    }
    return this.playlist[this.currentRound - 1];
  }

  public getPreviousMediaId(): number | null {
    return this.lastPlayedMediaId;
  }

  public nextRound(): MediaItem | undefined {
    // save current media id before advancing
    const currentMedia = this.getCurrentMedia();
    if (currentMedia) {
      this.lastPlayedMediaId = currentMedia.id;
    }
    
    // reset skip votes for new round
    this.skipVotes.clear();
    
    // reset guessed answers for new round
    this.guessedAnswers.clear();
    
    // increment round
    this.currentRound++;
    
    // check if we've reached the end
    // game ends only when we exceed BOTH totalRounds AND playlist length
    if (this.currentRound > this.totalRounds) {
      console.log(`nextRound: ending game because currentRound (${this.currentRound}) > totalRounds (${this.totalRounds})`);
      return undefined;
    }
    
    // also end if we've reached the end of the playlist
    if (this.currentRound > this.playlist.length) {
      console.log(`nextRound: ending game because currentRound (${this.currentRound}) > playlist length (${this.playlist.length})`);
      return undefined;
    }
    
    return this.getCurrentMedia();
  }
  
  public isLastRound(): boolean {
    // check if THIS is the last round (not already past it)
    return this.currentRound === this.totalRounds || 
           (this.currentRound > 0 && this.currentRound === this.playlist.length);
  }

  public addPlayer(userId: string, username: string): void {
    if (!this.players.has(userId)) {
      this.players.set(userId, { id: userId, username, score: 0 });
    }
  }

  public addPointToPlayer(userId: string): void {
    const player = this.players.get(userId);
    if (player) {
      player.score++;
    }
  }

  public getPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  public getLeaderboard(): Player[] {
    return this.getPlayers().sort((a, b) => b.score - a.score);
  }

  public addSkipVote(userId: string): number {
    // only count each user's vote once
    this.skipVotes.add(userId);
    return this.skipVotes.size;
  }

  public getSkipVotes(): number {
    return this.skipVotes.size;
  }

  public markAnswerAsGuessed(mediaId: number): void {
    this.guessedAnswers.add(mediaId);
  }

  public isAnswerAlreadyGuessed(mediaId: number): boolean {
    return this.guessedAnswers.has(mediaId);
  }

  public resetSkipVotes(): void {
    this.skipVotes.clear();
  }

  public isClipMode(): boolean {
    return this.clipMode;
  }
}