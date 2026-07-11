import { describe, expect, it } from "vitest";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, BlockKind, ParsedSession } from "../engine/types";
import { computeFoldOps, computeGroupOps } from "./plan";
import { folding } from "./folding.svelte";
import { restoreLiveUiState, snapshotLiveUiState } from "./liveSessionState";

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

class MemoryStorage implements StorageLike {
	private readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	replaceOnlyValue(value: string): void {
		const keys = [...this.values.keys()];
		if (keys.length !== 1) throw new Error(`expected exactly one stored snapshot, got ${keys.length}`);
		this.values.set(keys[0], value);
	}
}

function blk(id: string, order: number, kind: BlockKind = "text", tokens = 9_000): Block {
	return {
		id,
		kind,
		turn: order + 1,
		order,
		text: `${kind} block ${id}\n` + "x".repeat(240),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "live", cwd: "", model: "" },
		blocks: [
			blk("a:old:p0", 0),
			blk("a:group:p0", 1, "thinking"),
			blk("a:group:p1", 2),
			blk("u:tail", 3, "user", 100),
		],
		lineCount: 0,
		skipped: 0,
	};
	const store = new AccordionStore(parsed);
	store.setProtect(0);
	store.setBudget(100_000);
	return store;
}

describe("live session UI state persistence", () => {
	it("keeps snapshots isolated by session id and restores them before the first plan is computed", () => {
		const previousFolding = folding.enabled;
		try {
			const storage = new MemoryStorage();
			const sessionA = makeStore();
			sessionA.setBudget(12_000);
			sessionA.fold("a:old:p0");
			sessionA.createGroup("a:group:p0", "a:group:p1");
			snapshotLiveUiState(storage, "session-a", { foldingEnabled: true, store: sessionA });

			const sessionB = makeStore();
			sessionB.setBudget(80_000);
			snapshotLiveUiState(storage, "session-b", { foldingEnabled: false, store: sessionB });

			folding.enabled = true;
			const otherSessionAfterRefresh = makeStore();
			expect(restoreLiveUiState(storage, "session-b", { folding, store: otherSessionAfterRefresh })).toBe(true);
			expect(folding.enabled).toBe(false);
			expect(computeFoldOps(otherSessionAfterRefresh)).toEqual([]);
			expect(computeGroupOps(otherSessionAfterRefresh)).toEqual([]);

			folding.enabled = false;
			const sameSessionAfterRefresh = makeStore();
			expect(restoreLiveUiState(storage, "session-a", { folding, store: sameSessionAfterRefresh })).toBe(true);

			const firstPlan = folding.enabled
				? { ops: computeFoldOps(sameSessionAfterRefresh), groups: computeGroupOps(sameSessionAfterRefresh) }
				: { ops: [], groups: [] };
			expect(firstPlan.ops.map((op) => op.id)).toContain("a:old:p0");
			expect(firstPlan.groups.map((group) => group.id)).toEqual(["g:a:group:p0"]);
		} finally {
			folding.enabled = previousFolding;
		}
	});

	it("rejects malformed snapshot store payload without clearing existing UI state", () => {
		const previousFolding = folding.enabled;
		try {
			const sessionId = "session-malformed-store";
			const storage = new MemoryStorage();
			const seed = makeStore();
			expect(snapshotLiveUiState(storage, sessionId, { foldingEnabled: true, store: seed })).toBe(true);
			storage.replaceOnlyValue(JSON.stringify({ version: 1, sessionId, foldingEnabled: true, store: {} }));

			folding.enabled = false;
			const target = makeStore();
			target.fold("a:old:p0");
			target.createGroup("a:group:p0", "a:group:p1");
			const foldedBeforeRestore = computeFoldOps(target);
			const groupsBeforeRestore = computeGroupOps(target);

			expect(restoreLiveUiState(storage, sessionId, { folding, store: target })).toBe(false);
			expect(folding.enabled).toBe(false);
			expect(computeFoldOps(target)).toEqual(foldedBeforeRestore);
			expect(computeGroupOps(target)).toEqual(groupsBeforeRestore);
		} finally {
			folding.enabled = previousFolding;
		}
	});
});
