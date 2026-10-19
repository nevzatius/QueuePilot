import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { ApiError } from '../api/client';
import { useSession } from '../auth/SessionContext';

export interface ResourceState<T> {
  data: T | null;
  error: ApiError | null;
  /** True until the first response (data or error) arrives. */
  loading: boolean;
  reload: () => void;
}

interface Options<T> {
  /** Poll interval in ms. Polling pauses while the tab is hidden and when `shouldPoll` is false. */
  intervalMs?: number;
  shouldPoll?: (data: T) => boolean;
}

/** Loads data, optionally polling. Keeps the last good data visible while a refresh fails. */
export function useResource<T>(load: () => Promise<T>, deps: DependencyList, options: Options<T> = {}): ResourceState<T> {
  const { handleApiError } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      let next: T | null = null;
      try {
        next = await loadRef.current();
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        handleApiError(e);
        setError(e instanceof ApiError ? e : new ApiError('unexpected', null, null, 'Unexpected error'));
      }
      setLoading(false);
      const { intervalMs, shouldPoll } = optionsRef.current;
      if (intervalMs && !cancelled && (next === null || !shouldPoll || shouldPoll(next))) {
        timer = setTimeout(tick, intervalMs);
      }
    };
    // Skip the fetch while hidden but keep the timer alive, so the view refreshes on return.
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, optionsRef.current.intervalMs);
      } else {
        void run();
      }
    };

    setLoading(true);
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [...deps, nonce, handleApiError]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
