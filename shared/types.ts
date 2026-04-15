// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  hostname: string;
  cwd: string;
  git_root: string | null;
  group_id: string;
  instance_token: string;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  status: "active" | "dormant";
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API request/response types ---

export interface RegisterRequest {
  api_key: string;
  group_secret: string;
  pid: number;
  hostname: string;
  cwd: string;
  git_root: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  instance_token: string;
}

export interface SetSummaryRequest {
  summary: string;
}

export interface ListPeersRequest {
  scope: "group" | "directory" | "repo";
  cwd: string;
  hostname: string;
  git_root: string | null;
}

export interface SendMessageRequest {
  to_id: PeerId;
  text: string;
}

export interface UnregisterRequest {
  // no body needed — peer ID derived from token
}

export interface ResumeRequest {
  instance_token: string;
}

export interface ResumeResponse {
  id: PeerId;
  instance_token: string;
}

export interface SetIdRequest {
  new_id: string;
}

export interface SetIdResponse {
  id: PeerId;
}

// Peer without sensitive fields — safe to return in list-peers
export type PublicPeer = Omit<Peer, "instance_token">;

// --- WebSocket message types (broker → instance) ---

export interface WsPushMessage {
  type: "message";
  from_id: PeerId;
  from_summary: string;
  from_cwd: string;
  from_hostname: string;
  text: string;
  sent_at: string;
}
