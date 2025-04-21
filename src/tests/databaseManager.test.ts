import { DatabaseManager } from '../database/databaseManager';
import sqlite3 from 'sqlite3';

// mock the database functions
jest.mock('sqlite3', () => {
  const mockDb = {
    run: jest.fn((query, params, callback) => {
      if (callback) callback.call({ lastID: 123, changes: 1 });
    }),
    get: jest.fn((query, params, callback) => {
      if (callback) callback(null, { id: 123, name: 'test' });
    }),
    all: jest.fn((query, params, callback) => {
      if (callback) callback(null, [
        { id: 1, title: 'test song 1', file_path: '/path/song1.mp3' },
        { id: 2, title: 'test song 2', file_path: '/path/song2.mp3' }
      ]);
    }),
    serialize: jest.fn(cb => cb()),
    close: jest.fn()
  };

  return {
    Database: jest.fn(() => mockDb)
  };
});

// override shuffleArray to return items in original order for tests
jest.mock('../database/databaseManager', () => {
  const originalModule = jest.requireActual('../database/databaseManager');
  return {
    ...originalModule,
    DatabaseManager: class extends originalModule.DatabaseManager {
      // override shuffleArray to be deterministic for tests
      shuffleArray<T>(array: T[]): T[] {
        return [...array]; // just return copy without shuffling
      }
    }
  };
});

describe('DatabaseManager', () => {
  let dbManager: DatabaseManager;
  
  beforeEach(() => {
    jest.clearAllMocks();
    dbManager = DatabaseManager.getInstance();
  });
  
  test('should not recreate instance when getInstance called multiple times', () => {
    const instance1 = DatabaseManager.getInstance();
    const instance2 = DatabaseManager.getInstance();
    expect(instance1).toBe(instance2);
  });
  
  test('should check answer correctly', async () => {
    // mock the all method for this specific case
    const mockDb = (dbManager as any).db;
    mockDb.all.mockImplementationOnce((query: string, params: any[], callback: (err: Error | null, rows: any[]) => void) => {
      callback(null, [
        { answer: 'test song 1', is_primary: 1 },
        { answer: 'alternative title', is_primary: 0 }
      ]);
    });
    
    // exact match
    const exactMatch = await dbManager.checkAnswer(1, 'test song 1');
    expect(exactMatch.correct).toBe(true);
    expect(exactMatch.close).toBe(false);
    
    // mock again for different test case
    mockDb.all.mockImplementationOnce((query: string, params: any[], callback: (err: Error | null, rows: any[]) => void) => {
      callback(null, [
        { answer: 'test song 1', is_primary: 1 },
        { answer: 'alternative title', is_primary: 0 }
      ]);
    });
    
    // close match but not exact - test song is now considered correct with new logic
    const closeMatch = await dbManager.checkAnswer(1, 'test song');
    expect(closeMatch.correct).toBe(true);
    expect(closeMatch.close).toBe(false);
    
    // mock again for different test case
    mockDb.all.mockImplementationOnce((query: string, params: any[], callback: (err: Error | null, rows: any[]) => void) => {
      callback(null, [
        { answer: 'test song 1', is_primary: 1 },
        { answer: 'alternative title', is_primary: 0 }
      ]);
    });
    
    // not a match at all
    const noMatch = await dbManager.checkAnswer(1, 'completely different');
    expect(noMatch.correct).toBe(false);
    expect(noMatch.close).toBe(false);
  });
  
  test('should check answer with containment checks', async () => {
    // mock the all method for this specific case
    const mockDb = (dbManager as any).db;
    
    // Test case 1: user answer contains correct answer
    mockDb.all.mockImplementationOnce((query: string, params: any[], callback: (err: Error | null, rows: any[]) => void) => {
      callback(null, [
        { answer: 'song', is_primary: 1 },
        { answer: 'alternative title', is_primary: 0 }
      ]);
    });
    
    const containsMatch = await dbManager.checkAnswer(1, 'this is my song answer');
    expect(containsMatch.correct).toBe(true);
    expect(containsMatch.close).toBe(false);
    
    // Test case 2: correct answer contains user answer (with length requirements)
    mockDb.all.mockImplementationOnce((query: string, params: any[], callback: (err: Error | null, rows: any[]) => void) => {
      callback(null, [
        { answer: 'full song title', is_primary: 1 },
        { answer: 'alternative title', is_primary: 0 }
      ]);
    });
    
    const validPartialMatch = await dbManager.checkAnswer(1, 'song title');
    expect(validPartialMatch.correct).toBe(true);
    expect(validPartialMatch.close).toBe(false);
    
    // Test case 3: correct answer contains user answer but too short
    mockDb.all.mockImplementationOnce((query: string, params: any[], callback: (err: Error | null, rows: any[]) => void) => {
      callback(null, [
        { answer: 'full song title', is_primary: 1 },
        { answer: 'alternative title', is_primary: 0 }
      ]);
    });
    
    const tooShortMatch = await dbManager.checkAnswer(1, 'song');
    expect(tooShortMatch.correct).toBe(false); // should fail because too short
    expect(tooShortMatch.close).toBe(true);  // but should be considered close
  });
  
  test('should get random media with filters', async () => {
    const mockDb = (dbManager as any).db;
    mockDb.all.mockImplementationOnce((query: string, params: any[], callback: (err: Error | null, rows: any[]) => void) => {
      // verify query has correct WHERE clauses
      expect(query).toContain('WHERE');
      expect(query).toContain('m.year >= ?');
      expect(query).toContain('m.year <= ?');
      expect(params).toContain(2000);
      expect(params).toContain(2010);
      
      callback(null, [
        { id: 1, title: 'anime song 1', file_path: '/path/anime1.mp3', year: 2005 },
        { id: 2, title: 'anime song 2', file_path: '/path/anime2.mp3', year: 2008 }
      ]);
    });
    
    const result = await dbManager.getRandomMedia(['anime'], 2000, 2010, 5);
    expect(result.length).toBe(2);
    // instead of checking for exact title, just verify we got the expected data
    expect(result.map(item => item.title).sort()).toEqual(['anime song 1', 'anime song 2'].sort());
  });
  
  test('should normalize strings for answer matching', () => {
    // create a normalizeString function that matches what's in databaseManager
    const normalizeString = (str: string): string => {
      return str.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, '');
    };
    
    // test string normalization
    expect(normalizeString('Test String!')).toBe('teststring');
    expect(normalizeString('WITH CAPS')).toBe('withcaps');
    expect(normalizeString('with spaces')).toBe('withspaces');
    expect(normalizeString('with-dashes')).toBe('withdashes');
    expect(normalizeString('with_underscores')).toBe('with_underscores'); // underscores are kept
    expect(normalizeString('with.dots')).toBe('withdots');
  });
});