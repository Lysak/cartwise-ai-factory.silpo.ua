import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string } };
  }
}

type BootstrapResponse =
  | { status: 'authenticated'; csrfToken: string; silpoStatus: 'active' | 'reauth_required' | 'missing' }
  | { status: 'oauth_required'; authorizationUrl: string };

type AuthenticatedState = {
  csrfToken: string;
  silpoStatus: 'active' | 'reauth_required' | 'missing';
};

type AppState = 'checking' | 'session-checking' | 'outside-telegram' | 'error' | 'authenticated' | 'discovery-complete' | 'discovery-failed' | 'identity-probe-complete' | 'identity-probe-failed';

function isBootstrapResponse(value: unknown): value is BootstrapResponse {
  if (typeof value !== 'object' || value === null) return false;

  const response = value as Record<string, unknown>;
  if (response.status === 'oauth_required') return typeof response.authorizationUrl === 'string';

  return response.status === 'authenticated'
    && typeof response.csrfToken === 'string'
    && (response.silpoStatus === 'active' || response.silpoStatus === 'reauth_required' || response.silpoStatus === 'missing');
}

function isAuthorizationResponse(value: unknown): value is { authorizationUrl: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).authorizationUrl === 'string';
}

export default function App() {
  const isCleanRoot = window.location.pathname === '/' && window.location.search === '' && window.location.hash === '';
  const [state, setState] = useState<AppState>(() => {
    const silpo = new URLSearchParams(window.location.search).get('silpo');
    if (silpo === 'connected') return 'session-checking';
    if (silpo === 'failed') return 'error';
    const identityProbe = new URLSearchParams(window.location.search).get('silpo_identity_probe');
    if (identityProbe === 'complete') return 'identity-probe-complete';
    if (identityProbe === 'failed') return 'identity-probe-failed';
    const discovery = new URLSearchParams(window.location.search).get('silpo_discovery');
    if (discovery === 'complete') return 'discovery-complete';
    if (discovery === 'failed') return 'discovery-failed';
    return window.Telegram?.WebApp?.initData ? 'checking' : isCleanRoot ? 'session-checking' : 'outside-telegram';
  });
  const [authenticated, setAuthenticated] = useState<AuthenticatedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    if (state === 'session-checking') {
      void fetch('/api/auth/session', { credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) {
            if (isCleanRoot && response.status === 401) {
              setState('outside-telegram');
              return;
            }
            throw new Error('Session lookup failed');
          }
          const data: unknown = await response.json();
          if (!isBootstrapResponse(data) || data.status !== 'authenticated') throw new Error('Invalid session response');
          setAuthenticated({ csrfToken: data.csrfToken, silpoStatus: data.silpoStatus });
          setState('authenticated');
        })
        .catch(() => setState('error'));
      return;
    }
    if (state !== 'checking') return;

    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) return;

    void fetch('/api/auth/telegram/bootstrap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'text/plain' },
      body: initData,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Bootstrap failed');

        const data: unknown = await response.json();
        if (!isBootstrapResponse(data)) {
          setState('error');
          return;
        }

        if (data.status === 'oauth_required') window.location.assign(data.authorizationUrl);
        else {
          setAuthenticated({ csrfToken: data.csrfToken, silpoStatus: data.silpoStatus });
          setState('authenticated');
        }
      })
      .catch(() => setState('error'));
  }, [isCleanRoot, state]);

  const connect = async () => {
    if (busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/auth/silpo/connect/start', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || !isAuthorizationResponse(data)) {
        setActionError(true);
        return;
      }

      window.location.assign(data.authorizationUrl);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const reauthorize = async () => {
    if (!authenticated || busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/auth/silpo/reauthorize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': authenticated.csrfToken },
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || !isAuthorizationResponse(data)) {
        setActionError(true);
        return;
      }

      window.location.assign(data.authorizationUrl);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const identityProbe = async () => {
    if (busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/auth/silpo/identity-probe/start', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || !isAuthorizationResponse(data)) {
        setActionError(true);
        return;
      }

      window.location.assign(data.authorizationUrl);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (!authenticated || busy) return;

    setBusy(true);
    setActionError(false);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': authenticated.csrfToken },
      });
      const data: unknown = response.ok ? await response.json() : null;
      if (!response.ok || typeof data !== 'object' || data === null || (data as Record<string, unknown>).status !== 'logged_out') {
        setActionError(true);
        return;
      }

      setAuthenticated(null);
      setState('outside-telegram');
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Cartwise</h1>
      {state === 'outside-telegram' && (
        <>
          <button type="button" onClick={() => void connect()} disabled={busy}>
            Підключити Сільпо
          </button>
          {actionError && <p>Не вдалося виконати дію. Спробуйте ще раз.</p>}
        </>
      )}
      {state === 'discovery-complete' && (
        <>
          <p>MCP-каталог отримано. Наступний крок — перевірка Silpo identity.</p>
          <button type="button" onClick={() => void identityProbe()} disabled={busy}>
            Перевірити Silpo identity
          </button>
          {actionError && <p>Не вдалося виконати дію. Спробуйте ще раз.</p>}
        </>
      )}
      {state === 'discovery-failed' && <p>Не вдалося отримати MCP-каталог. Спробуйте ще раз.</p>}
      {state === 'identity-probe-complete' && <p>Identity evidence отримано. Наступний крок — вибір stable subject field.</p>}
      {state === 'identity-probe-failed' && <p>Не вдалося перевірити Silpo identity. Спробуйте ще раз.</p>}
      {state === 'error' && <p>Не вдалося відкрити Cartwise. Спробуйте ще раз.</p>}
      {state === 'authenticated' && authenticated && (
        <>
          {authenticated.silpoStatus === 'active'
            ? <p>Сільпо підключено</p>
            : <p>Потрібно перепідключити Сільпо</p>}
          {authenticated.silpoStatus !== 'active' && (
            <button type="button" onClick={() => void reauthorize()} disabled={busy}>
              Перепідключити
            </button>
          )}
          <button type="button" onClick={() => void logout()} disabled={busy}>
            Вийти
          </button>
          {actionError && <p>Не вдалося виконати дію. Спробуйте ще раз.</p>}
        </>
      )}
    </main>
  );
}
