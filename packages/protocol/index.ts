export interface ChatRef { agentId: string; sessionId: string }
export interface Bot { id: string; name: string; chat?: ChatRef; kind?: 'group' }
export interface Profile { id: string; name: string; email?: string; bots: Bot[]; botNames?: string[] }
export type AccountProfile = Omit<Profile, 'bots'> & { bots?: Bot[] }
export interface Message { id: string; role: 'you' | 'bot'; text: string; at: number }
export interface Transcript { messages: Message[]; cursor: string; busy: boolean; reset?: boolean }
export interface ReadTarget { bot: Bot; cursor: string }
export type ReadResult = { id: string } & ({ transcript: Transcript } | { error: string })
