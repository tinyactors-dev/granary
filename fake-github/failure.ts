/** A result an actor returns for a request it cannot satisfy (unknown bucket, revoked key, …). */
export interface ActorFailure {
	error: string;
	status: number;
}

export const isFailure = (v: unknown): v is ActorFailure =>
	typeof v === 'object' && v !== null && 'error' in v && 'status' in v;
