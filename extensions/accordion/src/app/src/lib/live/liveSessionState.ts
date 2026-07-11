import type { AccordionStore, PersistedStoreState } from "../engine/store.svelte";

export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

export interface FoldingStateLike {
	enabled: boolean;
}

interface LiveUiSnapshot {
	version: 1;
	sessionId: string;
	foldingEnabled: boolean;
	store: PersistedStoreState;
}

const KEY_PREFIX = "accordion.live-ui.v1:";

function keyFor(sessionId: string): string {
	return `${KEY_PREFIX}${sessionId}`;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isPersistedStoreState(value: unknown): value is PersistedStoreState {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		isFiniteNumber(record.budget) &&
		isFiniteNumber(record.protectTokens) &&
		Array.isArray(record.blocks) &&
		Array.isArray(record.groups)
	);
}

function isSnapshot(value: unknown, sessionId: string): value is LiveUiSnapshot {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.version === 1 && record.sessionId === sessionId && typeof record.foldingEnabled === "boolean" && isPersistedStoreState(record.store);
}

export function snapshotLiveUiState(
	storage: StorageLike,
	sessionId: string | null | undefined,
	state: { foldingEnabled: boolean; store: AccordionStore | null | undefined },
): boolean {
	if (!sessionId || !state.store) return false;
	const snapshot: LiveUiSnapshot = {
		version: 1,
		sessionId,
		foldingEnabled: state.foldingEnabled,
		store: state.store.snapshotPersistedState(),
	};
	try {
		storage.setItem(keyFor(sessionId), JSON.stringify(snapshot));
		return true;
	} catch {
		return false;
	}
}

export function restoreLiveUiState(
	storage: StorageLike,
	sessionId: string | null | undefined,
	target: { folding: FoldingStateLike; store: AccordionStore | null | undefined },
): boolean {
	if (!sessionId || !target.store) return false;
	let parsed: unknown;
	try {
		const raw = storage.getItem(keyFor(sessionId));
		if (!raw) return false;
		parsed = JSON.parse(raw);
	} catch {
		return false;
	}
	if (!isSnapshot(parsed, sessionId)) return false;
	target.store.hydratePersistedState(parsed.store);
	target.folding.enabled = parsed.foldingEnabled;
	return true;
}
