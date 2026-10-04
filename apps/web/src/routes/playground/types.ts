/** Shared playground types. */

export interface PlaygroundModel {
  id: string;
  type: string;
  name: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BurnRecord {
  txHash: string;
  amount: string;
  time: string;
  wallet: string;
}
