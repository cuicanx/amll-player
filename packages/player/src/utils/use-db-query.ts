import { listen } from "@tauri-apps/api/event";
import {
	type DependencyList,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

interface DbEventPayload {
	table: string;
	action: string;
	id: number | string | Record<string, unknown>;
}

interface UseDbQueryResult<T> {
	data: T;
	loading: boolean;
	error: Error | null;
	refetch: () => void;
}

/**
 * PERF: every row of a virtualised list used to register its own Tauri
 * `db-row-changed` listener. One DB write (scan, import, play count) then
 * fanned out to N listeners and N simultaneous refetches. Keep a single
 * app-lifetime listener and dispatch to lightweight subscribers instead;
 * events landing in the same microtask are coalesced into one flush so a
 * burst of writes causes one refetch per row rather than N.
 */
type DbChangeSubscriber = (tables: string[]) => void;
const dbChangeSubscribers = new Set<DbChangeSubscriber>();
const pendingDbTables = new Set<string>();
let dbChangeListenerStarted = false;
let dbChangeFlushScheduled = false;

function ensureDbChangeListener() {
	if (dbChangeListenerStarted) return;
	dbChangeListenerStarted = true;
	listen<DbEventPayload>("db-row-changed", (event) => {
		pendingDbTables.add(event.payload.table);
		if (dbChangeFlushScheduled) return;
		dbChangeFlushScheduled = true;
		queueMicrotask(() => {
			dbChangeFlushScheduled = false;
			const tables = [...pendingDbTables];
			pendingDbTables.clear();
			for (const subscriber of dbChangeSubscribers) subscriber(tables);
		});
	}).catch((err) => {
		// Allow a later mount to retry if the initial registration failed.
		dbChangeListenerStarted = false;
		console.error("db-row-changed 监听注册失败:", err);
	});
}

export function useDbQuery<T>(
	queryFn: () => Promise<T>,
	deps: DependencyList,
	defaultValue: T,
	watchTables?: string[],
): UseDbQueryResult<T> {
	const [data, setData] = useState<T>(defaultValue);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const queryFnRef = useRef(queryFn);
	const fetchIdRef = useRef(0);
	const watchTablesRef = useRef(watchTables);

	queryFnRef.current = queryFn;
	watchTablesRef.current = watchTables;

	const fetchData = useCallback(() => {
		const currentFetchId = ++fetchIdRef.current;
		setLoading(true);
		setError(null);

		queryFnRef
			.current()
			.then((result) => {
				if (fetchIdRef.current === currentFetchId) {
					setData(result);
					setLoading(false);
				}
			})
			.catch((err) => {
				if (fetchIdRef.current === currentFetchId) {
					setError(err instanceof Error ? err : new Error(String(err)));
					setLoading(false);
				}
			});
	}, deps);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	useEffect(() => {
		if (!watchTablesRef.current?.length) return;

		const onDbChange: DbChangeSubscriber = (tables) => {
			const watched = watchTablesRef.current;
			if (watched?.some((table) => tables.includes(table))) {
				fetchData();
			}
		};

		dbChangeSubscribers.add(onDbChange);
		ensureDbChangeListener();
		return () => {
			dbChangeSubscribers.delete(onDbChange);
		};
	}, [fetchData]);

	return { data, loading, error, refetch: fetchData };
}
