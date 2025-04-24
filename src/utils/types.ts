export interface Player {
  id: string;
  username: string;
  score: number;
}

interface TypeDefinition {
  types: CommandParams
}

export type { TypeDefinition }