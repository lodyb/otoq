import { GameSession, MediaItem } from '../utils/gameSession';

describe('GameSession', () => {
  const mockPlaylist: MediaItem[] = [
    { id: 1, title: 'test song 1', file_path: '/path/to/song1.mp3' },
    { id: 2, title: 'test song 2', file_path: '/path/to/song2.mp3' },
    { id: 3, title: 'test song 3', file_path: '/path/to/song3.mp3' },
  ];

  test('should initialize with correct values', () => {
    const session = new GameSession(123, 'guild1', 'channel1', mockPlaylist, 3);
    
    expect(session.getId()).toBe(123);
    expect(session.getGuildId()).toBe('guild1');
    expect(session.getChannelId()).toBe('channel1');
    expect(session.getCurrentRound()).toBe(0);
    expect(session.getTotalRounds()).toBe(3);
    expect(session.getCurrentMedia()).toBeUndefined();
  });

  test('should advance rounds correctly', () => {
    const session = new GameSession(123, 'guild1', 'channel1', mockPlaylist, 3);
    
    // First round
    const media1 = session.nextRound();
    expect(media1).toEqual(mockPlaylist[0]);
    expect(session.getCurrentRound()).toBe(1);
    expect(session.getCurrentMedia()).toEqual(mockPlaylist[0]);
    
    // Second round
    const media2 = session.nextRound();
    expect(media2).toEqual(mockPlaylist[1]);
    expect(session.getCurrentRound()).toBe(2);
    expect(session.getCurrentMedia()).toEqual(mockPlaylist[1]);
    
    // Third round
    const media3 = session.nextRound();
    expect(media3).toEqual(mockPlaylist[2]);
    expect(session.getCurrentRound()).toBe(3);
    expect(session.getCurrentMedia()).toEqual(mockPlaylist[2]);
    
    // Should end after last round
    const mediaEnd = session.nextRound();
    expect(mediaEnd).toBeUndefined();
    expect(session.getCurrentRound()).toBe(4);
  });

  test('should track player scores', () => {
    const session = new GameSession(123, 'guild1', 'channel1', mockPlaylist, 3);
    
    session.addPlayer('user1', 'Player 1');
    session.addPlayer('user2', 'Player 2');
    
    session.addPointToPlayer('user1');
    session.addPointToPlayer('user1');
    session.addPointToPlayer('user2');
    
    const players = session.getPlayers();
    expect(players).toHaveLength(2);
    
    const player1 = players.find(p => p.id === 'user1');
    const player2 = players.find(p => p.id === 'user2');
    
    expect(player1?.score).toBe(2);
    expect(player2?.score).toBe(1);
    
    const leaderboard = session.getLeaderboard();
    expect(leaderboard[0].id).toBe('user1');
    expect(leaderboard[1].id).toBe('user2');
  });

  test('should handle skip votes', () => {
    const session = new GameSession(123, 'guild1', 'channel1', mockPlaylist, 3);
    
    expect(session.getSkipVotes()).toBe(0);
    
    session.addSkipVote('user1');
    expect(session.getSkipVotes()).toBe(1);
    
    session.addSkipVote('user2');
    expect(session.getSkipVotes()).toBe(2);
    
    // Duplicate votes shouldn't count
    session.addSkipVote('user1');
    expect(session.getSkipVotes()).toBe(2);
    
    // Next round should clear votes
    session.nextRound();
    expect(session.getSkipVotes()).toBe(0);
  });

  test('should reset skip votes when advancing rounds', () => {
    const session = new GameSession(123, 'guild1', 'channel1', mockPlaylist, 3);
    
    // Start the first round
    session.nextRound();
    
    // Add two players
    session.addPlayer('user1', 'Player 1');
    session.addPlayer('user2', 'Player 2');
    
    // Add a skip vote
    session.addSkipVote('user1');
    expect(session.getSkipVotes()).toBe(1);
    
    // Manually reset votes
    session.resetSkipVotes();
    expect(session.getSkipVotes()).toBe(0);
    
    // Test auto-reset when advancing normally
    session.addSkipVote('user1');
    expect(session.getSkipVotes()).toBe(1);
    session.nextRound();
    expect(session.getSkipVotes()).toBe(0);
  });

  test('should init with clipMode and return correct value', () => {
    // without clipMode (default false)
    const defaultSession = new GameSession(123, 'guild1', 'channel1', mockPlaylist, 3);
    expect(defaultSession.isClipMode()).toBe(false);
    
    // with clipMode explicitly set to true
    const clipSession = new GameSession(123, 'guild1', 'channel1', mockPlaylist, 3, true);
    expect(clipSession.isClipMode()).toBe(true);
    
    // with clipMode explicitly set to false
    const noClipSession = new GameSession(123, 'guild1', 'channel1', mockPlaylist, 3, false);
    expect(noClipSession.isClipMode()).toBe(false);
  });
});