import sqlite3 from 'sqlite3';
import path from 'path';

export class DatabaseManager {
  private db: sqlite3.Database;
  private static instance: DatabaseManager;

  private constructor() {
    this.db = new sqlite3.Database(path.join(process.cwd(), 'data.db'));
  }

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  public async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            file_path TEXT NOT NULL,
            normalized_path TEXT,
            year INTEGER,
            metadata TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        this.db.run(`
          CREATE TABLE IF NOT EXISTS media_answers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL,
            answer TEXT NOT NULL,
            is_primary BOOLEAN DEFAULT 0,
            FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
          )
        `);

        this.db.run(`
          CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
          )
        `);

        this.db.run(`
          CREATE TABLE IF NOT EXISTS media_tags (
            media_id INTEGER,
            tag_id INTEGER,
            PRIMARY KEY (media_id, tag_id),
            FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
          )
        `);

        this.db.run(`
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            correct_answers INTEGER DEFAULT 0,
            games_played INTEGER DEFAULT 0
          )
        `);

        this.db.run(`
          CREATE TABLE IF NOT EXISTS game_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ended_at TIMESTAMP,
            rounds INTEGER NOT NULL,
            current_round INTEGER DEFAULT 1
          )
        `, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  public async addMedia(title: string, filePath: string, year?: number, metadata?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO media (title, file_path, year, metadata) VALUES (?, ?, ?, ?)',
        [title, filePath, year || null, metadata || null],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  public async getRandomMedia(tags?: string[], yearStart?: number, yearEnd?: number, limit: number = 20): Promise<any[]> {
    let query = 'SELECT m.* FROM media m';
    const params: any[] = [];
    
    if (tags && tags.length > 0) {
      query += ` 
        JOIN media_tags mt ON m.id = mt.media_id
        JOIN tags t ON mt.tag_id = t.id
        WHERE t.name IN (${tags.map(() => '?').join(',')})
      `;
      params.push(...tags);
      
      if (yearStart) {
        query += ' AND m.year >= ?';
        params.push(yearStart);
      }
      
      if (yearEnd) {
        query += ' AND m.year <= ?';
        params.push(yearEnd);
      }
      
      query += ' GROUP BY m.id HAVING COUNT(DISTINCT t.name) = ?';
      params.push(tags.length);
    } else {
      if (yearStart || yearEnd) {
        query += ' WHERE 1=1';
        
        if (yearStart) {
          query += ' AND m.year >= ?';
          params.push(yearStart);
        }
        
        if (yearEnd) {
          query += ' AND m.year <= ?';
          params.push(yearEnd);
        }
      }
    }
    
    // get exactly what we need - no filtering
    query += ' ORDER BY RANDOM() LIMIT ?';
    params.push(limit);

    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err, rows: any[]) => {
        if (err) reject(err);
        else {
          // fix type issues by ensuring each row has an id property
          const typedRows = rows.map(row => {
            return {
              id: row.id,
              ...row
            };
          });
          
          // shuffle once more for good measure
          const result = this.shuffleArray(typedRows);
          
          console.log(`media selection: ${result.length} items`);
          
          resolve(result);
        }
      });
    });
  }
  
  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  public async addTag(name: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const db = this.db; // store db reference for use in callback
      this.db.run(
        'INSERT OR IGNORE INTO tags (name) VALUES (?)',
        [name.toLowerCase()],
        function(err) {
          if (err) reject(err);
          else {
            if (this.changes === 0) {
              db.get('SELECT id FROM tags WHERE name = ?', [name.toLowerCase()], (err: Error | null, row: any) => {
                if (err) reject(err);
                else resolve(row.id);
              });
            } else {
              resolve(this.lastID);
            }
          }
        }
      );
    });
  }

  public async linkMediaTag(mediaId: number, tagId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)',
        [mediaId, tagId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  public async updateUser(userId: string, username: string, correctAnswer: boolean = false): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO users (id, username, correct_answers, games_played) 
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET 
         username = ?,
         correct_answers = correct_answers + ?,
         games_played = games_played + ?`,
        [userId, username, correctAnswer ? 1 : 0, 1, username, correctAnswer ? 1 : 0, 0],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  public async getTopUsers(limit: number = 10): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM users ORDER BY correct_answers DESC LIMIT ?',
        [limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  public async createGameSession(guildId: string, channelId: string, rounds: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO game_sessions (guild_id, channel_id, rounds) VALUES (?, ?, ?)',
        [guildId, channelId, rounds],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  public async updateGameSession(id: number, currentRound: number, ended: boolean = false): Promise<void> {
    return new Promise((resolve, reject) => {
      let query = 'UPDATE game_sessions SET current_round = ?';
      const params: any[] = [currentRound];
      
      if (ended) {
        query += ', ended_at = CURRENT_TIMESTAMP';
      }
      
      query += ' WHERE id = ?';
      params.push(id);
      
      this.db.run(query, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public async addAnswerToMedia(mediaId: number, answer: string, isPrimary: boolean = false): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO media_answers (media_id, answer, is_primary) VALUES (?, ?, ?)',
        [mediaId, answer.trim().toLowerCase(), isPrimary ? 1 : 0],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  public async addAlternativeAnswer(mediaId: number, answer: string): Promise<number> {
    return this.addAnswerToMedia(mediaId, answer, false);
  }

  public async addPrimaryAnswer(mediaId: number, answer: string): Promise<number> {
    return this.addAnswerToMedia(mediaId, answer, true);
  }

  public async getMediaAnswers(mediaId: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM media_answers WHERE media_id = ? ORDER BY is_primary DESC',
        [mediaId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  public async deleteMediaAnswer(answerId: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM media_answers WHERE id = ?',
        [answerId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        }
      );
    });
  }

  public async getMediaById(mediaId: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM media WHERE id = ?',
        [mediaId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  public async getMediaByTitle(title: string): Promise<any[]> {
    const searchPattern = `%${title}%`;
    
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM media WHERE title LIKE ? ORDER BY title LIMIT 10',
        [searchPattern],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  public async checkAnswer(mediaId: number, userAnswer: string): Promise<{correct: boolean, close: boolean}> {
    const normalizedUserAnswer = this.normalizeString(userAnswer);
    
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT answer, is_primary FROM media_answers WHERE media_id = ?',
        [mediaId],
        (err, rows: any[]) => {
          if (err) reject(err);
          else {
            // first check for exact matches
            for (const row of rows) {
              const normalizedDbAnswer = this.normalizeString(row.answer);
              
              if (normalizedUserAnswer === normalizedDbAnswer) {
                resolve({correct: true, close: false});
                return;
              }
            }
            
            // check for containment in either direction
            for (const row of rows) {
              const normalizedDbAnswer = this.normalizeString(row.answer);
              
              // user answer contains correct answer - any length is ok
              if (normalizedUserAnswer.includes(normalizedDbAnswer)) {
                resolve({correct: true, close: false});
                return;
              }
              
              // correct answer contains user answer if its meaningful enough
              // change minimum chars from 4 to 3
              // change ratio from 0.6 to 0.5 (50% of the word)
              if (normalizedUserAnswer.length >= 3 && 
                  normalizedDbAnswer.includes(normalizedUserAnswer) && 
                  normalizedUserAnswer.length >= normalizedDbAnswer.length * 0.5) {
                resolve({correct: true, close: false});
                return;
              }
              
              // special case for very short answers (2 chars) if its a full match
              // to handle cases like "ff" for "ff"
              if (normalizedUserAnswer.length === 2 &&
                  normalizedDbAnswer === normalizedUserAnswer) {
                resolve({correct: true, close: false});
                return;
              }
              
              // special case for short answers (2 chars) as abbreviations
              // if the answer starts with these chars, like "ff" for "final fantasy"
              if (normalizedUserAnswer.length === 2 &&
                  normalizedDbAnswer.length > 4 &&
                  normalizedDbAnswer.split(/\s+/).filter(word => word.startsWith(normalizedUserAnswer[0])).length > 0 &&
                  normalizedDbAnswer.split(/\s+/).filter(word => word.startsWith(normalizedUserAnswer[1])).length > 0) {
                resolve({correct: true, close: false});
                return;
              }
            }
            
            // check for fuzzy matches (levenshtein)
            for (const row of rows) {
              const normalizedDbAnswer = this.normalizeString(row.answer);
              
              if (this.isSimilar(normalizedUserAnswer, normalizedDbAnswer, 0.7)) {
                resolve({correct: false, close: true});
                return;
              }
            }
            
            resolve({correct: false, close: false});
          }
        }
      );
    });
  }
  
  private isSimilar(str1: string, str2: string, threshold: number): boolean {
    if (!str1 || !str2) return false;
    
    if (str1.includes(str2) || str2.includes(str1)) {
      return true;
    }
    
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return true;
    
    const distance = this.levenshteinDistance(str1, str2);
    const similarity = 1 - distance / maxLen;
    
    return similarity >= threshold;
  }
  
  private levenshteinDistance(str1: string, str2: string): number {
    const track = Array(str2.length + 1).fill(null).map(() => 
      Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i += 1) {
      track[0][i] = i;
    }
    
    for (let j = 0; j <= str2.length; j += 1) {
      track[j][0] = j;
    }
    
    for (let j = 1; j <= str2.length; j += 1) {
      for (let i = 1; i <= str1.length; i += 1) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        track[j][i] = Math.min(
          track[j][i - 1] + 1,
          track[j - 1][i] + 1,
          track[j - 1][i - 1] + cost,
        );
      }
    }
    
    return track[str2.length][str1.length];
  }

  private normalizeString(str: string): string {
    return str.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, '');
  }

  public close(): void {
    this.db.close();
  }

  public async updateNormalizedPath(mediaId: number, normalizedPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE media SET normalized_path = ? WHERE id = ?',
        [normalizedPath, mediaId],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }
}