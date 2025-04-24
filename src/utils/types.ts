export interface Player {
  id: string;
  username: string;
  score: number;
}

export interface CommandParams {
  types: unknown
}

interface TypeDefinition {
  types: CommandParams
}

export type { TypeDefinition }