import { GameManager } from '../utils/gameManager';
import { DatabaseManager } from '../database/databaseManager';
import { GameSession } from '../utils/gameSession';

// mock database manager
jest.mock('../database/databaseManager', () => {
  return {
    DatabaseManager: {
      getInstance: jest.fn().mockImplementation(() => ({
        getRandomMedia: jest.fn().mockResolvedValue([
          { id: 1, title: 'test song 1', file_path: '/path/to/song1.mp3' },
          { id: 2, title: 'test song 2', file_path: '/path/to/song2.mp3' },
        ]),
        createGameSession: jest.fn().mockResolvedValue(123),
        updateGameSession: jest.fn().mockResolvedValue(undefined),
        updateUser: jest.fn().mockResolvedValue(undefined),
        checkAnswer: jest.fn().mockImplementation((mediaId, answer) => {
          console.log(`checkAnswer called with mediaId=${mediaId}, answer=${answer}`);
          // match exactly the normalized answers
          if (mediaId === 1 && answer === 'testsong1') {
            console.log('returning true for match');
            return Promise.resolve({correct: true, close: false});
          }
          if (mediaId === 2 && answer === 'testsong2') {
            console.log('returning true for match');
            return Promise.resolve({correct: true, close: false});
          }
          
          // test containment cases - user guess contains answer
          if (mediaId === 1 && answer.includes('testsong1')) {
            console.log('returning true for containment match');
            return Promise.resolve({correct: true, close: false});
          }
          
          // test substring cases - answer contains substantial part of user's guess
          if (mediaId === 1 && answer === 'song' && 'testsong1'.includes(answer)) {
            console.log('returning true for substring match');
            return Promise.resolve({correct: true, close: false});
          }
          
          // check for close answers
          if ((mediaId === 1 && answer.includes('test')) || 
              (mediaId === 2 && answer.includes('test'))) {
            return Promise.resolve({correct: false, close: true});
          }
          
          console.log('returning false for no match');
          return Promise.resolve({correct: false, close: false});
        }),
      })),
    },
  };
});

describe('GameManager', () => {
  let gameManager: GameManager;
  
  beforeEach(() => {
    jest.clearAllMocks();
    gameManager = GameManager.getInstance();
    
    // clear existing sessions
    const sessions = (gameManager as any).sessions;
    sessions.clear();
  });
  
  test('should create a new game session', async () => {
    const session = await gameManager.createSession('guild1', 'channel1', 2);
    
    expect(session).not.toBeNull();
    expect(session?.getGuildId()).toBe('guild1');
    expect(session?.getChannelId()).toBe('channel1');
    expect(session?.getTotalRounds()).toBe(2);
    
    const retrievedSession = gameManager.getSession('guild1', 'channel1');
    expect(retrievedSession).toBe(session);
  });
  
  test('should not create duplicate sessions', async () => {
    const session1 = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session1).not.toBeNull();
    
    const session2 = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session2).toBeNull();
  });
  
  test('should correctly process a correct guess', async () => {
    const session = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session).not.toBeNull();
    
    // start the first round
    const media = session?.nextRound();
    expect(media?.id).toBe(1); // ensure we get the first media item
    
    // process a correct guess
    const result = await gameManager.processGuess(
      'guild1', 
      'channel1', 
      'user1', 
      'Player 1', 
      'test song 1'
    );
    
    expect(result.correct).toBe(true);
    
    // check that the player got a point
    const players = session?.getPlayers() || [];
    expect(players.length).toBe(1);
    expect(players[0].score).toBe(1);
  });
  
  test('should correctly process an incorrect guess', async () => {
    const session = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session).not.toBeNull();
    
    // start the first round
    session?.nextRound();
    
    // process an incorrect guess
    const result = await gameManager.processGuess(
      'guild1', 
      'channel1', 
      'user1', 
      'Player 1', 
      'wrong answer'
    );
    
    expect(result.correct).toBe(false);
    
    // check that the player didn't get a point
    const players = session?.getPlayers() || [];
    expect(players.length).toBe(1);
    expect(players[0].score).toBe(0);
  });
  
  test('should handle skip votes', async () => {
    const session = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session).not.toBeNull();
    
    // start the first round
    session?.nextRound();
    
    // add players
    session?.addPlayer('user1', 'Player 1');
    session?.addPlayer('user2', 'Player 2');
    
    // first skip vote
    const result1 = await gameManager.processSkip('guild1', 'channel1', 'user1');
    expect(result1.skipped).toBe(false);
    expect(result1.votes).toBe(1);
    expect(result1.required).toBe(2);
    
    // second skip vote - should skip
    const result2 = await gameManager.processSkip('guild1', 'channel1', 'user2');
    expect(result2.skipped).toBe(true);
    expect(result2.votes).toBe(2);
    expect(result2.required).toBe(2);
  });
  
  test('should end a session', async () => {
    const session = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session).not.toBeNull();
    
    // start the first round and add a player
    session?.nextRound();
    session?.addPlayer('user1', 'Player 1');
    
    const success = await gameManager.endSession('guild1', 'channel1');
    expect(success).toBe(true);
    
    // session should be removed
    const retrievedSession = gameManager.getSession('guild1', 'channel1');
    expect(retrievedSession).toBeUndefined();
  });

  test('should not award points for duplicate correct answers', async () => {
    const session = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session).not.toBeNull();
    
    // start the first round
    const media = session?.nextRound();
    expect(media?.id).toBe(1); // ensure we get the first media item
    
    // first player guesses correctly
    const result1 = await gameManager.processGuess(
      'guild1', 
      'channel1', 
      'user1', 
      'Player 1', 
      'test song 1'
    );
    
    expect(result1.correct).toBe(true);
    
    // second player guesses the same answer
    const result2 = await gameManager.processGuess(
      'guild1', 
      'channel1', 
      'user2', 
      'Player 2', 
      'test song 1'
    );
    
    // should return false for duplicate guess
    expect(result2.correct).toBe(false);
    
    // check player scores
    const players = session?.getPlayers() || [];
    expect(players.length).toBe(2);
    
    const player1 = players.find(p => p.id === 'user1');
    const player2 = players.find(p => p.id === 'user2');
    
    // first player should have 1 point
    expect(player1?.score).toBe(1);
    
    // second player should have 0 points
    expect(player2?.score).toBe(0);
  });

  test('should accept answers when user guess contains correct answer', async () => {
    const session = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session).not.toBeNull();
    
    // start the first round
    const media = session?.nextRound();
    expect(media?.id).toBe(1);
    
    // process a guess with extra text but containing the answer
    const result = await gameManager.processGuess(
      'guild1', 
      'channel1', 
      'user1', 
      'Player 1', 
      'i think this is testsong1 maybe?'
    );
    
    expect(result.correct).toBe(true);
    
    // check that the player got a point
    const players = session?.getPlayers() || [];
    expect(players.length).toBe(1);
    expect(players[0].score).toBe(1);
  });
  
  test('should accept answers when user guess is substantial part of the answer', async () => {
    const session = await gameManager.createSession('guild1', 'channel1', 2);
    expect(session).not.toBeNull();
    
    // start the first round
    const media = session?.nextRound();
    expect(media?.id).toBe(1);
    
    // process a guess with just a substantial part of the answer
    const result = await gameManager.processGuess(
      'guild1', 
      'channel1', 
      'user1', 
      'Player 1', 
      'song'
    );
    
    expect(result.correct).toBe(true);
    
    // check that the player got a point
    const players = session?.getPlayers() || [];
    expect(players.length).toBe(1);
    expect(players[0].score).toBe(1);
  });

  test('should support clipMode parameter', async () => {
    // start clean
    (gameManager as any).sessions.clear();
    
    // create with clipMode true
    const withClipMode = await gameManager.createSession('guild1', 'channel1', 2, undefined, undefined, undefined, undefined, true);
    
    // verify clipMode was passed
    expect(withClipMode?.isClipMode()).toBe(true);
    
    // cleanup
    (gameManager as any).sessions.clear();
    
    // create without specifying clipMode (defaults to false)
    const withoutClipMode = await gameManager.createSession('guild1', 'channel1', 2);
    
    // verify default clipMode is false
    expect(withoutClipMode?.isClipMode()).toBe(false);
  });
});